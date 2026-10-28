/** Discord's knowledge command group exposes bounded arguments; authenticated identity is supplied by Gateway ingress. */
import { ApplicationCommandOptionType, type APIApplicationCommandSubcommandGroupOption } from 'discord.js';
import { assertDiscordId, assertUuid, invariant } from '../platform/db/entity-values.js';
import type { DiscordCommandIdentity } from './contracts.js';
import type { AdministrationCommandSnapshot } from './input-normalizer.js';

type Visibility = { schemaVersion: 1; kind: 'guild' } | { schemaVersion: 1; kind: 'channels'; channelIds: string[] };
export type NormalizedKnowledgeCommand = DiscordCommandIdentity & (
  | { command: 'knowledge-approve'; arguments: { content: string; provenance: { kind: 'staff_submission'; sourceReference: string }; visibility: Visibility;
      predecessor?: { entryId: string; expectedRowRevision: number } } }
  | { command: 'knowledge-visibility'; arguments: { entryId: string; expectedRowRevision: number; visibility: Visibility } }
  | { command: 'knowledge-retire'; arguments: { entryId: string; expectedRowRevision: number; reasonCode: string } }
  | { command: 'knowledge-read'; arguments: { entryId: string } }
  | { command: 'knowledge-search'; arguments: { search: string; channelId: string } }
);

/** Registration is static data; updating Discord commands remains an explicit operator action. */
export const knowledgeCommandDefinition: APIApplicationCommandSubcommandGroupOption = {
  name: 'knowledge', description: 'Manage approved server reference material', type: ApplicationCommandOptionType.SubcommandGroup,
  options: [
    { name: 'approve', description: 'Approve exact reference text for an explicit audience', type: ApplicationCommandOptionType.Subcommand, options: [
      { name: 'content', description: 'Exact approved text, retained under server policy', type: ApplicationCommandOptionType.String, required: true, max_length: 4000 },
      { name: 'visibility', description: 'Audience; defaults to this channel', type: ApplicationCommandOptionType.String, choices: [{ name: 'This channel', value: 'channel' }, { name: 'Entire guild', value: 'guild' }] },
      { name: 'source', description: 'Bounded provenance reference', type: ApplicationCommandOptionType.String, max_length: 512 },
      { name: 'replaces', description: 'Optional predecessor entry ID; requires revision', type: ApplicationCommandOptionType.String, min_length: 36, max_length: 36 },
      { name: 'revision', description: 'Expected predecessor revision; requires replaces', type: ApplicationCommandOptionType.Integer, min_value: 1, max_value: 2147483647 },
    ] },
    { name: 'visibility', description: 'Change the audience without changing approved text', type: ApplicationCommandOptionType.Subcommand, options: [
      { name: 'entry', description: 'Knowledge entry ID', type: ApplicationCommandOptionType.String, required: true, min_length: 36, max_length: 36 },
      { name: 'revision', description: 'Current entry revision', type: ApplicationCommandOptionType.Integer, required: true, min_value: 1, max_value: 2147483647 },
      { name: 'visibility', description: 'New audience', type: ApplicationCommandOptionType.String, required: true, choices: [{ name: 'This channel', value: 'channel' }, { name: 'Entire guild', value: 'guild' }] },
    ] },
    { name: 'retire', description: 'Exclude an entry and cancel its pending uses', type: ApplicationCommandOptionType.Subcommand, options: [
      { name: 'entry', description: 'Knowledge entry ID', type: ApplicationCommandOptionType.String, required: true, min_length: 36, max_length: 36 },
      { name: 'revision', description: 'Current entry revision', type: ApplicationCommandOptionType.Integer, required: true, min_value: 1, max_value: 2147483647 },
      { name: 'reason', description: 'Short reason code; letters, digits, underscores or hyphens', type: ApplicationCommandOptionType.String, required: true, max_length: 120 },
    ] },
    { name: 'read', description: 'Inspect an entry and its current revision privately', type: ApplicationCommandOptionType.Subcommand, options: [
      { name: 'entry', description: 'Knowledge entry ID', type: ApplicationCommandOptionType.String, required: true, min_length: 36, max_length: 36 },
    ] },
    { name: 'search', description: 'Find approved material visible in this channel', type: ApplicationCommandOptionType.Subcommand, options: [
      { name: 'query', description: 'Words to match in approved text', type: ApplicationCommandOptionType.String, required: true, max_length: 256 },
    ] },
  ],
};

