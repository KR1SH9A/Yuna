/** Apply the fixed grant/revocation plan vocabulary through Administration's existing owners in one rollback-safe local transaction. */
import type { MikroORM } from '@mikro-orm/postgresql';
import { invariant } from '../../src/platform/db/entity-values.js';
import type { TrustedCallerContext } from '../../src/contexts/administration/contracts.js';
import { AuthorityService } from '../../src/contexts/administration/authority.service.js';
import { GovernanceService, readGovernanceObservations } from '../../src/contexts/administration/governance.service.js';
import { custodianCapability } from '../../src/contexts/administration/governance.contracts.js';
import { parseApprovePlanRequest } from '../../src/contexts/administration/dto/governance.dto.js';
import type { CapabilityGrantResponseDto } from '../../src/contexts/administration/dto/grant-revocation.dto.js';

export class ApprovedPlanHandlers {
  /** Explicit composition keeps the staged coordinator out of normal bot startup and prevents Administration importing other contexts. */
  constructor(private readonly orm: MikroORM, private readonly governance: GovernanceService, private readonly authority: AuthorityService) {}

  /** Consume exact approval and apply only its stored operations atomically; any owner rejection rolls back consumption, grants and audit. */
  async applyApprovedPlan(trustedCaller: TrustedCallerContext, value: unknown): Promise<{
    planId: string; consumptionReference: string; grants: readonly CapabilityGrantResponseDto[];
  }> {
    const caller = Object.freeze({ ...trustedCaller }), input = parseApprovePlanRequest(value);
    // Discord observations happen before locks. consumeApproval rechecks their exact scope, freshness and revisions after any lock wait.
    const observations = await readGovernanceObservations(this.orm, this.authority, caller, input);
    return this.orm.em.fork().transactional(async em => {
      const binding = await this.governance.consumeApproval(em, caller, input, observations);
      const grants: CapabilityGrantResponseDto[] = [];
      for (const [index, operation] of binding.operations.entries()) {
        const transaction = { em, facts: observations.executor };
        if (operation.kind === 'grant_capability') {
          invariant(operation.capability !== custodianCapability, 'Custodian grants require candidate enrollment');
          grants.push(await this.authority.grantCapability(caller, { granteeUserId: operation.granteeUserId, capability: operation.capability,
            scope: { channelIds: operation.channelIds, targetUserIds: operation.targetUserIds }, expiresAt: operation.expiresAt,
            sourceOperationKey: `plan:${binding.planId}:${index}` }, transaction));
        } else {
          grants.push(await this.authority.revokeGrant(caller, { grantId: operation.grantId, expectedAuthorityRevision: operation.expectedAuthorityRevision,
            expectedRowRevision: operation.expectedRowRevision, reasonCode: operation.reasonCode }, transaction));
        }
      }
      return { planId: binding.planId, consumptionReference: binding.consumptionReference, grants };
    });
  }
}
