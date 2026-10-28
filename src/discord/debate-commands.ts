/** Normalize explicit Debate actions without letting options supply actor identity, model choices or consent for anyone else. */
import { ApplicationCommandOptionType, type APIApplicationCommandSubcommandGroupOption } from 'discord.js';
import { assertDiscordId, assertUuid, invariant } from '../platform/db/entity-values.js';
import type { DiscordCommandIdentity } from './contracts.js';

export type NormalizedDebateCommand = DiscordCommandIdentity & { readonly command: 'debate'; readonly arguments:
  | { readonly operation: 'propose'; readonly opponentUserId: string; readonly topic: string; readonly rubric: unknown; readonly retentionSeconds: number }
  | { readonly operation: 'consent'; readonly sessionId: string; readonly scopeHash: string; readonly accept: boolean }
  | { readonly operation: 'submit'; readonly sessionId: string; readonly text: string }
  | { readonly operation: 'start' | 'freeze' | 'status' | 'result' | 'cancel'; readonly sessionId: string } };

const sessionOption = { name: 'session', description: 'Exact Debate session ID', type: ApplicationCommandOptionType.String as const,
  required: true, min_length: 36, max_length: 36 };
export const debateCommandDefinition: APIApplicationCommandSubcommandGroupOption = {
  name: 'debate', description: 'Propose, consent to and evaluate explicitly submitted arguments', type: ApplicationCommandOptionType.SubcommandGroup,
  options: [
    { name: 'propose', description: 'Propose a Debate and publication in this text channel', type: ApplicationCommandOptionType.Subcommand, options: [
      { name: 'opponent', description: 'Other participant; they must consent separately', type: ApplicationCommandOptionType.User, required: true },
      { name: 'topic', description: 'Exact topic both participants will review', type: ApplicationCommandOptionType.String, required: true, min_length: 1, max_length: 500 },
      { name: 'rubric', description: 'Complete JSON scoring rubric, including levels, weights and uncertainty thresholds', type: ApplicationCommandOptionType.String, required: true, min_length: 2, max_length: 4000 },
      { name: 'retention-seconds', description: 'Payload retention; from 300 seconds up to server policy (at most 604800)', type: ApplicationCommandOptionType.Integer, required: true, min_value: 300, max_value: 604800 },
    ] },
    { name: 'consent', description: 'Accept the exact reviewed scope, or withdraw and erase it', type: ApplicationCommandOptionType.Subcommand, options: [sessionOption,
      { name: 'scope-hash', description: 'Exact scope hash shown by Debate status after reviewing its full attachment', type: ApplicationCommandOptionType.String, required: true, min_length: 64, max_length: 64 },
      { name: 'accept', description: 'Accept for yourself; false withdraws your consent', type: ApplicationCommandOptionType.Boolean, required: true }] },
    { name: 'start', description: 'Start after both participants have independently consented', type: ApplicationCommandOptionType.Subcommand, options: [sessionOption] },
    { name: 'submit', description: 'Submit only your own explicit argument', type: ApplicationCommandOptionType.Subcommand, options: [sessionOption,
      { name: 'text', description: 'Your exact argument; channel history is not collected', type: ApplicationCommandOptionType.String, required: true, min_length: 1, max_length: 1000 }] },
    { name: 'freeze', description: 'Close submissions and request the consented assessment', type: ApplicationCommandOptionType.Subcommand, options: [sessionOption] },
    { name: 'status', description: 'Review the complete proposal and current consent state privately', type: ApplicationCommandOptionType.Subcommand, options: [sessionOption] },
    { name: 'result', description: 'Inspect the accepted rubric result and publication outcome privately', type: ApplicationCommandOptionType.Subcommand, options: [sessionOption] },
    { name: 'cancel', description: 'Cancel your Debate and erase its retained payloads', type: ApplicationCommandOptionType.Subcommand, options: [sessionOption] },
  ],
};