/** Parse one nested knowledge subcommand, rejecting extra options and caller-supplied identity fields. */
export function normalizeKnowledgeCommand(source: AdministrationCommandSnapshot): NormalizedKnowledgeCommand | null {
  try {
    for (const id of [source.actorId, source.guildId, source.channelId, source.sourceRequestId]) assertDiscordId(id);
    invariant(source.commandName === 'yuna' && !source.actorIsBot && source.options.length === 1, 'Invalid command ingress');
    const group = source.options[0]!;
    invariant(group.name === 'knowledge' && group.type === 2 && group.value === undefined && Array.isArray(group.options) && group.options.length === 1, 'Invalid knowledge group');
    const command = group.options[0]!;
    invariant(command.type === 1 && command.value === undefined && ['approve', 'visibility', 'retire', 'read', 'search'].includes(command.name), 'Invalid knowledge command');
    const raw = command.options ?? [];
    invariant(Array.isArray(raw) && raw.length <= 5, 'Invalid knowledge options');
    const values = new Map<string, { type: number; value?: unknown }>();
    const allowed: Record<string, string[]> = { approve: ['content', 'visibility', 'source', 'replaces', 'revision'],
      visibility: ['entry', 'revision', 'visibility'], retire: ['entry', 'revision', 'reason'], read: ['entry'], search: ['query'] };
    for (const option of raw) {
      invariant(option && typeof option === 'object' && !Array.isArray(option), 'Invalid option');
      const entry = option as { name: string; type: number; value?: unknown; options?: unknown };
      invariant(allowed[command.name]!.includes(entry.name) && !values.has(entry.name) && entry.options === undefined, 'Unknown or duplicate option'); values.set(entry.name, entry);
    }
    const identity = { actorId: source.actorId, guildId: source.guildId, channelId: source.channelId, sourceRequestId: source.sourceRequestId };
    /** Bind a channel-scoped approval to the authenticated command channel; widening must be an explicit choice. */
    const visibility = (): Visibility => {
      const selected = values.has('visibility') ? text(values, 'visibility', 10) : 'channel';
      invariant(selected === 'guild' || selected === 'channel', 'Invalid visibility');
      return selected === 'guild' ? { schemaVersion: 1, kind: 'guild' } : { schemaVersion: 1, kind: 'channels', channelIds: [source.channelId] };
    };
    /** Require an exact record ID before sending an inspection or mutation to its owner. */
    const entryId = (): string => { const id = text(values, 'entry', 36); assertUuid(id); return id; };
    if (command.name === 'approve') {
      const content = text(values, 'content', 4000), predecessorId = values.has('replaces') ? text(values, 'replaces', 36) : undefined;
      invariant((predecessorId !== undefined) === values.has('revision'), 'Replacement needs exact revision');
      if (predecessorId) assertUuid(predecessorId);
      return Object.freeze({ ...identity, command: 'knowledge-approve', arguments: { content,
        provenance: { kind: 'staff_submission' as const, sourceReference: values.has('source') ? text(values, 'source', 512) : `discord-command:${source.sourceRequestId}` },
        visibility: visibility(), ...(predecessorId ? { predecessor: { entryId: predecessorId, expectedRowRevision: revision(values) } } : {}) } });
    }
    if (command.name === 'read') return Object.freeze({ ...identity, command: 'knowledge-read', arguments: { entryId: entryId() } });
    if (command.name === 'search') return Object.freeze({ ...identity, command: 'knowledge-search', arguments: { search: text(values, 'query', 256), channelId: source.channelId } });
    if (command.name === 'visibility') {
      invariant(values.has('visibility'), 'Missing visibility');
      return Object.freeze({ ...identity, command: 'knowledge-visibility', arguments: { entryId: entryId(), expectedRowRevision: revision(values), visibility: visibility() } });
    }
    const reasonCode = text(values, 'reason', 120); invariant(/^[a-zA-Z0-9_.:-]+$/.test(reasonCode), 'Invalid retirement reason');
    return Object.freeze({ ...identity, command: 'knowledge-retire', arguments: { entryId: entryId(), expectedRowRevision: revision(values), reasonCode } });
  } catch { return null; }
}

/** Accept only bounded strings with Discord's expected option type. */
function text(values: ReadonlyMap<string, { type: number; value?: unknown }>, name: string, maximum: number): string {
  const entry = values.get(name); invariant(entry?.type === 3 && typeof entry.value === 'string' && entry.value.trim().length > 0 && entry.value.length <= maximum, 'Invalid knowledge text'); return entry.value;
}
/** Revisions must be exact positive database integers; missing or fractional values cannot authorize writes. */
function revision(values: ReadonlyMap<string, { type: number; value?: unknown }>): number {
  const entry = values.get('revision'); invariant(entry?.type === 4 && Number.isInteger(entry.value) && (entry.value as number) >= 1 && (entry.value as number) <= 2147483647, 'Invalid knowledge revision'); return entry.value as number;
}
