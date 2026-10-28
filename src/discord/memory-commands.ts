/** Parse the private memory command group into plain authenticated values; SDK tokens never cross this boundary. */
import { ApplicationCommandOptionType, type APIApplicationCommandSubcommandGroupOption } from 'discord.js';
import { assertDiscordId, assertUuid, invariant } from '../platform/db/entity-values.js';
import type { DiscordCommandIdentity } from './contracts.js';

export type NormalizedMemoryCommand = DiscordCommandIdentity & { readonly command: 'memory'; readonly arguments:
  | { readonly operation: 'consent'; readonly granted: boolean; readonly retentionDays: number; readonly expectedPrivacyRevision: number }
  | { readonly operation: 'remember'; readonly text: string; readonly expectedPrivacyRevision: number }
  | { readonly operation: 'inspect'; readonly query?: string; readonly offset: number }
  | { readonly operation: 'forget'; readonly factId?: string; readonly expectedPrivacyRevision: number } };

const revisionOption = { name: 'revision', description: 'Privacy revision shown by memory inspect',
  type: ApplicationCommandOptionType.Integer as const, required: true, min_value: 0, max_value: 2147483647 };
export const memoryCommandDefinition: APIApplicationCommandSubcommandGroupOption = {
  name: 'memory', description: 'Manage your own explicitly saved private memory', type: ApplicationCommandOptionType.SubcommandGroup,
  options: [
    { name: 'consent', description: 'Allow private memory or withdraw consent and erase saved facts', type: ApplicationCommandOptionType.Subcommand,
      options: [{ name: 'granted', description: 'Whether you permit private saved facts', type: ApplicationCommandOptionType.Boolean, required: true }, revisionOption,
        { name: 'days', description: 'Retention from 1 to 30 days; defaults to 30', type: ApplicationCommandOptionType.Integer, min_value: 1, max_value: 30 }] },
    { name: 'remember', description: 'Save only your exact private submission', type: ApplicationCommandOptionType.Subcommand,
      options: [{ name: 'text', description: 'Your private fact; never used as a credential', type: ApplicationCommandOptionType.String, required: true, min_length: 1, max_length: 500 }, revisionOption] },
    { name: 'inspect', description: 'Privately inspect or search your own saved facts', type: ApplicationCommandOptionType.Subcommand,
      options: [{ name: 'query', description: 'Optional literal text to find in your own facts', type: ApplicationCommandOptionType.String, max_length: 100 },
        { name: 'offset', description: 'Next offset shown by a previous private page', type: ApplicationCommandOptionType.Integer, min_value: 0, max_value: 50 }] },
    { name: 'forget', description: 'Erase one fact, or every fact when no fact ID is provided', type: ApplicationCommandOptionType.Subcommand,
      options: [revisionOption, { name: 'fact-id', description: 'Exact fact identifier from your private inspection', type: ApplicationCommandOptionType.String, min_length: 36, max_length: 36 }] },
  ],
};

/** Require one recognized nested subcommand and its exact option allowlist; malformed input returns a private validation error. */
export function normalizeMemoryCommand(identity: DiscordCommandIdentity, value: unknown): NormalizedMemoryCommand | null {
  try {
    for (const id of [identity.actorId, identity.guildId, identity.channelId, identity.sourceRequestId]) assertDiscordId(id);
    invariant(value !== null && typeof value === 'object', 'Missing memory command');
    const group = value as { name?: unknown; type?: unknown; value?: unknown; options?: unknown };
    invariant(group.name === 'memory' && group.type === 2 && group.value === undefined && Array.isArray(group.options) && group.options.length === 1, 'Invalid memory group');
    const command = group.options[0] as { name?: unknown; type?: unknown; value?: unknown; options?: unknown };
    invariant(command && command.type === 1 && command.value === undefined && typeof command.name === 'string', 'Invalid memory operation');
    const allowlist: Record<string, string[]> = { consent: ['granted', 'revision', 'days'], remember: ['text', 'revision'], inspect: ['query', 'offset'], forget: ['revision', 'fact-id'] };
    invariant(Object.hasOwn(allowlist, command.name), 'Unknown memory operation');
    const supplied = command.options ?? []; invariant(Array.isArray(supplied) && supplied.length <= 3, 'Too many memory options');
    const options = new Map<string, { type: number; value: unknown }>();
    for (const item of supplied) {
      invariant(item && typeof item === 'object' && typeof item.name === 'string' && allowlist[command.name]!.includes(item.name)
        && item.options === undefined && !options.has(item.name), 'Invalid memory option');
      options.set(item.name, { type: item.type, value: item.value });
    }
    /** Read one allowlisted option with its Discord type and explicit scalar bounds. */
    const read = (name: string, type: number, minimum = 0, maximum = 2147483647): string | number | boolean => {
      const option = options.get(name); invariant(option?.type === type, 'Missing memory option');
      if (type === 4) invariant(typeof option.value === 'number' && Number.isInteger(option.value) && option.value >= minimum && option.value <= maximum, 'Invalid memory integer');
      else if (type === 5) invariant(typeof option.value === 'boolean', 'Invalid memory consent');
      else invariant(typeof option.value === 'string' && option.value.length >= minimum && option.value.length <= maximum && !option.value.includes('\0'), 'Invalid memory text');
      return option.value as string | number | boolean;
    };
    let args: NormalizedMemoryCommand['arguments'];
    switch (command.name) {
      case 'consent': args = { operation: 'consent', granted: read('granted', 5) as boolean, expectedPrivacyRevision: read('revision', 4) as number,
        retentionDays: options.has('days') ? read('days', 4, 1, 30) as number : 30 }; break;
      case 'remember': args = { operation: 'remember', text: read('text', 3, 1, 500) as string, expectedPrivacyRevision: read('revision', 4) as number };
        invariant(args.text.trim().length > 0, 'Empty memory text'); break;
      case 'inspect': args = { operation: 'inspect', ...(options.has('query') ? { query: read('query', 3, 0, 100) as string } : {}),
        offset: options.has('offset') ? read('offset', 4, 0, 50) as number : 0 }; break;
      default: {
        const factId = options.has('fact-id') ? read('fact-id', 3, 36, 36) as string : undefined; if (factId) assertUuid(factId);
        args = { operation: 'forget', expectedPrivacyRevision: read('revision', 4) as number, ...(factId ? { factId } : {}) };
      }
    }
    return Object.freeze({ actorId: identity.actorId, guildId: identity.guildId, channelId: identity.channelId, sourceRequestId: identity.sourceRequestId,
      command: 'memory', arguments: Object.freeze(args) });
  } catch { return null; }
}
