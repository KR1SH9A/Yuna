/** Compose the optional artifact component with an explicitly supplied backend, byte verifier and feature-owner authority. */
import type { MikroORM } from '@mikro-orm/postgresql';
import { ArtifactStore } from './artifact.store.js';
import type { ArtifactAuthority, ArtifactScope, ArtifactStorage, ArtifactStoreOptions } from './contracts.js';

/** Ordinary TypeScript composition; callers must provide a backend that enforces upload horizons before enabling ingestion. */
export function createArtifactStore(orm: MikroORM, scope: ArtifactScope, storage: ArtifactStorage,
  authority: ArtifactAuthority, options: ArtifactStoreOptions): ArtifactStore {
  return new ArtifactStore(orm, scope, storage, authority, options);
}
