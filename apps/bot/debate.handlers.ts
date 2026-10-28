/** Route participant-owned Debate actions and attach full reviewable scopes/results to private Discord responses. */
import type { DebateService } from '../../src/contexts/debates/debate.service.js';
import type { DebateSessionResponseDto } from '../../src/contexts/debates/dto/debate-session.dto.js';
import type { InstallationScope } from '../../src/contexts/administration/guild-lifecycle.service.js';
import type { NormalizedDebateCommand } from '../../src/discord/debate-commands.js';
import type { DiscordCommandResponse } from '../../src/discord/contracts.js';

export type DebateCommands = Pick<DebateService, 'proposeSession' | 'recordConsent' | 'startSession' | 'appendEntry' | 'freezeTranscript' | 'readSession' | 'readResult' | 'cancelSession'>;

/** Bind authenticated identity to the running installation; no command can accept for the other participant. */
export async function handleDebateCommand(command: NormalizedDebateCommand,
  services: { scope: InstallationScope; debates: DebateCommands; canEvaluate?: boolean }): Promise<DiscordCommandResponse> {
  if (command.guildId !== services.scope.guildId) return 'This Debate request belongs to another installation.';
  const caller = { ...services.scope, actorId: command.actorId, sourceRequestId: command.sourceRequestId };
  try {
    const args = command.arguments;
    if (services.canEvaluate === false && (['propose', 'start', 'submit', 'freeze'].includes(args.operation)
      || (args.operation === 'consent' && args.accept))) return 'Debate assessment is unavailable. Existing sessions can still be inspected, canceled or withdrawn.';
    if (args.operation === 'propose') {
      const { operation: _operation, ...input } = args;
      return scopeReview(await services.debates.proposeSession(caller, { ...input, channelId: command.channelId }));
    }
    if (args.operation === 'submit') {
      const result = await services.debates.appendEntry(caller, { sessionId: args.sessionId, text: args.text });
      return `Debate submission ${result.sequence} recorded as ${result.entryId}. Only your explicitly submitted text was captured.`;
    }
    if (args.operation === 'result') {
      const result = await services.debates.readResult(caller, { sessionId: args.sessionId });
      return { content: `Debate ${result.sessionId}: ${result.outcome?.kind ?? 'unavailable'}; publication ${result.publicationState}. Complete rubric results are attached. Scores confer no permissions or moderation consequences.`,
        attachment: { filename: 'debate-result.json', content: JSON.stringify(result, null, 2) } };
    }
    const value = { sessionId: args.sessionId };
    const state = args.operation === 'consent' ? await services.debates.recordConsent(caller, { ...value, scopeHash: args.scopeHash, accept: args.accept })
      : args.operation === 'start' ? await services.debates.startSession(caller, value)
        : args.operation === 'freeze' ? await services.debates.freezeTranscript(caller, value)
          : args.operation === 'cancel' ? await services.debates.cancelSession(caller, value) : await services.debates.readSession(caller, value);
    return scopeReview(state);
  } catch { return 'Debate request was not applied. Review the current session, participant consent and server availability, then retry.'; }
}

/** Attach every rubric level and exact scope field; the concise response never substitutes for the complete consent review. */
function scopeReview(state: DebateSessionResponseDto): DiscordCommandResponse {
  return { content: `Debate ${state.sessionId}: ${state.state}. Publication channel ${state.channelId}; expires ${state.purgeAfter}.\n`
      + `Scope hash: ${state.scopeHash}\nRead the full attached scope before consenting. It includes participants, the paying initiator, topic, model, rubric, retention and publication audience. Each participant must consent independently.`,
    attachment: { filename: 'debate-scope.json', content: JSON.stringify({ ...state,
      collection: 'Only explicit participant submissions; no channel history, edits or deleted messages are collected.',
      publication: 'Accepted rubric totals and limitations are published to the named channel. Scores confer no permissions or moderation consequences.',
      withdrawal: 'Either participant may withdraw consent or cancel. Retained payloads are erased; an already sent publication cannot be recalled by cancellation.',
    }, null, 2) } };
}
