import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, assertNonNegativeInteger, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';

export interface ModerationRule { id: string; version: string; description: string; enabled: boolean }
export interface PolicyRequiredEvidence { ruleId: string; originalBody: boolean; originalMedia: boolean; establishedAuthor: boolean }
export interface PolicyExclusion { id: string; description: string; ruleIds: string[] }
export interface PolicyEvaluationConfiguration { schemaVersion: 1; observationModel: string; assessmentModel: string; promptVersion: string }
export interface PolicyActionMapping { ruleId: string; supportedDisposition: 'violation' | 'suspicion'; action: 'ban' | 'warning' | 'none'; deleteMessageSeconds: number }
export interface ModerationPolicyRevisionInput extends ScopedEntityInput {
  revisionNumber: number;
  rules: ModerationRule[];
  requiredEvidence: PolicyRequiredEvidence[];
  exclusions: PolicyExclusion[];
  evaluationConfiguration: PolicyEvaluationConfiguration;
  actionMapping: PolicyActionMapping[];
  publisherUserId: string;
  publisherRequestId: string;
  publishedAt: Date;
}

/** Publish another row to change policy; retained findings continue to mean the same thing. */
@Check({ name: 'moderation_policy_revision_check_1', expression: "revision_number >= 0" })
@Entity({ tableName: 'moderation_policy_revision' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'revisionNumber'] })
export class ModerationPolicyRevision extends ScopedEntity {
  @Property({ type: 'integer' }) readonly revisionNumber: number;
  @Property({ type: 'json', columnType: 'jsonb' }) readonly rules: ModerationRule[];
  @Property({ type: 'json', columnType: 'jsonb' }) readonly requiredEvidence: PolicyRequiredEvidence[];
  @Property({ type: 'json', columnType: 'jsonb' }) readonly exclusions: PolicyExclusion[];
  @Property({ type: 'json', columnType: 'jsonb' }) readonly evaluationConfiguration: PolicyEvaluationConfiguration;
  @Property({ type: 'json', columnType: 'jsonb' }) readonly actionMapping: PolicyActionMapping[];
  @Property({ type: 'text' }) readonly publisherUserId: string;
  @Property({ type: 'text' }) readonly publisherRequestId: string;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly publishedAt: Date;

  constructor(input: ModerationPolicyRevisionInput) {
    super(input);
    assertNonNegativeInteger(input.revisionNumber, 'revisionNumber');
    assertDiscordId(input.publisherUserId);
    assertDate(input.publishedAt, 'publishedAt');
    invariant(input.publisherRequestId.length > 0, 'Publication requires authenticated request provenance');
    invariant(input.rules.length > 0 && input.rules.length <= 100, 'Policy requires a bounded rule set');
    const rules = new Set(input.rules.map((rule) => rule.id));
    invariant(rules.size === input.rules.length && !rules.has(''), 'Rule identifiers must be nonempty and unique');
    for (const requirement of input.requiredEvidence) invariant(rules.has(requirement.ruleId), 'Evidence requirement refers to an unknown rule');
    for (const mapping of input.actionMapping) {
      invariant(rules.has(mapping.ruleId), 'Action mapping refers to an unknown rule');
      assertNonNegativeInteger(mapping.deleteMessageSeconds, 'deleteMessageSeconds');
      invariant(mapping.deleteMessageSeconds <= 604800, 'Discord permits at most seven days of ban history deletion');
      invariant(mapping.action === 'ban' || mapping.deleteMessageSeconds === 0, 'History deletion is only meaningful for a ban');
      invariant(mapping.action !== 'ban' || mapping.supportedDisposition === 'violation', 'Suspicion cannot authorize a ban');
    }
    this.revisionNumber = input.revisionNumber;
    this.rules = copyJson(input.rules);
    this.requiredEvidence = copyJson(input.requiredEvidence);
    this.exclusions = copyJson(input.exclusions);
    this.evaluationConfiguration = copyJson(input.evaluationConfiguration);
    this.actionMapping = copyJson(input.actionMapping);
    this.publisherUserId = input.publisherUserId;
    this.publisherRequestId = input.publisherRequestId;
    this.publishedAt = new Date(input.publishedAt);
  }
}
