/** Route authenticated Discord commands to owners; transport tokens, database entities and raw errors stay private. */
import type { DiscordCommandResponse, NormalizedAdministrationCommand } from '../../src/discord/contracts.js';
import type { InstallationScope } from '../../src/contexts/administration/guild-lifecycle.service.js';
import type { AuthorityService } from '../../src/contexts/administration/authority.service.js';
import type { SafetyService } from '../../src/contexts/administration/safety.service.js';
import type { ConfigurationService, OperatorStatus } from '../../src/contexts/administration/configuration.service.js';
import type { RemovalService } from '../../src/contexts/administration/removal.service.js';
import type { StaffModerationService } from '../../src/contexts/moderation/staff-moderation.service.js';
import type { ModerationService } from '../../src/contexts/moderation/moderation.service.js';
import type { KnowledgeService } from '../../src/contexts/community/knowledge.service.js';
import type { KnowledgeEntryDto } from '../../src/contexts/community/dto/knowledge.dto.js';
import type { MemoryService } from '../../src/contexts/memory/memory.service.js';
import { handleMemoryCommand } from './memory.handlers.js';
import { handleDebateCommand, type DebateCommands } from './debate.handlers.js';
import type { UserUsageService, UserUsageStatus } from '../../src/platform/usage/user-usage.service.js';
import { loadPolicyConfig } from '../../src/platform/config/policy-config.js';

export interface AdministrationCommands {
  scope: InstallationScope;
  authority: Pick<AuthorityService, 'bootstrapOwner' | 'grantCapability' | 'revokeGrant'>;
  safety: Pick<SafetyService, 'pauseGuild' | 'resumeGuild'>;
  configuration: Pick<ConfigurationService, 'status' | 'applyConfiguration' | 'updateChannelSettings'>
    & Partial<Pick<ConfigurationService, 'readChannelSettings'>>;
  removal: Pick<RemovalService, 'beginRemoval'>;
  staffModeration?: Pick<StaffModerationService, 'requestBan' | 'requestUnban' | 'requestKick' | 'readActionStatus'>;
  moderation?: Pick<ModerationService, 'ingestReport'>;
  knowledge?: Pick<KnowledgeService, 'approveEntry' | 'changeVisibility' | 'retireEntry' | 'readEntry' | 'searchEntries'>;
  memory?: Pick<MemoryService, 'setConsent' | 'remember' | 'inspectOwnFacts' | 'forget'>;
  debates?: DebateCommands;
  debateAssessmentAvailable?: boolean;
  userUsage?: Pick<UserUsageService, 'readStatus' | 'setLimit' | 'clearLimit'>;
  policyFile?: string;
  onConfigurationApplied?: () => void;
}

/** Format bounded operational fields explicitly; adding a service field cannot accidentally disclose it. */
function statusText(status: OperatorStatus): string {
  const grants = status.grants.slice(0, 8).map(grant => `${grant.grantId}: ${grant.capability}; authority=${grant.authorityRevision}; row=${grant.rowRevision}; ${grant.revoked ? 'revoked' : 'active'}`);
  return [`Installation: ${status.installationId}; ${status.installationState}; revision ${status.installationRevision}`,
    `Safety: ${status.paused ? 'paused' : 'running'}; revision ${status.safetyRevision}`,
    `Configuration: ${status.policyRevision}; usage policy: ${status.usagePolicyRevision ?? 'missing'}`,
    `Community: ${status.featureAdmission.community ?? 'disabled'}; moderation: ${status.featureAdmission.moderation ?? 'disabled'}`,
    `Pending requests: ${status.pendingRequests}; ready replies: ${status.readyDeliveries}; uncertain sends: ${status.unknownDeliveries}`,
    ...Object.entries(status.cleanupProgress).map(([owner, progress]) => `Cleanup ${owner}: ${progress.disposition}`),
    ...(grants.length ? ['Recent grants (up to 8):', ...grants] : [])].join('\n').slice(0, 1900);
}

/** Self-service responses explicitly select bounded quota facts and disclose no other user's accounting. */
function usageText(status: UserUsageStatus): string {
  return JSON.stringify({ windowStart: status.windowStart, windowEnd: status.windowEnd, attemptsUsed: status.attemptsUsed,
    attemptLimit: status.attemptLimit, attemptsRemaining: status.attemptsRemaining, dailyBudget: status.dailyBudget,
    committedAmount: status.committedAmount, unknownCostAttempts: status.unknownCostAttempts, personalLimit: status.personalLimit,
    blockedReason: status.blockedReason }).slice(0, 1900);
}

/** Show the revision needed for later edits without echoing provenance, actor IDs or unbounded approved content. */
function knowledgeText(entry: KnowledgeEntryDto): string {
  return `Knowledge ${entry.entryId}; revision ${entry.rowRevision}; ${entry.retiredAt ? 'retired' : 'approved'}; audience ${entry.visibility.kind}.\n`
    + `Expires ${entry.purgeAfter}.\n${entry.content?.slice(0, 1500) ?? '[content erased]'}`;
}

