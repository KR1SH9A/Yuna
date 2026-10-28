/** A narrow channel-operation vocabulary parsed from the caller's own message, never from model output or chat context. */
import { assertDiscordId, invariant } from '../platform/db/entity-values.js';

export type ChannelChoreRequest =
  | { kind: 'create'; channelType: 0 | 2 | 4; name: string }
  | { kind: 'rename'; channel: string; name: string }
  | { kind: 'topic'; channel: string; topic: string }
  | { kind: 'slowmode'; channel: string; seconds: number }
  | { kind: 'voice_limit'; channel: string; limit: number };
export type ChannelChoreOperation =
  | { kind: 'create'; channelType: 0 | 2 | 4; name: string }
  | { kind: 'modify'; channelId: string; channelType: 0 | 2 | 4; field: 'name' | 'topic' | 'rate_limit_per_user' | 'user_limit'; value: string | number; previous: string | number | null };
export interface ChannelChoreCaller { guildId: string; actorId: string; channelId: string; messageId: string; sourceHash: string }
export type ChannelChoreOutcome = { state: 'CONFIRMED'; channelId: string } | { state: 'FAILED' | 'UNKNOWN'; reason: string };

/** Accept one explicit imperative, including polite wording; discussion, code, bulk requests and hidden characters cannot become commands. */
export function parseChannelChore(text: string): ChannelChoreRequest | null {
  if (typeof text !== 'string' || text.length > 1400 || /[\p{Cc}\p{Cf}`]/u.test(text)) return null;
  const request = text.trim().replace(/^yuna\b\s*[,!:]?\s*/i, '').replace(/\s*,?\s+yuna[.!?]?$/i, '')
    .replace(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?/i, '').replace(/[.!?]$/, '').trim();
  const create = /^(?:create|make|add)\s+(?:a\s+|an\s+)?(text channel|voice channel|vc|category)\s+(?:(?:called|named)\s+)?(.+)$/i.exec(request);
  if (create) {
    const name = choreName(create[2]!); if (!name) return null;
    return { kind: 'create', channelType: create[1]!.toLowerCase() === 'category' ? 4 : /voice|vc/i.test(create[1]!) ? 2 : 0, name };
  }
  const rename = /^rename\s+(?:the\s+)?(?:channel\s+|vc\s+|category\s+)?(.+?)\s+to\s+(.+)$/i.exec(request);
  if (rename) {
    const channel = choreTarget(rename[1]!), name = choreName(rename[2]!);
    return channel && name ? { kind: 'rename', channel, name } : null;
  }
  const topic = /^(?:set|change)\s+(?:the\s+)?topic\s+(?:of|for|in)\s+(.+?)\s+to\s+"([^"]*)"$/i.exec(request);
  if (topic) {
    const channel = choreTarget(topic[1]!);
    return channel && topic[2]!.length <= 1024 ? { kind: 'topic', channel, topic: topic[2]! } : null;
  }
  const slow = /^(?:set|change)\s+(?:the\s+)?slowmode\s+(?:of|for|in)\s+(.+?)\s+to\s+(\d{1,5})\s*(seconds?|secs?|s|minutes?|mins?|m)$/i.exec(request);
  if (slow) {
    const channel = choreTarget(slow[1]!), seconds = Number(slow[2]) * (/^m/i.test(slow[3]!) ? 60 : 1);
    return channel && seconds <= 21600 ? { kind: 'slowmode', channel, seconds } : null;
  }
  const limit = /^(?:set|change)\s+(?:the\s+)?(?:voice|user)\s+limit\s+(?:of|for|in)\s+(.+?)\s+to\s+(\d{1,2})$/i.exec(request);
  if (limit) {
    const channel = choreTarget(limit[1]!);
    return channel ? { kind: 'voice_limit', channel, limit: Number(limit[2]) } : null;
  }
  return null;
}

/** Unquoted names are a single conservative token; quoted names can contain spaces but never another operation. */
function choreName(value: string): string | null {
  const name = /^"[^"\r\n]+"$/.test(value) ? value.slice(1, -1) : /^[\p{L}\p{N}_-]+$/u.test(value) ? value : null;
  return name && name.length <= 100 && !/[<>@\p{Cc}\p{Cf}`]/u.test(name) ? name : null;
}

/** Resolve only a channel mention, exact ID, quoted name or single channel-name token. */
function choreTarget(value: string): string | null {
  const mention = /^<#([1-9][0-9]{0,19})>$/.exec(value.trim());
  return mention?.[1] ?? choreName(value.trim().replace(/^#/, ''));
}

/** Revalidate stored operations at execution; no arbitrary Discord body fields survive this boundary. */
export function validateChannelChore(operation: ChannelChoreOperation): void {
  invariant(operation && [0, 2, 4].includes(operation.channelType), 'Unsupported channel type');
  if (operation.kind === 'create') {
    invariant(Object.keys(operation).length === 3 && choreName(`"${operation.name}"`) === operation.name, 'Invalid channel creation');
    return;
  }
  invariant(operation.kind === 'modify' && Object.keys(operation).length === 6, 'Invalid channel operation');
  assertDiscordId(operation.channelId);
  if (operation.field === 'name') invariant(typeof operation.value === 'string' && choreName(`"${operation.value}"`) === operation.value, 'Invalid channel name');
  else if (operation.field === 'topic') invariant(operation.channelType === 0 && typeof operation.value === 'string' && operation.value.length <= 1024, 'Invalid channel topic');
  else if (operation.field === 'rate_limit_per_user') invariant(operation.channelType === 0 && Number.isInteger(operation.value) && Number(operation.value) >= 0 && Number(operation.value) <= 21600, 'Invalid slowmode');
  else invariant(operation.field === 'user_limit' && operation.channelType === 2 && Number.isInteger(operation.value) && Number(operation.value) >= 0 && Number(operation.value) <= 99, 'Invalid voice limit');
  invariant(operation.previous === null || typeof operation.previous === 'string' && operation.previous.length <= 1024
    || typeof operation.previous === 'number' && Number.isFinite(operation.previous), 'Invalid previous setting');
}
