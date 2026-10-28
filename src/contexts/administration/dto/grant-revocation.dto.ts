/** Validated grant operations and allowlisted display values; caller identity always arrives separately. */
import { assertDiscordId, assertNonNegativeInteger, assertUuid, invariant } from '../../../platform/db/entity-values.js';
import { administrationCapabilities, type AdministrationCapability, type CapabilityScope } from '../contracts.js';

export interface GrantCapabilityRequestDto {
  granteeUserId: string;
  capability: AdministrationCapability;
  scope: CapabilityScope;
  sourceOperationKey: string;
  expiresAt: string | null;
}
export interface RevokeGrantRequestDto {
  grantId: string;
  expectedAuthorityRevision: number;
  expectedRowRevision: number;
  reasonCode: string;
}
export interface CapabilityGrantResponseDto {
  grantId: string;
  granteeUserId: string;
  capability: string;
  scope: CapabilityScope;
  expiresAt: string | null;
  revoked: boolean;
  authorityRevision: number;
  rowRevision: number;
}
export type GrantRevocationResponseDto = CapabilityGrantResponseDto;

/** Reject forged identity fields and detach/sort restrictions before the first asynchronous boundary. */
export function parseGrantCapabilityRequest(value: unknown): GrantCapabilityRequestDto {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid grant request');
  const input = value as Record<string, unknown>;
  invariant(Object.keys(input).every(key => ['granteeUserId', 'capability', 'scope', 'sourceOperationKey', 'expiresAt'].includes(key)), 'Unknown grant request field');
  assertDiscordId(input.granteeUserId as string);
  invariant(administrationCapabilities.includes(input.capability as AdministrationCapability) && input.capability !== 'administration.manage', 'Capability is not delegable');
  invariant(typeof input.sourceOperationKey === 'string' && /^[a-zA-Z0-9:_.-]{1,128}$/.test(input.sourceOperationKey), 'Invalid grant operation key');
  invariant(input.expiresAt === null || (typeof input.expiresAt === 'string' && Number.isFinite(Date.parse(input.expiresAt))), 'Invalid grant expiry');
  invariant(input.scope !== null && typeof input.scope === 'object' && !Array.isArray(input.scope), 'Invalid grant scope');
  const scope = input.scope as Record<string, unknown>;
  invariant(Object.keys(scope).every(key => ['channelIds', 'targetUserIds'].includes(key)), 'Unknown grant scope field');
  for (const key of ['channelIds', 'targetUserIds']) {
    invariant(Array.isArray(scope[key]) && scope[key].length <= 100, 'Grant restrictions must be bounded');
    (scope[key] as string[]).forEach(assertDiscordId);
    invariant(new Set(scope[key] as string[]).size === (scope[key] as string[]).length, 'Duplicate grant restriction');
  }
  return { granteeUserId: input.granteeUserId as string, capability: input.capability as AdministrationCapability,
    sourceOperationKey: input.sourceOperationKey, expiresAt: input.expiresAt === null ? null : new Date(input.expiresAt as string).toISOString(),
    scope: { channelIds: [...scope.channelIds as string[]].sort(), targetUserIds: [...scope.targetUserIds as string[]].sort() } };
}

/** Revisions express expectations, not authority; the service locks and authorizes the loaded grant. */
export function parseRevokeGrantRequest(value: unknown): RevokeGrantRequestDto {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid revocation request');
  const input = value as Record<string, unknown>;
  invariant(Object.keys(input).every(key => ['grantId', 'expectedAuthorityRevision', 'expectedRowRevision', 'reasonCode'].includes(key)), 'Unknown revocation request field');
  assertUuid(input.grantId as string);
  assertNonNegativeInteger(input.expectedAuthorityRevision as number, 'expectedAuthorityRevision');
  assertNonNegativeInteger(input.expectedRowRevision as number, 'expectedRowRevision');
  invariant((input.expectedRowRevision as number) > 0, 'Invalid row revision');
  invariant(typeof input.reasonCode === 'string' && /^[a-zA-Z0-9:_.-]{1,128}$/.test(input.reasonCode), 'Invalid revocation reason');
  return { grantId: input.grantId as string, expectedAuthorityRevision: input.expectedAuthorityRevision as number,
    expectedRowRevision: input.expectedRowRevision as number, reasonCode: input.reasonCode };
}
