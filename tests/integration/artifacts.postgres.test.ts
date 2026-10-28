/** Exercise artifact persistence, byte verification, disclosure races and cleanup using isolated PostgreSQL and controlled object-store checkpoints. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from '@jest/globals';
import { MikroORM } from '@mikro-orm/postgresql';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';
import { ArtifactRecord } from '../../src/platform/artifacts/entities/artifact-record.entity.js';
import { ArtifactStore } from '../../src/platform/artifacts/artifact.store.js';
import { createArtifactStore } from '../../src/platform/artifacts/artifacts.module.js';
import type { ArtifactAuthority, ArtifactStorage, OpenArtifactInput, StoreArtifactInput } from '../../src/platform/artifacts/contracts.js';

let database: ReturnType<typeof temporaryPostgres>, orm: MikroORM;
beforeAll(async () => {
  database = temporaryPostgres();
  orm = new MikroORM({ ...database.options, entities: [ArtifactRecord] }); await orm.connect();
  await orm.schema.create();
}, 60_000);
afterAll(async () => { try { await orm?.close(true); } finally { database?.close(); } }, 30_000);

/** Resolve an explicit asynchronous checkpoint, without sleeps, so races happen in a known order. */
function checkpoint() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Yield copied bytes as an actual async input source. */
async function* bytes(value = 'verified media') { yield Buffer.from(value); }

/** Give each test its own immutable owner scope, fake clock and observable isolated object store. */
function fixture(ioTimeoutMs = 1_000) {
  const scope = { installationId: randomUUID(), guildId: '900000000000000001', owner: 'moderation', retentionScope: 'evidence' };
  let current = new Date('2026-10-28T00:00:00Z'), permitted = true, deleteFails = false, puts = 0, opens = 0, deletes = 0;
  let putWait: ReturnType<typeof checkpoint> | undefined, readWait: ReturnType<typeof checkpoint> | undefined, deleteWait: ReturnType<typeof checkpoint> | undefined;
  const putEntered = checkpoint(), readEntered = checkpoint(), deleteEntered = checkpoint(), objects = new Map<string, Uint8Array>();
  const binding = { purpose: 'moderation', audience: 'staff', revision: 1 };
  const deniedDeletionIds = new Set<string>();
  let authorityHook: ((operation: 'store' | 'read' | 'delete') => Promise<void>) | undefined;
  const storage: ArtifactStorage = {
    /** The fake backend enforces the same write cutoff that a production backend must enforce independently. */
    async put(key, value, options) {
      assert.equal(orm.em.isInTransaction(), false); puts++; putEntered.resolve();
      assert.equal(await orm.em.fork().count(ArtifactRecord, { ...scope, storageKey: key }), 1, 'intent must commit before upload');
      await putWait?.promise;
      assert(current < options.writeNotAfter, 'backend write cutoff');
      objects.set(key, Uint8Array.from(value));
    },
    /** Yield after the test's revocation checkpoint; only this adapter sees the bytes until the final authority check. */
    async open(key) {
      assert.equal(orm.em.isInTransaction(), false); opens++; readEntered.resolve();
      const value = objects.get(key); assert(value);
      return { /** Pause remote reading under explicit test control. */ async *[Symbol.asyncIterator]() { await readWait?.promise; yield value; } };
    },
    /** Erasure occurs before acknowledgment so the test can reproduce a late upload during the acknowledgment delay. */
    async delete(key) {
      assert.equal(orm.em.isInTransaction(), false); deletes++; deleteEntered.resolve();
      if (deleteFails) throw new Error('vendor secret never persisted');
      objects.delete(key); await deleteWait?.promise;
    },
  };
  /** Model an owner that verifies current consent and refuses unsupported worker releases. */
  const authority: ArtifactAuthority = async (em, request) => {
    assert.equal(em.isInTransaction(), true);
    await authorityHook?.(request.operation);
    if (request.operation === 'delete' && deniedDeletionIds.has(request.artifact.id)) return false;
    if (request.operation === 'read' && request.access?.release.kind === 'job') return false;
    return permitted;
  };
  const store = createArtifactStore(orm, scope, storage, authority, { maxBytes: 64, allowedMediaTypes: ['text/plain'],
    verifyMediaType: value => Buffer.from(value).toString().startsWith('verified') ? 'text/plain' : null, retryDelayMs: 10, ioTimeoutMs,
    clock: () => new Date(current) });
  /** Construct current provenance with a fresh independent feature-owner record. */
  const input = (): StoreArtifactInput => ({ ownerRecordRef: randomUUID(), binding, content: bytes(), mediaType: 'text/plain', maxBytes: 64,
    uploadDeadline: new Date(current.getTime() + 1_000), expiresAt: new Date(current.getTime() + 2_000),
    sourceAttachmentId: '900000000000000002', originalMetadata: { filename: 'media.txt' } });
  /** Present an owner-issued read request with a short fixed disclosure lifetime. */
  const access = (artifactId: string): OpenArtifactInput => ({ artifactId, binding, notAfter: new Date(current.getTime() + 500), release: { kind: 'owner' } });
  return { scope, objects, store, storage, authority, input, access, putEntered, readEntered, deleteEntered,
    /** Pause authority under test control to expose stale-time and post-capture revocation races. */
    onAuthority(hook: (operation: 'store' | 'read' | 'delete') => Promise<void>) { authorityHook = hook; },
    /** Move the fake clock only forward. */ advance(ms: number) { current = new Date(current.getTime() + ms); },
    /** Deny only one owner's deletion selection so bounded scan fairness can be exercised. */
    denyDeletion(id: string) { deniedDeletionIds.add(id); },
    /** Withdraw the current owner's authorization before the second disclosure check. */ deny() { permitted = false; },
    /** Control whether erasure has an uncertain remote outcome. */ failDeletes(value: boolean) { deleteFails = value; },
    /** Delay upload until the caller releases this checkpoint. */ pausePut() { return putWait = checkpoint(); },
    /** Delay reads until the caller releases this checkpoint. */ pauseRead() { return readWait = checkpoint(); },
    /** Delay deletion acknowledgment until the caller releases this checkpoint. */ pauseDelete() { return deleteWait = checkpoint(); },
    /** Inspect counts without exposing mutable counters. */ calls() { return { puts, opens, deletes }; },
  };
}

