/** Opt-in, exact capability governance. No runtime registration or schema activation occurs here; local writes join the owner transaction. */
import { createHash, randomUUID } from 'node:crypto';
import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { assertDiscordId, assertUuid, copyJson, invariant, type JsonObject } from '../../platform/db/entity-values.js';
import { AuditRecorder } from '../../platform/audit/audit.recorder.js';
import { AuthorityService } from './authority.service.js';
import { AuthorityPolicy } from './authority.policy.js';
import type { CurrentNativeFacts, StaffRequestAuthority, TrustedCallerContext } from './contracts.js';
import { custodianCapability, type ApprovedPlanBinding, type GovernanceObservations, type GovernancePlanReference,
  type GovernancePolicy, type VerifiedCandidateAcceptance } from './governance.contracts.js';
import { parseApprovePlanRequest, parseEnrollCustodianRequest, parseGovernanceOperations, parseProposePlanRequest,
  type CustodianEnrollmentResponseDto, type GovernancePlanResponseDto } from './dto/governance.dto.js';
import { ActionPlan } from './entities/action-plan.entity.js';
import { PlanApproval } from './entities/plan-approval.entity.js';
import { CustodianEnrollment } from './entities/custodian-enrollment.entity.js';
import { CapabilityGrant } from './entities/capability-grant.entity.js';
import { GuildInstallation } from './entities/guild-installation.entity.js';
import { GuildSafetyState } from './entities/guild-safety-state.entity.js';

const ownerOperation = { capability: 'administration.manage' } as const;
const custodianNativeOperation = { capability: 'guild.configure' } as const;
type CustodianAuthority = { caller: TrustedCallerContext; grantId: string; grantRevision: number; grantRowRevision: number;
  installationGeneration: number; installationRevision: number; safetyRevision: number };

export class GovernanceService {
  private readonly policy: GovernancePolicy;
  private readonly nativePolicy = new AuthorityPolicy();

  /** Require an explicit immutable policy. Existing administration and owner bootstrap never activate this staged workflow. */
  constructor(private readonly orm: MikroORM, private readonly authority: AuthorityService, policy: GovernancePolicy,
    private readonly audit = new AuditRecorder()) {
    invariant(policy?.enabled === true && Number.isInteger(policy.revision) && policy.revision >= 1 && policy.revision <= 2_147_483_647, 'Explicit governance policy required');
    invariant(Number.isInteger(policy.minimumApprovals) && policy.minimumApprovals >= 1 && policy.minimumApprovals <= 20, 'Invalid governance quorum');
    invariant(Number.isInteger(policy.maximumPlanLifetimeMs) && policy.maximumPlanLifetimeMs >= 1000 && policy.maximumPlanLifetimeMs <= 7 * 86400_000, 'Invalid governance lifetime');
    invariant(Number.isInteger(policy.retentionDays) && policy.retentionDays >= 1 && policy.retentionDays <= 3650, 'Invalid governance retention');
    this.policy = Object.freeze({ enabled: true, revision: policy.revision, minimumApprovals: policy.minimumApprovals,
      maximumPlanLifetimeMs: policy.maximumPlanLifetimeMs, retentionDays: policy.retentionDays });
  }

