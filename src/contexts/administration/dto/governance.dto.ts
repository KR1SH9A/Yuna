/** Validate exact bounded governance requests; identity, quorum, authority and consent never come from interaction fields. */
import { assertDiscordId, assertUuid, invariant } from '../../../platform/db/entity-values.js';
import { parseGrantCapabilityRequest, parseRevokeGrantRequest } from './grant-revocation.dto.js';
import type { AdministrationCapability } from '../contracts.js';
import { custodianCapability, type GovernancePlanReference } from '../governance.contracts.js';

export type GovernanceOperation =
  | { kind: 'grant_capability'; granteeUserId: string; capability: AdministrationCapability | typeof custodianCapability;
      channelIds: readonly string[]; targetUserIds: readonly string[]; expiresAt: string | null }
  | { kind: 'revoke_capability'; grantId: string; expectedAuthorityRevision: number; expectedRowRevision: number; reasonCode: string };
export interface ProposePlanRequestDto { operations: readonly GovernanceOperation[]; sourceOperationKey: string; expiresAt: string }
export type ApprovePlanRequestDto = GovernancePlanReference;
export interface EnrollCustodianRequestDto extends GovernancePlanReference { candidateId: string; action: 'invite' | 'accept' | 'complete' | 'reject' }
export interface GovernancePlanResponseDto extends GovernancePlanReference {
  installationId: string; guildId: string; operations: readonly GovernanceOperation[]; expiresAt: string;
  minimumApprovals: number; recordedApprovals: number; status: 'pending' | 'consumed' | 'invalidated' | 'expired';
}
export interface CustodianEnrollmentResponseDto {
  enrollmentId: string; candidateId: string; planId: string; accepted: boolean;
  status: 'pending' | 'completed' | 'rejected' | 'expired'; resultingGrantId: string | null;
}

/** Reject unknown fields before any asynchronous work; this also prevents a hidden operation from entering a plan hash. */
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid governance request');
  const result = value as Record<string, unknown>;
  invariant(Object.keys(result).every(key => allowed.includes(key)), 'Unknown governance field');
  return result;
}

/** Reuse baseline grant/revocation validation, with one explicit guild-wide staged custodian enrollment shape. */
export function parseGovernanceOperations(value: unknown): GovernanceOperation[] {
  invariant(Array.isArray(value) && value.length > 0 && value.length <= 10, 'Governance operations must contain 1 to 10 items');
  const operations = value.map((item): GovernanceOperation => {
    const kind = (item as { kind?: unknown } | null)?.kind;
    if (kind === 'grant_capability') {
      const input = object(item, ['kind', 'granteeUserId', 'capability', 'channelIds', 'targetUserIds', 'expiresAt']);
      const custodian = input.capability === custodianCapability;
      const grant = parseGrantCapabilityRequest({ granteeUserId: input.granteeUserId,
        capability: custodian ? 'guild.configure' : input.capability,
        scope: { channelIds: input.channelIds, targetUserIds: input.targetUserIds }, sourceOperationKey: 'governance', expiresAt: input.expiresAt });
      invariant(!custodian || (grant.scope.channelIds.length === 0 && grant.scope.targetUserIds.length === 0), 'Custodian scope must be the exact guild');
      return { kind, granteeUserId: grant.granteeUserId, capability: custodian ? custodianCapability : grant.capability,
        channelIds: grant.scope.channelIds, targetUserIds: grant.scope.targetUserIds, expiresAt: grant.expiresAt };
    }
    invariant(kind === 'revoke_capability', 'Unsupported governance operation');
    const input = object(item, ['kind', 'grantId', 'expectedAuthorityRevision', 'expectedRowRevision', 'reasonCode']);
    const { kind: _, ...revocation } = input;
    return { kind, ...parseRevokeGrantRequest(revocation) };
  });
  invariant(new Set(operations.map(operation => operation.kind === 'grant_capability'
    ? `grant:${operation.granteeUserId}:${operation.capability}` : `revoke:${operation.grantId}`)).size === operations.length, 'Duplicate governed operation');
  invariant(!operations.some(operation => operation.kind === 'grant_capability' && operation.capability === custodianCapability)
    || operations.length === 1, 'Custodian enrollment requires one exact operation');
  return operations;
}

/** Normalize exact intended values; expiry bounds and authority are checked by the locked owner. */
export function parseProposePlanRequest(value: unknown): ProposePlanRequestDto {
  const input = object(value, ['operations', 'sourceOperationKey', 'expiresAt']);
  invariant(typeof input.sourceOperationKey === 'string' && /^[a-zA-Z0-9:_.-]{1,64}$/.test(input.sourceOperationKey), 'Invalid governance operation key');
  invariant(typeof input.expiresAt === 'string' && Number.isFinite(Date.parse(input.expiresAt)), 'Invalid governance expiry');
  return { operations: parseGovernanceOperations(input.operations), sourceOperationKey: input.sourceOperationKey,
    expiresAt: new Date(input.expiresAt).toISOString() };
}

/** Plans are addressed by both scoped identifier and immutable SHA-256 digest. */
export function parseApprovePlanRequest(value: unknown): ApprovePlanRequestDto {
  const input = object(value, ['planId', 'planHash']);
  assertUuid(input.planId as string);
  invariant(typeof input.planHash === 'string' && /^[a-f0-9]{64}$/.test(input.planHash), 'Invalid governance plan hash');
  return { planId: input.planId as string, planHash: input.planHash };
}

/** An accept action still requires the separately authenticated candidate caller; JSON cannot assert acceptance. */
export function parseEnrollCustodianRequest(value: unknown): EnrollCustodianRequestDto {
  const input = object(value, ['planId', 'planHash', 'candidateId', 'action']);
  const reference = parseApprovePlanRequest({ planId: input.planId, planHash: input.planHash });
  assertDiscordId(input.candidateId as string);
  invariant(['invite', 'accept', 'complete', 'reject'].includes(input.action as string), 'Invalid enrollment action');
  return { ...reference, candidateId: input.candidateId as string, action: input.action as EnrollCustodianRequestDto['action'] };
}