test('capture persists provenance, validates size/hash/type and reads only verified bytes', async () => {
  const f = fixture(), input = f.input(), hash = createHash('sha256').update('verified media').digest('hex');
  const result = await f.store.storeBounded({ ...input, expectedSha256: hash, expectedBytes: 14 });
  assert.equal(result.sha256, hash); assert.equal(result.byteSize, 14); assert(!('storageKey' in result));
  const row = await orm.em.fork().findOneOrFail(ArtifactRecord, result.artifactId);
  assert.equal(row.state, 'READY'); assert.equal(row.sourceAttachmentId, input.sourceAttachmentId);
  assert.deepEqual(row.accessBinding, input.binding);
  const read = await f.store.openAuthorized(f.access(result.artifactId)); assert.equal(Buffer.from(read.bytes).toString(), 'verified media');
});

test('overflow, digest, size and content-type mismatches create only unavailable cleanup intents', async () => {
  const f = fixture();
  for (const override of [{ maxBytes: 3 }, { expectedBytes: 1 }, { expectedSha256: '0'.repeat(64) }, { content: bytes('bad header') }]) {
    await assert.rejects(f.store.storeBounded({ ...f.input(), ...override }), /limit|mismatch/);
  }
  assert.equal(f.calls().puts, 0);
  assert.equal(await orm.em.fork().count(ArtifactRecord, { ...f.scope, state: 'DELETING' }), 4);
});

test('producer mutation cannot change captured bytes and overflow closes the source', async () => {
  const f = fixture(), chunk = Buffer.from('verified media');
  const content = { /** Mutate an already-yielded chunk after its next consumer turn. */ async *[Symbol.asyncIterator]() { yield chunk; chunk.fill(0); } };
  const stored = await f.store.storeBounded({ ...f.input(), content });
  assert.equal(Buffer.from((await f.store.openAuthorized(f.access(stored.artifactId))).bytes).toString(), 'verified media');
  let closed = false;
  const overflow = { /** Record iterator cleanup when capture rejects oversized content. */ async *[Symbol.asyncIterator]() { try { yield Buffer.alloc(65); } finally { closed = true; } } };
  await assert.rejects(f.store.storeBounded({ ...f.input(), content: overflow }), /limit/); assert.equal(closed, true);
});

test('current binding, release scope, installation, purpose, audience and expiry all fence reads', async () => {
  const f = fixture(), stored = await f.store.storeBounded(f.input()), access = f.access(stored.artifactId);
  for (const binding of [{ ...access.binding, purpose: 'memory' }, { ...access.binding, audience: 'public' }, { ...access.binding, revision: 2 }]) {
    await assert.rejects(f.store.openAuthorized({ ...access, binding }), /denied/);
  }
  await assert.rejects(f.store.openAuthorized({ ...access, release: { kind: 'job', taskId: randomUUID(), inputReleaseId: randomUUID() } }), /denied/);
  const foreign = new ArtifactStore(orm, { ...f.scope, installationId: randomUUID() }, f.storage, f.authority,
    { maxBytes: 64, allowedMediaTypes: ['text/plain'], verifyMediaType: () => 'text/plain' });
  await assert.rejects(foreign.openAuthorized(access), /denied/);
  await assert.rejects(f.store.openAuthorized({ ...access, artifactId: '/etc/passwd' }), /UUID/);
  assert.equal(f.calls().opens, 0);
  f.advance(2_000); await assert.rejects(f.store.openAuthorized(access), /denied/);
});

