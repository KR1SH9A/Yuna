/** Format only authenticated self-memory operations; the Discord gateway always responds ephemerally. */
import type { MemoryService } from '../../src/contexts/memory/memory.service.js';
import type { InstallationScope } from '../../src/contexts/administration/guild-lifecycle.service.js';
import type { NormalizedMemoryCommand } from '../../src/discord/memory-commands.js';

/** Bind the installation in composition and strip the transport operation selector before calling the owner. */
export async function handleMemoryCommand(command: NormalizedMemoryCommand,
  services: { scope: InstallationScope; memory: Pick<MemoryService, 'setConsent' | 'remember' | 'inspectOwnFacts' | 'forget'> }): Promise<string> {
  if (command.guildId !== services.scope.guildId) return 'This memory request belongs to another installation.';
  const caller = { ...services.scope, actorId: command.actorId, sourceRequestId: command.sourceRequestId };
  try {
    switch (command.arguments.operation) {
      case 'consent': {
        const { operation: _operation, ...input } = command.arguments;
        const state = await services.memory.setConsent(caller, input);
        return `Private memory consent: ${state.granted ? 'enabled' : 'withdrawn'}; retention ${state.retentionDays} days; privacy revision ${state.privacyRevision}. Erased facts: ${state.erasedFacts}.`;
      }
      case 'remember': {
        const { operation: _operation, ...input } = command.arguments;
        const fact = await services.memory.remember(caller, input);
        return `Private fact ${fact.factId} ${fact.duplicate ? 'already saved' : 'saved'}; expires ${fact.expiresAt}; privacy revision ${fact.privacyRevision}.`;
      }
      case 'forget': {
        const { operation: _operation, ...input } = command.arguments;
        const result = await services.memory.forget(caller, input);
        return `Erased ${result.erasedFacts} private facts; deletion ${result.deletionId} complete; privacy revision ${result.privacyRevision}.`;
      }
      case 'inspect': {
        const { operation: _operation, ...input } = command.arguments;
        const result = await services.memory.inspectOwnFacts(caller, input);
        return [`Private memory: ${result.granted ? 'enabled' : 'off'}; privacy revision ${result.privacyRevision}; retention ${result.retentionDays} days.`,
          ...result.facts.map(fact => `${fact.factId} (expires ${fact.expiresAt}):\n${fact.text}`),
          result.nextOffset === null ? 'No further matching facts.' : `Next offset: ${result.nextOffset}.`].join('\n').slice(0, 1900);
      }
    }
  } catch { return 'Memory request was not applied. Inspect your own memory for the current privacy revision and retry.'; }
}
