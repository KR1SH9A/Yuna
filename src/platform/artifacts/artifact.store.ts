/** Capture bounded media and fence every disclosure with current owner authorization; remote I/O never holds a database transaction. */
import { createHash, randomUUID } from 'node:crypto';
import { LockMode } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { assertDate, assertDiscordId, assertUuid, invariant } from '../db/entity-values.js';
import { ArtifactRecord } from './entities/artifact-record.entity.js';
import type { ArtifactAuthority, ArtifactBinding, ArtifactDeletionOutcome, ArtifactMetadata, ArtifactScope, ArtifactStorage,
  ArtifactStoreOptions, DeleteArtifactsInput, OpenArtifactInput, StoreArtifactInput } from './contracts.js';

/** One instance owns one immutable installation/guild/feature/retention scope. References cannot select paths or URLs. */
export class ArtifactStore {
  private readonly scope: Readonly<ArtifactScope>;
  private readonly options: Readonly<ArtifactStoreOptions>;
  private readonly clock: () => Date;
  private readonly retryDelayMs: number;
  private readonly ioTimeoutMs: number;
  private cleanupAfter: string | null = null;

  /** Require an explicit storage backend, byte verifier and current owner authority; nothing enables media ingestion implicitly. */
  constructor(private readonly orm: MikroORM, scope: ArtifactScope, private readonly storage: ArtifactStorage,
    private readonly authority: ArtifactAuthority, options: ArtifactStoreOptions) {
    assertUuid(scope.installationId); assertDiscordId(scope.guildId);
    invariant(/^[a-z][a-z0-9_.:-]{0,127}$/.test(scope.owner) && /^[a-z][a-z0-9_.:-]{0,127}$/.test(scope.retentionScope), 'Invalid artifact owner scope');
    invariant(Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 && options.maxBytes <= 64 * 1024 * 1024, 'Invalid artifact process byte bound');
    invariant(options.allowedMediaTypes.length > 0 && options.allowedMediaTypes.length <= 64
      && options.allowedMediaTypes.every(type => /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)), 'Invalid artifact media types');
    this.ioTimeoutMs = options.ioTimeoutMs ?? 30_000;
    invariant(Number.isSafeInteger(this.ioTimeoutMs) && this.ioTimeoutMs >= 1 && this.ioTimeoutMs <= 120_000, 'Invalid artifact I/O timeout');
    this.retryDelayMs = options.retryDelayMs ?? 60_000;
    invariant(Number.isSafeInteger(this.retryDelayMs) && this.retryDelayMs >= 1 && this.retryDelayMs <= 86_400_000, 'Invalid artifact retry delay');
    this.scope = Object.freeze({ ...scope });
    this.options = Object.freeze({ ...options, allowedMediaTypes: Object.freeze([...options.allowedMediaTypes]) });
    this.clock = options.clock ?? (() => new Date());
  }

  /** Persist cleanup ownership first, capture/hash/type-check bounded bytes, then upload and conditionally publish in a new transaction. */
  async storeBounded(input: StoreArtifactInput): Promise<ArtifactMetadata> {
    this.assertOutsideTransaction(); this.validateBinding(input.binding);
    const now = this.clock(); assertDate(now, 'artifact time');
    invariant(Number.isSafeInteger(input.maxBytes) && input.maxBytes > 0 && input.maxBytes <= this.options.maxBytes, 'Invalid artifact byte bound');
    invariant(this.options.allowedMediaTypes.includes(input.mediaType), 'Artifact media type is not allowed');
    invariant(input.expectedBytes === undefined || (Number.isSafeInteger(input.expectedBytes) && input.expectedBytes >= 0 && input.expectedBytes <= input.maxBytes), 'Invalid expected artifact size');
    invariant(input.expectedSha256 === undefined || /^[a-f0-9]{64}$/.test(input.expectedSha256), 'Invalid expected artifact hash');
    const record = new ArtifactRecord({ ...this.scope, ownerRecordRef: input.ownerRecordRef, createdAt: now,
      storageKey: randomUUID(), accessBinding: { ...input.binding }, uploadDeadline: input.uploadDeadline, expiresAt: input.expiresAt,
      sourceAttachmentId: input.sourceAttachmentId, sourceMessageId: input.sourceMessageId, sourceChannelId: input.sourceChannelId,
      originalMetadata: input.originalMetadata });
    invariant(record.originalMetadata === null || Buffer.byteLength(JSON.stringify(record.originalMetadata), 'utf8') <= 16_384, 'Artifact metadata is too large');
    // Snapshot caller-owned scalars before the first await; later mutations cannot widen what was admitted.
    const maxBytes = input.maxBytes, expectedBytes = input.expectedBytes, expectedHash = input.expectedSha256, mediaType = input.mediaType, content = input.content;
    await this.orm.em.fork().transactional(async em => {
      invariant(await this.authority(em, { operation: 'store', artifact: record }, now), 'Artifact store denied');
      em.persist(record);
    });
    try {
      const bytes = await this.collectBounded(content, maxBytes, record.uploadDeadline);
      const hash = createHash('sha256').update(bytes).digest('hex');
      invariant(expectedBytes === undefined || bytes.byteLength === expectedBytes, 'Artifact size mismatch');
      invariant(expectedHash === undefined || hash === expectedHash, 'Artifact hash mismatch');
      invariant(this.options.verifyMediaType(bytes) === mediaType, 'Artifact media type mismatch');
      const claimedRevision = await this.orm.em.fork().transactional(async em => {
        invariant(await this.authority(em, { operation: 'store', artifact: record }, this.clock()), 'Artifact store denied');
        const current = await em.findOneOrFail(ArtifactRecord, { ...this.scope, id: record.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        current.claimUpload(this.clock(), current.rowRevision);
        return current.rowRevision;
      });
      // The committed owner-approved claim is the upload disclosure boundary. Later withdrawal fences publication/reads,
      // but cannot recall bytes from an already claimed in-flight upload; cleanup retains their exact object key.
      await this.remote(signal => this.storage.put(record.storageKey, bytes,
        { mediaType, sha256: hash, writeNotAfter: new Date(record.uploadDeadline), signal }), record.uploadDeadline);
      return await this.orm.em.fork().transactional(async em => {
        invariant(await this.authority(em, { operation: 'store', artifact: record }, this.clock()), 'Artifact store denied');
        const current = await em.findOneOrFail(ArtifactRecord, { ...this.scope, id: record.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        current.finalizeUpload(hash, mediaType, bytes.byteLength, this.clock(), claimedRevision);
        return this.metadata(current);
      });
    } catch (error) {
      // A failed/unknown upload may already exist remotely. Keep the durable key unavailable and owned by cleanup.
      await this.orm.em.fork().transactional(async em => {
        const current = await em.findOneOrFail(ArtifactRecord, { ...this.scope, id: record.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        current.beginDeletion(this.clock(), current.rowRevision);
      });
      throw error;
    }
  }

  /** Buffer only bounded verified bytes; recheck the exact owner release after I/O before any bytes leave this adapter. */
  async openAuthorized(input: OpenArtifactInput): Promise<ArtifactMetadata & { bytes: Uint8Array }> {
    this.assertOutsideTransaction(); assertUuid(input.artifactId); this.validateBinding(input.binding); assertDate(input.notAfter, 'artifact access deadline');
    invariant(input.release.kind === 'owner' || input.release.kind === 'job', 'Invalid artifact release');
    if (input.release.kind === 'job') { assertUuid(input.release.taskId); assertUuid(input.release.inputReleaseId); }
    const access: OpenArtifactInput = { ...input, binding: { ...input.binding }, notAfter: new Date(input.notAfter), release: { ...input.release } };
    const before = await this.authorizedRecord(access);
    const deadline = new Date(Math.min(access.notAfter.getTime(), before.expiresAt.getTime(), this.clock().getTime() + this.ioTimeoutMs));
    const readTimeout = deadline.getTime() - this.clock().getTime();
    invariant(readTimeout > 0, 'Artifact storage deadline elapsed');
    const readSignal = AbortSignal.timeout(readTimeout);
    const stream = await this.remote(signal => this.storage.open(before.storageKey,
      { maxBytes: before.byteSize!, notAfter: deadline, signal: AbortSignal.any([signal, readSignal]) }), deadline);
    const bytes = await this.collectBounded(stream, before.byteSize!, deadline);
    invariant(bytes.byteLength === before.byteSize && createHash('sha256').update(bytes).digest('hex') === before.verifiedHash
      && this.options.verifyMediaType(bytes) === before.mediaType, 'Stored artifact verification failed');
    const after = await this.authorizedRecord(access);
    invariant(after.rowRevision === before.rowRevision && after.storageKey === before.storageKey, 'Artifact changed during read');
    return { ...this.metadata(after), bytes };
  }

  /** Select a bounded owner-approved page, commit unavailability, erase outside transactions and preserve retries until the upload horizon. */
  async deleteExpired(input: DeleteArtifactsInput = {}): Promise<ArtifactDeletionOutcome[]> {
    this.assertOutsideTransaction();
    const limit = input.limit ?? 50;
    invariant(Number.isInteger(limit) && limit > 0 && limit <= 100, 'Invalid artifact cleanup bound');
    const revoked = input.revokedArtifactIds ? [...new Set(input.revokedArtifactIds)] : undefined;
    invariant(!revoked || (revoked.length > 0 && revoked.length <= limit), 'Invalid artifact revocation bound');
    revoked?.forEach(assertUuid);
    const now = this.clock();
    const candidates = await this.orm.em.fork().find(ArtifactRecord, { ...this.scope, ...(revoked ? { id: { $in: revoked }, state: { $ne: 'DELETED' as const } } : {
      ...(this.cleanupAfter ? { id: { $gt: this.cleanupAfter } } : {}),
      $or: [{ state: 'PENDING' as const, uploadDeadline: { $lte: now } }, { state: 'READY' as const, expiresAt: { $lte: now } },
        { state: 'DELETING' as const, nextAttemptAt: { $lte: now } }],
    }) }, { limit, orderBy: { id: 'asc' } });
    // Rotate even past denied rows: a permanently unavailable owner must not starve the remaining expiry page.
    if (!revoked) this.cleanupAfter = candidates.length === limit ? candidates.at(-1)!.id : null;
    const outcomes: ArtifactDeletionOutcome[] = [];
    for (const candidate of candidates) {
      const selected = await this.orm.em.fork().transactional(async em => {
        const at = this.clock();
        if (candidate.state !== 'DELETING' && !await this.authority(em, { operation: 'delete', artifact: candidate }, at)) return null;
        const row = await em.findOneOrFail(ArtifactRecord, { ...this.scope, id: candidate.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        if (row.state === 'DELETED') return null;
        const selectedAt = this.clock();
        if (!revoked && row.state !== 'DELETING' && !(row.state === 'PENDING' ? selectedAt >= row.uploadDeadline : selectedAt >= row.expiresAt)) return null;
        if (row.state === 'DELETING' && row.nextAttemptAt && row.nextAttemptAt > selectedAt) return null;
        row.beginDeletion(selectedAt, row.rowRevision);
        return row;
      });
      if (!selected) continue;
      let removed = false;
      const deletionStartedAt = this.clock();
      try { await this.remote(signal => this.storage.delete(selected.storageKey, { signal })); removed = true; } catch { /* A sanitized retry state retains ownership of an uncertain remote deletion. */ }
      const outcome = await this.orm.em.fork().transactional(async em => {
        const row = await em.findOneOrFail(ArtifactRecord, { ...this.scope, id: selected.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
        if (row.state === 'DELETED') return { artifactId: row.id, status: 'deleted' as const, nextAttemptAt: null };
        const at = this.clock();
        const complete = removed && deletionStartedAt >= row.uploadDeadline;
        if (complete) row.recordDeletion(at, row.rowRevision);
        else row.scheduleDeletionRetry(new Date(Math.max(at.getTime() + this.retryDelayMs, row.uploadDeadline.getTime())),
          removed ? 'upload_horizon_pending' : 'storage_delete_failed', at, row.rowRevision);
        return { artifactId: row.id, status: complete ? 'deleted' as const : 'retry' as const, nextAttemptAt: row.nextAttemptAt };
      });
      outcomes.push(outcome);
    }
    return outcomes;
  }

  /** Owner locks precede artifact locks in both authorization passes, so privacy withdrawal can fence disclosure during storage I/O. */
  private async authorizedRecord(access: OpenArtifactInput): Promise<ArtifactRecord> {
    return this.orm.em.fork().transactional(async em => {
      const now = this.clock();
      const snapshot = await em.findOne(ArtifactRecord, { ...this.scope, id: access.artifactId });
      invariant(snapshot && await this.authority(em, { operation: 'read', artifact: snapshot, access }, now), 'Artifact read denied');
      const row = await em.findOneOrFail(ArtifactRecord, { ...this.scope, id: access.artifactId }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
      const checkedAt = this.clock();
      invariant(row.isReadable(checkedAt) && checkedAt < access.notAfter && row.byteSize !== null && row.byteSize <= this.options.maxBytes
        && row.accessBinding.purpose === access.binding.purpose && row.accessBinding.audience === access.binding.audience
        && row.accessBinding.revision === access.binding.revision, 'Artifact read denied');
      return row;
    });
  }

  /** Bound remote promises locally; cancellation is advisory and late/unknown writes still belong to durable cleanup. */
  private async remote<T>(operation: (signal: AbortSignal) => Promise<T>, notAfter?: Date): Promise<T> {
    const milliseconds = Math.min(this.ioTimeoutMs, notAfter ? notAfter.getTime() - this.clock().getTime() : this.ioTimeoutMs);
    invariant(milliseconds > 0, 'Artifact storage deadline elapsed');
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Artifact storage deadline elapsed')); }, milliseconds);
    });
    try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), timeout]); }
    finally { clearTimeout(timer); }
  }

  /** Count bytes before copying into one bounded buffer; enforce the deadline even when a producer stops yielding.
   * Node's copy/hash contracts: https://nodejs.org/docs/latest-v24.x/api/buffer.html and https://nodejs.org/docs/latest-v24.x/api/crypto.html. */
  private async collectBounded(content: AsyncIterable<Uint8Array>, maxBytes: number, notAfter: Date): Promise<Uint8Array> {
    const bytes = Buffer.alloc(maxBytes); let count = 0, complete = false;
    const iterator = content[Symbol.asyncIterator]();
    try {
      while (true) {
        const remaining = notAfter.getTime() - this.clock().getTime();
        invariant(remaining > 0 && remaining <= 2_147_483_647, 'Artifact content deadline elapsed or too distant');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Artifact content deadline elapsed')), remaining); });
        let item: IteratorResult<Uint8Array>;
        try { item = await Promise.race([iterator.next(), timeout]); } finally { clearTimeout(timer); }
        invariant(this.clock() < notAfter, 'Artifact content deadline elapsed');
        if (item.done) { complete = true; break; }
        const chunk = item.value;
        invariant(chunk instanceof Uint8Array, 'Artifact content must contain bytes');
        invariant(chunk.byteLength <= maxBytes - count, 'Artifact byte limit exceeded');
        // Uint8Array.set copies the producer's bytes; later mutation cannot alter the verified digest.
        bytes.set(chunk, count); count += chunk.byteLength;
      }
      return Buffer.from(bytes.subarray(0, count));
    } finally {
      // A hostile/stalled iterator must not prevent deadline rejection; cancellation is best effort.
      if (!complete && iterator.return) void Promise.resolve().then(() => iterator.return!()).catch(() => {});
    }
  }

  /** Copy verified public metadata and omit internal keys and private provenance. */
  private metadata(row: ArtifactRecord): ArtifactMetadata {
    invariant(row.verifiedHash && row.mediaType && row.byteSize !== null, 'Artifact is not verified');
    return { artifactId: row.id, sha256: row.verifiedHash, mediaType: row.mediaType, byteSize: row.byteSize, expiresAt: new Date(row.expiresAt) };
  }

  /** Reject malformed or unbounded purpose/audience bindings before owner authorization or I/O. */
  private validateBinding(binding: ArtifactBinding): void {
    invariant(typeof binding.purpose === 'string' && binding.purpose.length > 0 && binding.purpose.length <= 128
      && typeof binding.audience === 'string' && binding.audience.length > 0 && binding.audience.length <= 256
      && Number.isSafeInteger(binding.revision) && binding.revision >= 0, 'Invalid artifact binding');
  }

  /** Orchestration must not inherit a caller transaction across object-store I/O. PostgreSQL locks end at each local transaction boundary.
   * Lock semantics: https://www.postgresql.org/docs/current/explicit-locking.html. */
  private assertOutsideTransaction(): void {
    invariant(!this.orm.em.isInTransaction(), 'Artifact I/O cannot run inside a caller transaction');
  }
}