test('revocation during remote read prevents bytes from escaping', async () => {
  const f = fixture(), stored = await f.store.storeBounded(f.input()), release = f.pauseRead();
  const reading = f.store.openAuthorized(f.access(stored.artifactId)); await f.readEntered.promise;
  f.deny(); release.resolve(); await assert.rejects(reading, /denied/);
});

test('storage corruption and oversized storage streams are rejected before release', async () => {
  const f = fixture(), stored = await f.store.storeBounded(f.input());
  const row = await orm.em.fork().findOneOrFail(ArtifactRecord, stored.artifactId);
  f.objects.set(row.storageKey, Buffer.from('verified other')); await assert.rejects(f.store.openAuthorized(f.access(stored.artifactId)), /verification/);
  f.objects.set(row.storageKey, Buffer.alloc(65)); await assert.rejects(f.store.openAuthorized(f.access(stored.artifactId)), /limit/);
});

test('revocation fences a pending upload and cleanup repeats after late upload visibility', async () => {
  const f = fixture(), uploadRelease = f.pausePut();
  const uploading = f.store.storeBounded(f.input()); const rejected = assert.rejects(uploading, /Stale artifact write|cannot become/);
  await f.putEntered.promise;
  const row = await orm.em.fork().findOneOrFail(ArtifactRecord, { ...f.scope });
  const first = await f.store.deleteExpired({ revokedArtifactIds: [row.id] }); assert.equal(first[0]?.status, 'retry');
  uploadRelease.resolve(); await rejected; assert.equal(f.objects.size, 1);
  f.advance(1_000);
  const repeated = await f.store.deleteExpired(); assert.equal(repeated[0]?.status, 'deleted'); assert.equal(f.objects.size, 0);
  assert.equal((await orm.em.fork().findOneOrFail(ArtifactRecord, row.id)).originalMetadata, null);
});

test('deletion acknowledgment crossing upload deadline still requires a new post-horizon delete', async () => {
  const f = fixture(), stored = await f.store.storeBounded(f.input()), deletionRelease = f.pauseDelete();
  const deleting = f.store.deleteExpired({ revokedArtifactIds: [stored.artifactId] }); await f.deleteEntered.promise;
  f.advance(1_000); deletionRelease.resolve();
  assert.equal((await deleting)[0]?.status, 'retry');
  f.advance(10); assert.equal((await f.store.deleteExpired())[0]?.status, 'deleted');
});

test('failed deletion is retryable, sanitized and continues after owner authorization is withdrawn', async () => {
  const f = fixture(), stored = await f.store.storeBounded(f.input()); f.advance(2_000); f.failDeletes(true);
  assert.equal((await f.store.deleteExpired())[0]?.status, 'retry');
  let row = await orm.em.fork().findOneOrFail(ArtifactRecord, stored.artifactId); assert.equal(row.failureCode, 'storage_delete_failed');
  f.deny(); f.failDeletes(false); f.advance(10); assert.equal((await f.store.deleteExpired())[0]?.status, 'deleted');
  row = await orm.em.fork().findOneOrFail(ArtifactRecord, stored.artifactId); assert.equal(row.failureCode, null);
  assert.deepEqual(await f.store.deleteExpired(), []);
});

test('cleanup is owner-scoped, bounded and cannot erase denied unexpired selection', async () => {
  const f = fixture(), foreign = fixture(); await f.store.storeBounded(f.input()); const second = await f.store.storeBounded(f.input());
  const other = await foreign.store.storeBounded(foreign.input());
  assert.deepEqual(await f.store.deleteExpired(), []);
  assert.deepEqual(await f.store.deleteExpired({ revokedArtifactIds: [other.artifactId] }), []);
  f.deny(); assert.deepEqual(await f.store.deleteExpired({ revokedArtifactIds: [second.artifactId] }), []);
  assert.equal(f.calls().deletes, 0);
  f.advance(2_000); assert.deepEqual(await f.store.deleteExpired({ limit: 1 }), []);
});