/** Copy one exact nested subcommand; the Debate owner separately validates rubric semantics and consent. */
export function normalizeDebateCommand(identity: DiscordCommandIdentity, value: unknown): NormalizedDebateCommand | null {
  try {
    for (const id of [identity.actorId, identity.guildId, identity.channelId, identity.sourceRequestId]) assertDiscordId(id);
    const group = object(value);
    invariant(group.name === 'debate' && group.type === 2 && group.value === undefined && Array.isArray(group.options) && group.options.length === 1, 'Invalid Debate group');
    const command = object(group.options[0]);
    invariant(command.type === 1 && command.value === undefined && typeof command.name === 'string', 'Invalid Debate action');
    const allowed: Record<string, string[]> = { propose: ['opponent', 'topic', 'rubric', 'retention-seconds'], consent: ['session', 'scope-hash', 'accept'],
      start: ['session'], submit: ['session', 'text'], freeze: ['session'], status: ['session'], result: ['session'], cancel: ['session'] };
    invariant(Object.hasOwn(allowed, command.name), 'Unknown Debate action');
    const entries = command.options ?? []; invariant(Array.isArray(entries) && entries.length <= 4, 'Invalid Debate options');
    const options = new Map<string, Record<string, unknown>>();
    for (const value of entries) { const entry = object(value);
      invariant(typeof entry.name === 'string' && allowed[command.name]!.includes(entry.name) && !options.has(entry.name) && entry.options === undefined, 'Invalid Debate option');
      options.set(entry.name, entry);
    }
    /** Require the expected Discord option type and bounds before copying its plain primitive value. */
    const read = (name: string, type: number, minimum = 0, maximum = 4000): string | number | boolean => {
      const entry = options.get(name); invariant(entry?.type === type, 'Missing Debate option');
      if (type === 4) invariant(typeof entry.value === 'number' && Number.isInteger(entry.value) && entry.value >= minimum && entry.value <= maximum, 'Invalid Debate number');
      else if (type === 5) invariant(typeof entry.value === 'boolean', 'Invalid Debate consent');
      else invariant(typeof entry.value === 'string' && entry.value.length >= minimum && entry.value.length <= maximum && !entry.value.includes('\0'), 'Invalid Debate text');
      return entry.value as string | number | boolean;
    };
    let args: NormalizedDebateCommand['arguments'];
    if (command.name === 'propose') {
      const opponentUserId = read('opponent', 6, 1, 20) as string; assertDiscordId(opponentUserId);
      const topic = read('topic', 3, 1, 500) as string; invariant(topic.trim().length > 0, 'Empty Debate topic');
      args = { operation: 'propose', opponentUserId, topic, rubric: JSON.parse(read('rubric', 3, 2, 4000) as string) as unknown,
        retentionSeconds: read('retention-seconds', 4, 300, 604800) as number };
    } else {
      const sessionId = read('session', 3, 36, 36) as string; assertUuid(sessionId);
      if (command.name === 'consent') { const scopeHash = read('scope-hash', 3, 64, 64) as string; invariant(/^[a-f0-9]{64}$/.test(scopeHash), 'Invalid scope hash');
        args = { operation: 'consent', sessionId, scopeHash, accept: read('accept', 5) as boolean }; }
      else if (command.name === 'submit') { const text = read('text', 3, 1, 1000) as string; invariant(text.trim().length > 0, 'Empty submission'); args = { operation: 'submit', sessionId, text }; }
      else args = { operation: command.name as 'start' | 'freeze' | 'status' | 'result' | 'cancel', sessionId };
    }
    return Object.freeze({ actorId: identity.actorId, guildId: identity.guildId, channelId: identity.channelId, sourceRequestId: identity.sourceRequestId,
      command: 'debate', arguments: Object.freeze(args) });
  } catch { return null; }
}

/** Reject arrays and primitive values before inspecting a nested Discord option. */
function object(value: unknown): Record<string, unknown> { invariant(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid command object'); return value as Record<string, unknown>; }