/** The gateway supplies verified actor/guild/request IDs; the running installation supplies its own identity. */
export async function handleAdministrationCommand(command: NormalizedAdministrationCommand, services: AdministrationCommands): Promise<DiscordCommandResponse> {
  if (command.guildId !== services.scope.guildId) return 'This command does not belong to this installation.';
  const caller = Object.freeze({ ...services.scope, actorId: command.actorId, sourceRequestId: command.sourceRequestId });
  try {
    switch (command.command) {
      case 'debate': return services.debates ? handleDebateCommand(command, { scope: services.scope, debates: services.debates,
        canEvaluate: services.debateAssessmentAvailable }) : 'Debates are unavailable.';
      case 'memory': return services.memory ? handleMemoryCommand(command, { scope: services.scope, memory: services.memory }) : 'Private memory is unavailable.';
      case 'knowledge-approve': case 'knowledge-visibility': case 'knowledge-retire': case 'knowledge-read': case 'knowledge-search': {
        if (!services.knowledge) return 'Approved knowledge is unavailable.';
        if (command.command === 'knowledge-search') {
          const entries = await services.knowledge.searchEntries(caller, command.arguments);
          return entries.length ? entries.map(entry => `${entry.entryId}; revision ${entry.rowRevision}: ${entry.content?.slice(0, 240) ?? '[erased]'}`).join('\n').slice(0, 1900) : 'No approved reference material matches in this channel.';
        }
        const entry = command.command === 'knowledge-approve' ? await services.knowledge.approveEntry(caller, command.arguments)
          : command.command === 'knowledge-visibility' ? await services.knowledge.changeVisibility(caller, command.arguments)
            : command.command === 'knowledge-retire' ? await services.knowledge.retireEntry(caller, command.arguments)
              : await services.knowledge.readEntry(caller, command.arguments.entryId);
        return knowledgeText(entry);
      }
      case 'usage': case 'limit': case 'limit-clear': {
        if (!services.userUsage) return 'Personal usage controls are unavailable.';
        const status = command.command === 'usage' ? await services.userUsage.readStatus(caller)
          : command.command === 'limit' ? await services.userUsage.setLimit(caller, command.arguments) : await services.userUsage.clearLimit(caller);
        return usageText(status);
      }
      case 'action': {
        if (!services.staffModeration) return 'Staff moderation is unavailable.';
        const action = await services.staffModeration.readActionStatus(caller, command.arguments.actionId);
        return `Action ${action.actionId}: ${action.kind}; ${action.state}; ${action.reasonCode ?? 'awaiting dispatch'}. Unresolved: ${action.unresolved}.`;
      }
      case 'ban': case 'unban': case 'kick': {
        if (!services.staffModeration) return 'Staff moderation is unavailable.';
        const action = command.command === 'ban' ? await services.staffModeration.requestBan(caller, command.arguments)
          : command.command === 'kick' ? await services.staffModeration.requestKick(caller, command.arguments)
            : await services.staffModeration.requestUnban(caller, command.arguments);
        return `Moderation request ${action.actionId}: ${action.kind}; ${action.state}. This is the recorded workflow state; Discord execution is reported separately.`;
      }
      case 'report': {
        if (!services.moderation) return 'Moderation intake is unavailable.';
        const result = await services.moderation.ingestReport(caller, command.arguments);
        return result.status === 'ignored' ? 'Moderation intake is not enabled for this installation.'
          : `Report recorded for case ${result.case.caseId}; ${result.case.phase}; ${result.case.disposition ?? 'pending'}. A report alone does not establish a violation.`;
      }
      case 'bootstrap': {
        const grant = await services.authority.bootstrapOwner(caller);
        return `Owner enrollment ${grant.revoked ? 'is revoked' : 'is ready'}. Grant: ${grant.grantId}; authority revision ${grant.authorityRevision}; row revision ${grant.rowRevision}.`;
      }
      case 'status': return statusText(await services.configuration.status(caller));
      case 'configure': {
        const status = await services.configuration.status(caller);
        const settings = await loadPolicyConfig(services.policyFile);
        const result = await services.configuration.applyConfiguration(caller, settings, status.policyRevision);
        services.onConfigurationApplied?.();
        return `Configuration ${result.changed ? 'applied' : 'already current'}. Policy revision ${result.policyRevision}; usage revision ${result.usagePolicyRevision}.`;
      }
      case 'grant': {
        const grant = await services.authority.grantCapability(caller, command.arguments);
        return `Grant: ${grant.grantId}; authority revision ${grant.authorityRevision}; row revision ${grant.rowRevision}.`;
      }
      case 'revoke': {
        const grant = await services.authority.revokeGrant(caller, command.arguments);
        return `Grant ${grant.grantId} revoked; authority revision ${grant.authorityRevision}; row revision ${grant.rowRevision}.`;
      }
      case 'pause': case 'resume': {
        const result = command.command === 'pause' ? await services.safety.pauseGuild(caller, command.arguments)
          : await services.safety.resumeGuild(caller, command.arguments);
        return `Yuna ${result.paused ? 'paused' : 'resumed'}; safety revision ${result.safetyRevision}.`;
      }
      case 'channel-status': {
        if (!services.configuration.readChannelSettings) return 'Channel settings inspection is unavailable.';
        const result = await services.configuration.readChannelSettings(caller, command.arguments);
        return `Channel ${result.channelId}: ${result.mode}; row revision ${result.rowRevision}.`;
      }
      case 'channel': {
        const result = await services.configuration.updateChannelSettings(caller, command.arguments);
        return `Channel ${result.channelId}: ${result.mode}; row revision ${result.rowRevision}.`;
      }
      case 'remove': {
        const result = await services.removal.beginRemoval(caller, command.arguments.expectedInstallationRevision);
        return `Installation removal admitted; state ${result.state}, revision ${result.installationRevision}. Pending effects and accounting retain their recorded disposition.`;
      }
    }
  } catch {
    // Provider/SQL/SDK errors can contain content or credentials. Operators receive no raw error text.
    return 'The command was not applied. Check your current permissions, configuration and revisions with /yuna status, then retry.';
  }
}