test('caller transactions cannot cross remote I/O and metadata bounds fail before persistence', async () => {
  const f = fixture();
  await orm.em.fork().transactional(async () => {
    await assert.rejects(f.store.storeBounded(f.input()), /caller transaction/);
    await assert.rejects(f.store.openAuthorized(f.access(randomUUID())), /caller transaction/);
    await assert.rejects(f.store.deleteExpired(), /caller transaction/);
  });
  await assert.rejects(f.store.storeBounded({ ...f.input(), originalMetadata: { content: 'x'.repeat(16_385) } }), /metadata/);
  assert.equal(await orm.em.fork().count(ArtifactRecord, f.scope), 0);
  assert.deepEqual(f.calls(), { puts: 0, opens: 0, deletes: 0 });
});


test('storage watchdog bounds stalled upload, open and deletion while preserving retryable ownership', async () => {
  const f = fixture(25), never = checkpoint();
  f.storage.put = async () => { await never.promise; };
  await assert.rejects(f.store.storeBounded(f.input()), /storage deadline/);
  assert.equal(await orm.em.fork().count(ArtifactRecord, { ...f.scope, state: 'DELETING' }), 1);
  const readable = fixture(25), stored = await readable.store.storeBounded(readable.input());
  readable.storage.open = async () => { await never.promise; return bytes(); };
  await assert.rejects(readable.store.openAuthorized(readable.access(stored.artifactId)), /storage deadline/);
  readable.advance(2_000); readable.storage.delete = async () => { await never.promise; };
  const outcomes = await readable.store.deleteExpired(); assert.equal(outcomes[0]?.status, 'retry');
  assert.equal((await orm.em.fork().findOneOrFail(ArtifactRecord, stored.artifactId)).failureCode, 'storage_delete_failed');
});

test('withdrawal during capture prevents a new upload claim or any storage disclosure', async () => {
  const f = fixture(), entered = checkpoint(), release = checkpoint();
  const content = { /** Hold capture after its first chunk while the owner withdraws authorization. */ async *[Symbol.asyncIterator]() {
    yield Buffer.from('verified media'); entered.resolve(); await release.promise;
  } };
  const storing = f.store.storeBounded({ ...f.input(), content }); const rejected = assert.rejects(storing, /store denied/);
  await entered.promise; f.deny(); release.resolve(); await rejected;
  assert.equal(f.calls().puts, 0);
  assert.equal(await orm.em.fork().count(ArtifactRecord, { ...f.scope, state: 'DELETING' }), 1);
});

test('upload finalization checks actual time after a waiting authorization and cannot publish late bytes', async () => {
  const f = fixture(), entered = checkpoint(), release = checkpoint(); let authorizations = 0;
  f.onAuthority(async operation => { if (operation === 'store' && ++authorizations === 3) { entered.resolve(); await release.promise; } });
  const storing = f.store.storeBounded(f.input()); const rejected = assert.rejects(storing, /cannot become/);
  await entered.promise; f.advance(1_000); release.resolve(); await rejected;
  assert.equal(f.calls().puts, 1);
  const row = await orm.em.fork().findOneOrFail(ArtifactRecord, f.scope); assert.equal(row.state, 'DELETING');
  assert.equal((await f.store.deleteExpired())[0]?.status, 'deleted');
});

test('read checks actual time after a waiting owner authorization before opening storage', async () => {
  const f = fixture(), stored = await f.store.storeBounded(f.input()), entered = checkpoint(), release = checkpoint();
  f.onAuthority(async operation => { if (operation === 'read') { entered.resolve(); await release.promise; } });
  const reading = f.store.openAuthorized(f.access(stored.artifactId)); const rejected = assert.rejects(reading, /read denied/);
  await entered.promise; f.advance(500); release.resolve(); await rejected; assert.equal(f.calls().opens, 0);
});


test('expiry cursor rotates past a permanently denied first row without starving later cleanup', async () => {
  const f = fixture(), first = await f.store.storeBounded(f.input()), second = await f.store.storeBounded(f.input());
  const [denied, permitted] = [first.artifactId, second.artifactId].sort(); f.denyDeletion(denied!); f.advance(2_000);
  assert.deepEqual(await f.store.deleteExpired({ limit: 1 }), []);
  const outcomes = await f.store.deleteExpired({ limit: 1 });
  assert.equal(outcomes[0]?.artifactId, permitted); assert.equal(outcomes[0]?.status, 'deleted');
  assert.equal((await orm.em.fork().findOneOrFail(ArtifactRecord, denied!)).state, 'READY');
  // Explicit owner selections bypass the cursor even after it advanced beyond this earlier reference.
  assert.deepEqual(await f.store.deleteExpired({ revokedArtifactIds: [denied!] }), []);
});
