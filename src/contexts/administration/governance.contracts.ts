/** Narrow, opt-in governance values; none enables Discord commands or substitutes for current owner authorization. */
import type { CurrentNativeFacts, StaffRequestAuthority, TrustedCallerContext } from './contracts.js';
import type { GovernanceOperation } from './dto/governance.dto.js';

/** This staged capability is interpreted only by GovernanceService, never by baseline native-authority policy. */
export const custodianCapability = 'governance.custodian' as const;
export interface GovernancePolicy {
  readonly enabled: true;
  readonly revision: number;
  readonly minimumApprovals: number;
  readonly maximumPlanLifetimeMs: number;
  readonly retentionDays: number;
}
export interface GovernancePlanReference { readonly planId: string; readonly planHash: string }
/** Fresh observations are collected before transactions; the service reloads every grant and approval under locks. */
export interface GovernanceObservations {
  readonly executor: CurrentNativeFacts;
  readonly requester: CurrentNativeFacts;
  readonly approvers: readonly CurrentNativeFacts[];
}
/** Candidate identity is independently authenticated by ingress, bound to the exact invitation and never read from request JSON. */
export interface VerifiedCandidateAcceptance extends GovernancePlanReference {
  readonly caller: TrustedCallerContext;
}
/** Returned only after plan consumption inside the owner transaction; never accept this value from a transport. */
export interface ApprovedPlanBinding extends GovernancePlanReference {
  readonly installationId: string;
  readonly guildId: string;
  readonly consumptionReference: string;
  readonly operations: readonly GovernanceOperation[];
  readonly requesterAuthority: StaffRequestAuthority;
}
