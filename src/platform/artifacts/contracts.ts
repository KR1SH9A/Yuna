/** Define bounded artifact bytes, owner-issued disclosure bindings and a vendor-neutral storage boundary. */
import type { EntityManager } from '@mikro-orm/postgresql';
import type { JsonObject } from '../db/entity-values.js';
import type { ArtifactRecord } from './entities/artifact-record.entity.js';

export interface ArtifactScope {
  readonly installationId: string;
  readonly guildId: string;
  readonly owner: string;
  readonly retentionScope: string;
}

export interface ArtifactBinding {
  readonly purpose: string;
  readonly audience: string;
  readonly revision: number;
}

export interface StoreArtifactInput {
  readonly ownerRecordRef: string;
  readonly binding: ArtifactBinding;
  readonly content: AsyncIterable<Uint8Array>;
  readonly mediaType: string;
  readonly maxBytes: number;
  readonly expectedBytes?: number;
  readonly expectedSha256?: string;
  readonly uploadDeadline: Date;
  readonly expiresAt: Date;
  readonly sourceAttachmentId?: string;
  readonly sourceMessageId?: string;
  readonly sourceChannelId?: string;
  readonly originalMetadata?: JsonObject;
}

export interface ArtifactMetadata {
  readonly artifactId: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly expiresAt: Date;
}

export interface OpenArtifactInput {
  readonly artifactId: string;
  readonly binding: ArtifactBinding;
  readonly notAfter: Date;
  /** Jobs must authorize this exact release; task identity alone is never a release grant. */
  readonly release: { readonly kind: 'owner' } | { readonly kind: 'job'; readonly taskId: string; readonly inputReleaseId: string };
}

export interface DeleteArtifactsInput {
  readonly limit?: number;
  /** Owner revocation must name exact references; expiry scans never broaden the configured owner scope. */
  readonly revokedArtifactIds?: readonly string[];
}

export interface ArtifactDeletionOutcome {
  readonly artifactId: string;
  readonly status: 'deleted' | 'retry';
  readonly nextAttemptAt: Date | null;
}

/** All object keys are generated internally. Adapters must bound reads and must never expose bucket credentials to workers. */
export interface ArtifactStorage {
  /** A successful write is durable and immutable. The backend MUST prevent new visibility after writeNotAfter,
   * including an upload whose client has crashed; a client-side timeout alone does not satisfy this contract. */
  put(key: string, bytes: Uint8Array, options: { mediaType: string; sha256: string; writeNotAfter: Date; signal: AbortSignal }): Promise<void>;
  /** Return bytes only for this opaque key. Reads must honor the deadline, cancellation and byte bound. */
  open(key: string, options: { maxBytes: number; notAfter: Date; signal: AbortSignal }): Promise<AsyncIterable<Uint8Array>>;
  /** Idempotently erase the object; absence is success. Do not claim success for an unknown remote outcome. */
  delete(key: string, options: { signal: AbortSignal }): Promise<void>;
}

/** This local owner callback locks and checks current policy/consent before touching the artifact row.
 * It must do no external I/O. A job read must verify an existing Jobs input-release authorization.
 * On delete, it approves the expiry/revocation selection; retries of committed deletion need no new approval. */
export type ArtifactAuthority = (em: EntityManager, request: {
  readonly operation: 'store' | 'read' | 'delete';
  readonly artifact: Readonly<ArtifactRecord>;
  readonly access?: Readonly<OpenArtifactInput>;
}, now: Date) => Promise<boolean>;

export interface ArtifactStoreOptions {
  /** The deployment imposes this process memory bound, even when an owner requests more. */
  readonly maxBytes: number;
  readonly allowedMediaTypes: readonly string[];
  /** Inspect captured bytes, not the claimed MIME header; return null for unsupported/invalid content. */
  readonly verifyMediaType: (bytes: Uint8Array) => string | null;
  readonly retryDelayMs?: number;
  /** Local watchdog bounds each storage call even if an adapter ignores cancellation. */
  readonly ioTimeoutMs?: number;
  readonly clock?: () => Date;
}