  /** Snapshot a current owner's exact grant/revocation operations; request replay cannot change payload, policy or excluded recipients. */
  async proposePlan(trustedCaller: TrustedCallerContext, value: unknown): Promise<GovernancePlanResponseDto> {
    const caller = bindCaller(trustedCaller), input = parseProposePlanRequest(value);
    const facts = await this.authority.readCurrentFacts(caller, ownerOperation);
    return this.orm.em.fork().transactional(async em => {
      const evaluation = await this.authority.authorizeInTransaction(em, caller, ownerOperation, facts);
      invariant(evaluation.allowed, evaluation.allowed ? '' : evaluation.reason);
      const scope = { installationId: caller.installationId, guildId: caller.guildId };
      const identity = { ...scope, sourceRequestId: caller.sourceRequestId, sourceOperationKey: input.sourceOperationKey };
      const existing = await em.findOne(ActionPlan, identity, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (existing) {
        invariant(existing.requesterId === caller.actorId && canonical(existing.operations) === canonical(input.operations)
          && existing.expiresAt.toISOString() === input.expiresAt, 'Governance replay payload mismatch');
        this.validatePlan(existing, existing.planHash, false);
        return this.view(em, existing);
      }
      const now = new Date(), expiresAt = new Date(input.expiresAt);
      invariant(expiresAt > now && expiresAt.getTime() - now.getTime() <= this.policy.maximumPlanLifetimeMs, 'Plan expiry exceeds policy');
      for (const operation of input.operations) {
        if (operation.kind === 'grant_capability') {
          invariant(operation.expiresAt === null || new Date(operation.expiresAt) > expiresAt, 'Grant must remain valid throughout plan lifetime');
        } else {
          const grant = await em.findOne(CapabilityGrant, { ...scope, id: operation.grantId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
          invariant(grant && !grant.revokedAt && grant.authorityRevision === operation.expectedAuthorityRevision
            && grant.rowRevision === operation.expectedRowRevision, 'Stale or missing governed grant');
        }
      }
      const requirements = { minimumApprovals: this.policy.minimumApprovals, excludeRequester: true,
        excludedUserIds: [...new Set(input.operations.flatMap(operation => operation.kind === 'grant_capability' ? [operation.granteeUserId] : []))].sort() };
      const authorityBinding = copyJson({ policy: this.policy, requester: serializeAuthority(evaluation.authority) }) as unknown as JsonObject;
      const content = { schemaVersion: 1, ...identity, requesterId: caller.actorId, operations: input.operations,
        authorityBinding, approvalRequirements: requirements, expiresAt: input.expiresAt };
      const plan = new ActionPlan({ ...identity, requesterId: caller.actorId, operations: input.operations, authorityBinding,
        approvalRequirements: requirements, planHash: digest(content), expiresAt,
        purgeAfter: new Date(expiresAt.getTime() + this.policy.retentionDays * 86400_000), createdAt: now });
      em.persist(plan);
      await this.record(em, caller, 'governance.propose', plan.id, plan.rowRevision, now);
      return this.view(em, plan);
    });
  }

  /** Record one currently eligible, independently authenticated custodian's decision; requester and every grant recipient are excluded. */
  async approvePlan(trustedCaller: TrustedCallerContext, value: unknown): Promise<GovernancePlanResponseDto> {
    const caller = bindCaller(trustedCaller), input = parseApprovePlanRequest(value);
    const facts = await this.authority.readCurrentFacts(caller, custodianNativeOperation);
    return this.orm.em.fork().transactional(async em => {
      const binding = await this.custodianAuthority(em, caller, facts);
      invariant(binding, 'Current custodian authority required');
      const plan = await this.lockPlan(em, caller, input);
      invariant(plan.requesterId !== caller.actorId && !plan.approvalRequirements.excludedUserIds.includes(caller.actorId), 'Requester or candidate cannot approve');
      const scope = { installationId: caller.installationId, guildId: caller.guildId };
      const prior = await em.findOne(PlanApproval, { ...scope, planId: plan.id, approverId: caller.actorId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      if (prior) {
        invariant(prior.planHash === plan.planHash && prior.isCurrent(new Date())
          && canonical(prior.approverAuthorityBinding) === canonical(binding), 'Approval is stale or already withdrawn');
        return this.view(em, plan);
      }
      invariant(await em.count(PlanApproval, { ...scope, planId: plan.id }) < 100, 'Plan approval bound reached');
      const now = new Date();
      em.persist(new PlanApproval({ ...scope, planId: plan.id, planHash: plan.planHash, approverId: caller.actorId,
        approverAuthorityBinding: copyJson(binding) as unknown as JsonObject, approvedAt: now, expiresAt: plan.expiresAt,
        planExpiresAt: plan.expiresAt, purgeAfter: plan.purgeAfter, createdAt: now }));
      await this.record(em, caller, 'governance.approve', plan.id, plan.rowRevision, now);
      await em.flush();
      return this.view(em, plan);
    });
  }

  /** Recheck current owner, exact proposal, policy and distinct grant revisions, then consume once in the owning operation's transaction. */
  async consumeApproval(em: EntityManager, trustedCaller: TrustedCallerContext, value: unknown,
    current: GovernanceObservations): Promise<ApprovedPlanBinding> {
    invariant(em.isInTransaction(), 'Governance consumption requires the owner transaction');
    const caller = bindCaller(trustedCaller), input = parseApprovePlanRequest(value);
    const observations = { executor: copyFacts(current.executor), requester: copyFacts(current.requester), approvers: current.approvers.map(copyFacts) };
    const executor = await this.authority.authorizeInTransaction(em, caller, ownerOperation, observations.executor);
    invariant(executor.allowed, executor.allowed ? '' : executor.reason);
    const plan = await this.lockPlan(em, caller, input);
    const requester = requesterAuthority(plan);
    invariant(await this.authority.validateGrantRevision(em, requester, observations.requester), 'Proposal authority is stale');
    const approvals = await em.find(PlanApproval, { installationId: caller.installationId, guildId: caller.guildId, planId: plan.id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { approverId: 'asc' }, limit: 101 });
    invariant(approvals.length <= 100 && observations.approvers.length <= 100, 'Plan approval bound exceeded');
    const eligible: string[] = [];
    for (const approval of approvals) {
      if (!approval.isCurrent(new Date()) || approval.planHash !== plan.planHash || approval.approverId === plan.requesterId
        || plan.approvalRequirements.excludedUserIds.includes(approval.approverId)) continue;
      const bound = approval.approverAuthorityBinding as unknown as CustodianAuthority;
      const observed = observations.approvers.find(fact => fact.actorId === approval.approverId && fact.sourceRequestId === bound.caller?.sourceRequestId);
      if (!observed || bound.caller?.actorId !== approval.approverId || bound.caller?.installationId !== caller.installationId
        || bound.caller?.guildId !== caller.guildId) continue;
      const fresh = await this.custodianAuthority(em, bound.caller, observed);
      if (fresh && canonical(fresh) === canonical(bound)) eligible.push(approval.approverId);
    }
    const now = new Date(), consumptionReference = randomUUID();
    plan.consume({ planHash: input.planHash, eligibleApproverIds: eligible, consumptionReference, at: now });
    await this.record(em, caller, 'governance.consume', plan.id, plan.rowRevision, now);
    return { ...input, installationId: caller.installationId, guildId: caller.guildId, consumptionReference,
      operations: copyJson(parseGovernanceOperations(plan.operations)), requesterAuthority: requester };
  }

  /** Invite, independently accept, reject or complete one exact custodian grant; consent and approval consumption remain separate records. */
  async enrollCustodian(trustedCaller: TrustedCallerContext, value: unknown,
    acceptance?: VerifiedCandidateAcceptance): Promise<CustodianEnrollmentResponseDto> {
    const caller = bindCaller(trustedCaller), input = parseEnrollCustodianRequest(value);
    // The candidate is the caller on acceptance; a proposer-supplied assertion can never create consent.
    if (input.action === 'accept') {
      invariant(caller.actorId === input.candidateId, 'Only the authenticated candidate can accept');
      invariant(acceptance && canonical(bindCaller(acceptance.caller)) === canonical(caller)
        && acceptance.planId === input.planId && acceptance.planHash === input.planHash, 'Independent exact candidate acceptance required');
    } else invariant(acceptance === undefined, 'Unexpected candidate acceptance');
    const facts = await this.authority.readCurrentFacts(caller, input.action === 'accept' ? custodianNativeOperation : ownerOperation);
    const candidateCaller = { ...caller, actorId: input.candidateId, sourceRequestId: `candidate-current:${input.planId}` };
    const candidateFacts = input.action === 'complete' ? await this.authority.readCurrentFacts(candidateCaller, custodianNativeOperation) : undefined;
    const observations = input.action === 'complete' ? await readGovernanceObservations(this.orm, this.authority, caller, { planId: input.planId, planHash: input.planHash }) : undefined;
    return this.orm.em.fork().transactional(async em => {
      if (input.action === 'accept') {
        await this.lockScope(em, caller);
        invariant(this.nativePolicy.canExecute(caller, custodianNativeOperation, facts, new Date()) === null, 'Candidate must be a current native administrator');
      } else {
        const evaluation = await this.authority.authorizeInTransaction(em, caller, ownerOperation, facts);
        invariant(evaluation.allowed, evaluation.allowed ? '' : evaluation.reason);
      }
      const plan = await em.findOne(ActionPlan, { installationId: caller.installationId, guildId: caller.guildId, id: input.planId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      invariant(plan, 'Plan not found in installation');
      this.validatePlan(plan, input.planHash, false);
      const operations = parseGovernanceOperations(plan.operations), operation = operations[0]!;
      invariant(operations.length === 1 && operation.kind === 'grant_capability' && operation.capability === custodianCapability
        && operation.granteeUserId === input.candidateId, 'Enrollment does not match exact candidate plan');
      const scope = { installationId: caller.installationId, guildId: caller.guildId };
      let enrollment = await em.findOne(CustodianEnrollment, { ...scope, planId: plan.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
      const now = new Date();
      if (input.action === 'invite') {
        invariant(plan.status === 'pending' && now < plan.expiresAt && plan.requesterId === caller.actorId, 'Only the current proposer can invite');
        if (!enrollment) {
          enrollment = new CustodianEnrollment({ ...scope, candidateId: input.candidateId, proposerId: caller.actorId,
            sourceRequestId: plan.sourceRequestId, sourceOperationKey: `enroll:${plan.sourceOperationKey}`,
            proposedScope: { capability: custodianCapability, channelIds: [], targetUserIds: [], expiresAt: operation.expiresAt },
            governanceRevision: this.policy.revision, planId: plan.id, expiresAt: plan.expiresAt, purgeAfter: plan.purgeAfter, createdAt: now });
          em.persist(enrollment);
          await this.record(em, caller, 'governance.invite', enrollment.id, enrollment.rowRevision, now);
        }
      } else {
        invariant(enrollment && enrollment.candidateId === input.candidateId, 'Candidate invitation not found');
        if (input.action === 'accept') {
          invariant(plan.status === 'pending', 'Plan is no longer accepting consent');
          enrollment.recordAcceptance(caller.actorId, caller.sourceRequestId, now);
          await this.record(em, caller, 'governance.accept', enrollment.id, enrollment.rowRevision, now);
        } else if (input.action === 'reject') {
          enrollment.reject('owner_rejected', now);
          if (plan.status === 'pending') plan.invalidate('enrollment_rejected', now);
          await this.record(em, caller, 'governance.reject', enrollment.id, enrollment.rowRevision, now);
        } else if (enrollment.status !== 'completed') {
          invariant(enrollment.candidateAcceptedAt && enrollment.governanceRevision === this.policy.revision, 'Current candidate acceptance required');
          invariant(this.nativePolicy.canExecute(candidateCaller, custodianNativeOperation, candidateFacts!, new Date()) === null, 'Candidate must remain a native administrator');
          const binding = await this.consumeApproval(em, caller, { planId: input.planId, planHash: input.planHash }, observations!);
          const grant = new CapabilityGrant({ ...scope, grantee: { kind: 'user', userId: input.candidateId }, grantor: { kind: 'user', userId: caller.actorId },
            capability: custodianCapability, scope: { channelIds: [], targetUserIds: [] }, sourceRequestId: plan.id,
            sourceOperationKey: binding.consumptionReference, grantedAt: now, expiresAt: operation.expiresAt ? new Date(operation.expiresAt) : null, createdAt: now });
          em.persist(grant);
          enrollment.complete(grant.id, this.policy.revision, now);
          await this.record(em, caller, 'governance.enroll', enrollment.id, enrollment.rowRevision, now);
        }
      }
      invariant(enrollment, 'Enrollment not found');
      return { enrollmentId: enrollment.id, candidateId: enrollment.candidateId, planId: enrollment.planId,
        accepted: enrollment.candidateAcceptedAt !== null, status: enrollment.status, resultingGrantId: enrollment.resultingGrantId };
    });
  }

  /** Use the shared installation → safety gate before grants/plans so revocation, removal and concurrent approvals serialize. */
  private async lockScope(em: EntityManager, caller: TrustedCallerContext): Promise<{ installation: GuildInstallation; safety: GuildSafetyState }> {
    invariant(em.isInTransaction(), 'Governance requires a transaction');
    const installation = await em.findOne(GuildInstallation, { id: caller.installationId, guildId: caller.guildId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    invariant(installation?.state === 'active' && installation.discordAvailability === 'available', 'Installation unavailable');
    const safety = await em.findOne(GuildSafetyState, { installationId: caller.installationId, guildId: caller.guildId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    invariant(safety, 'Safety gate missing');
    return { installation, safety };
  }

  /** Eligibility requires native Administrator plus an explicit current guild-wide custodian grant; owner fallback does not create an approval. */
  private async custodianAuthority(em: EntityManager, trustedCaller: TrustedCallerContext, facts: CurrentNativeFacts): Promise<CustodianAuthority | null> {
    const caller = bindCaller(trustedCaller), { installation, safety } = await this.lockScope(em, caller);
    if (this.nativePolicy.canExecute(caller, custodianNativeOperation, facts, new Date()) !== null) return null;
    const grants = await em.find(CapabilityGrant, { installationId: caller.installationId, guildId: caller.guildId,
      grantee: { userId: caller.actorId }, capability: custodianCapability, revokedAt: null }, { lockMode: LockMode.PESSIMISTIC_WRITE, orderBy: { id: 'asc' } });
    const grant = grants.find(item => item.isCurrentFor({ userId: caller.actorId, capability: custodianCapability, at: new Date() }));
    return grant ? { caller, grantId: grant.id, grantRevision: grant.authorityRevision, grantRowRevision: grant.rowRevision,
      installationGeneration: installation.generation, installationRevision: installation.rowRevision, safetyRevision: safety.safetyRevision } : null;
  }

  /** Load only within the caller's installation and verify immutable content before treating the plan as pending authority. */
  private async lockPlan(em: EntityManager, caller: TrustedCallerContext, input: GovernancePlanReference): Promise<ActionPlan> {
    const plan = await em.findOne(ActionPlan, { installationId: caller.installationId, guildId: caller.guildId, id: input.planId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    invariant(plan, 'Plan not found in installation');
    this.validatePlan(plan, input.planHash, true);
    return plan;
  }

  /** Recompute a canonical hash over all authorization-bearing values; changed policy, operations or scope cannot reuse old approvals. */
  private validatePlan(plan: ActionPlan, hash: string, pending: boolean): void {
    invariant(plan.schemaVersion === 1 && plan.planHash === hash && plan.operations && plan.authorityBinding, 'Plan hash or schema mismatch');
    const operations = parseGovernanceOperations(plan.operations);
    invariant(canonical(operations) === canonical(plan.operations), 'Noncanonical plan operations');
    invariant(canonical(plan.authorityBinding.policy) === canonical(this.policy), 'Governance policy changed');
    invariant(digest({ schemaVersion: plan.schemaVersion, installationId: plan.installationId, guildId: plan.guildId,
      sourceRequestId: plan.sourceRequestId, sourceOperationKey: plan.sourceOperationKey, requesterId: plan.requesterId,
      operations, authorityBinding: plan.authorityBinding, approvalRequirements: plan.approvalRequirements,
      expiresAt: plan.expiresAt.toISOString() }) === hash, 'Plan content changed');
    invariant(!pending || (plan.status === 'pending' && new Date() < plan.expiresAt), 'Plan is not pending or has expired');
  }

  /** Report approval evidence counts, explicitly not a reusable authorization or a promise that the approvals remain eligible. */
  private async view(em: EntityManager, plan: ActionPlan): Promise<GovernancePlanResponseDto> {
    return { planId: plan.id, planHash: plan.planHash, installationId: plan.installationId, guildId: plan.guildId,
      operations: copyJson(parseGovernanceOperations(plan.operations)), expiresAt: plan.expiresAt.toISOString(),
      minimumApprovals: plan.approvalRequirements.minimumApprovals, status: plan.status,
      recordedApprovals: await em.count(PlanApproval, { installationId: plan.installationId, guildId: plan.guildId, planId: plan.id,
        withdrawnAt: null, invalidatedAt: null, expiresAt: { $gt: new Date() } }) };
  }

  /** Hash the replay key to stay within audit identity bounds without retaining request payloads. */
  private async record(em: EntityManager, caller: TrustedCallerContext, operation: string, recordId: string, revision: number, at: Date): Promise<void> {
    await this.audit.recordControlChange(em, { ...caller, sourceRequestId: digest({ source: caller.sourceRequestId, recordId }) }, operation,
      [{ owner: 'administration', recordId, revision }], at, this.policy.retentionDays);
  }
}

/** Gather native facts before opening the owner transaction; the locked consume step distrusts this preliminary record snapshot. */
export async function readGovernanceObservations(orm: MikroORM, authority: AuthorityService, trustedCaller: TrustedCallerContext,
  value: unknown): Promise<GovernanceObservations> {
  invariant(!orm.em.isInTransaction(), 'Governance native reads must run outside transactions');
  const caller = bindCaller(trustedCaller), reference = parseApprovePlanRequest(value), em = orm.em.fork();
  const executor = await authority.readCurrentFacts(caller, ownerOperation);
  const plan = await em.findOne(ActionPlan, { installationId: caller.installationId, guildId: caller.guildId, id: reference.planId, planHash: reference.planHash });
  invariant(plan, 'Plan not found in installation');
  const requester = requesterAuthority(plan);
  const approvals = await em.find(PlanApproval, { installationId: caller.installationId, guildId: caller.guildId, planId: plan.id,
    withdrawnAt: null, invalidatedAt: null, expiresAt: { $gt: new Date() } }, { orderBy: { approverId: 'asc' }, limit: 101 });
  invariant(approvals.length <= 100, 'Plan approval bound exceeded');
  const [requesterFacts, approverFacts] = await Promise.all([
    authority.readCurrentFacts(requester.caller, ownerOperation),
    Promise.all(approvals.map(approval => authority.readCurrentFacts(bindCaller((approval.approverAuthorityBinding as unknown as CustodianAuthority).caller), custodianNativeOperation))),
  ]);
  return { executor, requester: requesterFacts, approvers: approverFacts };
}

/** Detach the trusted ingress identity and reject invalid scope before awaiting a native or database boundary. */
function bindCaller(caller: TrustedCallerContext): TrustedCallerContext {
  assertDiscordId(caller.actorId); assertDiscordId(caller.guildId); assertUuid(caller.installationId);
  invariant(typeof caller.sourceRequestId === 'string' && caller.sourceRequestId.length > 0 && caller.sourceRequestId.length <= 200, 'Invalid source request identity');
  return Object.freeze({ actorId: caller.actorId, installationId: caller.installationId, guildId: caller.guildId, sourceRequestId: caller.sourceRequestId });
}

/** Serialize only the immutable authority snapshot; freshness is checked against newly read facts at consumption. */
function serializeAuthority(authority: StaffRequestAuthority): object { return { ...authority, observedAt: authority.observedAt.toISOString() }; }

/** Rehydrate the internal owner snapshot and bind it back to the exact installation, requester and proposal source. */
function requesterAuthority(plan: ActionPlan): StaffRequestAuthority {
  const stored = plan.authorityBinding?.requester as unknown as StaffRequestAuthority;
  invariant(stored && stored.purpose === 'operation' && stored.operation?.capability === 'administration.manage', 'Missing proposal authority');
  const caller = bindCaller(stored.caller);
  invariant(caller.actorId === plan.requesterId && caller.installationId === plan.installationId && caller.guildId === plan.guildId
    && caller.sourceRequestId === plan.sourceRequestId, 'Proposal authority scope mismatch');
  return { ...stored, caller, observedAt: new Date(stored.observedAt) };
}

/** Stable recursive key ordering makes database JSON key order irrelevant while array operation order remains part of the plan. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  invariant(value !== undefined && typeof value !== 'function' && typeof value !== 'symbol', 'Invalid canonical governance value');
  return JSON.stringify(value);
}

/** Digest canonical, validated values only; the digest is an exact-content binding, never a replacement for authority checks. */
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

/** Detach native observations explicitly so Dates preserve their local-realm validation and caller mutation cannot rewrite authorization. */
function copyFacts(facts: CurrentNativeFacts): CurrentNativeFacts {
  return { guildId: facts.guildId, actorId: facts.actorId, sourceRequestId: facts.sourceRequestId,
    operation: { ...facts.operation }, observedAt: new Date(facts.observedAt), complete: facts.complete,
    ownerId: facts.ownerId, actorIsMember: facts.actorIsMember, actorPermissions: facts.actorPermissions,
    botPermissions: facts.botPermissions, ...(facts.target ? { target: { ...facts.target } } : {}) };
}
