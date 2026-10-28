/** Describe optional fact-bound vectors; embeddings remain disabled for the explicit private-memory route. */
import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertNonNegativeInteger, assertUuid, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';

export interface FactEmbeddingInput extends ScopedEntityInput {
  factId: string;
  model: string;
  dimensions: number;
  contentHash: string;
  privacyRevision: number;
  vector: readonly number[];
  acceptedTaskResultId: string;
}

/** Optional derived personal data, physically deleted with its fact; no index service is activated. */
@Entity({ tableName: 'fact_embedding' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'guildId', 'factId', 'model', 'contentHash', 'privacyRevision'] })
@Unique({ properties: ['installationId', 'guildId', 'acceptedTaskResultId'] })
@Check({ name: 'fact_embedding_check_1', expression: '"dimensions" > 0 and "privacy_revision" >= 0' })
@Check({ name: 'fact_embedding_check_2', expression: 'jsonb_array_length("vector") = "dimensions"' })
export class FactEmbedding extends ScopedEntity {
  @Property({ type: 'uuid' }) readonly factId: string;
  @Property({ type: 'text' }) readonly model: string;
  @Property({ type: 'integer' }) readonly dimensions: number;
  @Property({ type: 'text' }) readonly contentHash: string;
  @Property({ type: 'integer' }) readonly privacyRevision: number;
  // Portable JSONB until the selected embedding/search contract justifies a vector extension.
  @Property({ type: 'json' }) readonly vector: readonly number[];
  @Property({ type: 'uuid' }) readonly acceptedTaskResultId: string;

  /** Validate an optional vector against its exact fact hash, model, dimensions and acceptance identity. */
  constructor(input: FactEmbeddingInput) {
    super(input);
    assertUuid(input.factId);
    assertUuid(input.acceptedTaskResultId);
    assertNonNegativeInteger(input.dimensions, 'dimensions');
    invariant(input.dimensions <= 2_147_483_647, 'dimensions exceeds the database integer range');
    assertNonNegativeInteger(input.privacyRevision, 'privacyRevision');
    invariant(input.privacyRevision <= 2_147_483_647, 'privacyRevision exceeds the database integer range');
    invariant(input.dimensions > 0 && input.dimensions === input.vector.length, 'Vector dimensions do not match');
    invariant(input.vector.every(Number.isFinite), 'Vector coordinates must be finite');
    invariant(input.model.length > 0 && input.contentHash.length > 0, 'Embedding model and content binding are required');
    this.factId = input.factId;
    this.model = input.model;
    this.dimensions = input.dimensions;
    this.contentHash = input.contentHash;
    this.privacyRevision = input.privacyRevision;
    this.vector = [...input.vector];
    this.acceptedTaskResultId = input.acceptedTaskResultId;
  }
}
