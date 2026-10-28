/** Immutable agreed Debate rubric content, erasable when the consented retention ends. */
import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertNonNegativeInteger, assertUuid, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';

export interface RubricCriterion { id: string; description: string; minimumScore: number; maximumScore: number }
export interface RubricRevisionInput extends ScopedEntityInput {
  rubricId: string;
  revision: number;
  criteria: readonly RubricCriterion[];
  weights: Readonly<Record<string, string>>;
  configurationVersions: Readonly<Record<string, string>>;
  outcomeRules: { minimumWinningMargin: string; incompleteCoverage: 'uncertain' | 'score_with_limitations' };
  activatedAt: Date | null;
  purgeAfter: Date;
}

/** Immutable agreed scoring contract. Decimal strings avoid floating point weight drift. */
@Entity({ tableName: 'rubric_revision' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'guildId', 'rubricId', 'revision'] })
@Check({ name: 'rubric_revision_check_1', expression: '"revision" >= 0' })
export class RubricRevision extends ScopedEntity {
  @Property({ type: 'uuid' }) readonly rubricId: string;
  @Property({ type: 'integer' }) readonly revision: number;
  @Property({ type: 'json', nullable: true }) criteria: readonly RubricCriterion[] | null;
  @Property({ type: 'json', nullable: true }) weights: Readonly<Record<string, string>> | null;
  @Property({ type: 'json', nullable: true }) configurationVersions: Readonly<Record<string, string>> | null;
  @Property({ type: 'json', nullable: true }) outcomeRules: RubricRevisionInput['outcomeRules'] | null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) readonly activatedAt: Date | null;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly purgeAfter: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) payloadPurgedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) purgeReason: string | null = null;

  /** Validate immutable score ranges and exact decimal weights before activation. */
  constructor(input: RubricRevisionInput) {
    super(input);
    assertUuid(input.rubricId);
    assertNonNegativeInteger(input.revision, 'revision');
    invariant(input.revision <= 2_147_483_647, 'revision exceeds the database integer range');
    assertDate(input.purgeAfter, 'purgeAfter');
    if (input.activatedAt) assertDate(input.activatedAt, 'activatedAt');
    invariant(input.criteria.length > 0 && new Set(input.criteria.map(criterion => criterion.id)).size === input.criteria.length, 'Rubric requires distinct criteria');
    invariant(Object.keys(input.weights).length === input.criteria.length, 'Every criterion requires one weight');
    for (const criterion of input.criteria) {
      invariant(criterion.id.length > 0 && criterion.description.length > 0, 'Criterion identity and description are required');
      assertNonNegativeInteger(criterion.minimumScore, 'minimumScore');
      assertNonNegativeInteger(criterion.maximumScore, 'maximumScore');
      invariant(criterion.maximumScore > criterion.minimumScore, 'Invalid criterion scoring range');
      invariant(/^\d+(?:\.\d+)?$/.test(input.weights[criterion.id] ?? ''), 'Criterion weight must be an exact nonnegative decimal');
    }
    invariant(Object.values(input.weights).some(value => /[1-9]/.test(value)), 'At least one criterion must carry weight');
    invariant(/^\d+(?:\.\d+)?$/.test(input.outcomeRules.minimumWinningMargin), 'Winning margin must be an exact nonnegative decimal');
    invariant(input.purgeAfter > this.createdAt, 'Rubric retention has expired');
    if (input.activatedAt) invariant(input.activatedAt < input.purgeAfter, 'Activation must precede expiry');
    this.rubricId = input.rubricId;
    this.revision = input.revision;
    this.criteria = copyJson(input.criteria);
    this.weights = copyJson(input.weights);
    this.configurationVersions = copyJson(input.configurationVersions);
    this.outcomeRules = copyJson(input.outcomeRules);
    this.activatedAt = input.activatedAt ? new Date(input.activatedAt) : null;
    this.purgeAfter = new Date(input.purgeAfter);
  }

  /** Erase free-text rubric content after the owning session and tasks have been invalidated. */
  purgePayload(reason: string, at: Date): void {
    assertDate(at, 'at'); invariant(reason.length > 0 && reason.length <= 128, 'Invalid rubric purge reason');
    if (this.payloadPurgedAt) return;
    this.criteria = null; this.weights = null; this.configurationVersions = null; this.outcomeRules = null;
    this.payloadPurgedAt = new Date(at); this.purgeReason = reason;
  }
}
