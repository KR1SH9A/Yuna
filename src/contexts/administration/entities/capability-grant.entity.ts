import { Check, Entity, Property, Unique } from '@mikro-orm/decorators/legacy';
import { ScopedEntity } from '../../../platform/db/base.entity.js';
import { assertDate, assertDiscordId, copyJson, invariant, type ScopedEntityInput } from '../../../platform/db/entity-values.js';

export interface GrantPrincipal { kind: 'user'; userId: string }
export interface CapabilityScope { channelIds: readonly string[]; targetUserIds: readonly string[] }
export interface CapabilityGrantInput extends ScopedEntityInput {
  grantee: GrantPrincipal;
  capability: string;
  scope: CapabilityScope;
  grantor: GrantPrincipal;
  sourceRequestId: string;
  sourceOperationKey: string;
  grantedAt: Date;
  expiresAt: Date | null;
}

/** App authority does not replace current Discord permissions or role hierarchy. */
@Entity({ tableName: 'capability_grant' })
@Unique({ properties: ['installationId', 'guildId', 'id'] })
@Unique({ properties: ['installationId', 'guildId', 'sourceRequestId', 'sourceOperationKey'] })
@Check({ name: 'capability_grant_check_1', expression: '"expires_at" is null or "expires_at" > "granted_at"' })
@Check({ name: 'capability_grant_check_2', expression: '"revoked_at" is null or "revoked_at" >= "granted_at"' })
@Check({ name: 'capability_grant_check_3', expression: '"row_revision" >= 1' })
export class CapabilityGrant extends ScopedEntity {
  @Property({ type: 'json' }) readonly grantee: GrantPrincipal;
  @Property({ type: 'text' }) readonly capability: string;
  @Property({ type: 'json' }) readonly scope: CapabilityScope;
  @Property({ type: 'json' }) readonly grantor: GrantPrincipal;
  @Property({ type: 'text' }) readonly sourceRequestId: string;
  @Property({ type: 'text' }) readonly sourceOperationKey: string;
  @Property({ type: Date, columnType: 'timestamptz' }) readonly grantedAt: Date;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) readonly expiresAt: Date | null;
  @Property({ type: Date, columnType: 'timestamptz', nullable: true }) revokedAt: Date | null = null;
  @Property({ type: 'text', nullable: true }) revocationReason: string | null = null;
  @Property({ type: 'integer' }) authorityRevision = 0;
  @Property({ type: 'integer', concurrencyCheck: true }) rowRevision = 1;
  @Property({ type: Date, columnType: 'timestamptz' }) updatedAt: Date;

  constructor(input: CapabilityGrantInput) {
    super(input);
    assertDiscordId(input.grantee.userId);
    assertDiscordId(input.grantor.userId);
    input.scope.channelIds.forEach(assertDiscordId);
    input.scope.targetUserIds.forEach(assertDiscordId);
    assertDate(input.grantedAt, 'grantedAt');
    if (input.expiresAt) { assertDate(input.expiresAt, 'expiresAt'); invariant(input.expiresAt > input.grantedAt, 'Expiry must follow grant'); }
    invariant(input.capability.length > 0 && input.sourceRequestId.length > 0 && input.sourceOperationKey.length > 0, 'Grant identity is required');
    this.grantee = copyJson(input.grantee);
    this.capability = input.capability;
    this.scope = copyJson(input.scope);
    this.grantor = copyJson(input.grantor);
    this.sourceRequestId = input.sourceRequestId;
    this.sourceOperationKey = input.sourceOperationKey;
    this.grantedAt = new Date(input.grantedAt);
    this.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    this.updatedAt = new Date(input.grantedAt);
  }

  revoke(expectedRevision: number, reasonCode: string, at: Date): void {
    invariant(this.rowRevision < 2_147_483_647, 'Row revision exhausted');
    if (this.revokedAt) return;
    invariant(expectedRevision === this.authorityRevision, 'Stale authority revision');
    assertDate(at, 'at');
    invariant(at >= this.grantedAt, 'Revocation predates the grant');
    invariant(reasonCode.length > 0 && reasonCode.length <= 128, 'A bounded reason code is required');
    invariant(this.authorityRevision < 2_147_483_647, 'Authority revision exhausted');
    this.revokedAt = new Date(at);
    this.revocationReason = reasonCode;
    this.authorityRevision += 1;
    this.advanceRevision(at);
  }

  /** Empty restrictions mean installation-wide scope; services authorize that at creation. */
  isCurrentFor(input: { userId: string; capability: string; channelId?: string; targetUserId?: string; at: Date }): boolean {
    assertDate(input.at, 'at');
    return this.revokedAt === null && input.at >= this.grantedAt && (!this.expiresAt || input.at < this.expiresAt)
      && input.userId === this.grantee.userId && input.capability === this.capability
      && (this.scope.channelIds.length === 0 || (!!input.channelId && this.scope.channelIds.includes(input.channelId)))
      && (this.scope.targetUserIds.length === 0 || (!!input.targetUserId && this.scope.targetUserIds.includes(input.targetUserId)));
  }

  private advanceRevision(at: Date): void {
    this.rowRevision += 1;
    this.updatedAt = new Date(at);
  }
}
