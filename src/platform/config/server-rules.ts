/** Versioned server guidance captured during authorized setup, separate from executable moderation criteria. */
import { createHash } from 'node:crypto';
import { assertDiscordId, invariant } from '../db/entity-values.js';

export interface ServerRulesSnapshot {
  schemaVersion: 1;
  guildId: string;
  observedAt: string;
  coverage: 'complete' | 'partial' | 'unavailable';
  sources: {
    kind: 'channel_topic' | 'message'; channelId: string; messageId: string | null; authorId: string | null;
    content: string; contentHash: string;
  }[];
}

/** Keep imported guidance bounded and attributable; the content is data, never authority or a model instruction. */
export function validateServerRules(value: ServerRulesSnapshot): void {
  invariant(value && value.schemaVersion === 1 && ['complete', 'partial', 'unavailable'].includes(value.coverage), 'Invalid rules snapshot');
  assertDiscordId(value.guildId);
  invariant(typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt)), 'Invalid rules observation');
  invariant(Array.isArray(value.sources) && value.sources.length <= 8 && (value.coverage !== 'unavailable' || value.sources.length === 0), 'Invalid rules coverage');
  let bytes = 0;
  const ids = new Set<string>();
  for (const source of value.sources) {
    assertDiscordId(source.channelId);
    invariant(source.kind === 'message' || source.kind === 'channel_topic', 'Invalid rules source');
    if (source.kind === 'message') { assertDiscordId(source.messageId!); assertDiscordId(source.authorId!); }
    else invariant(source.messageId === null && source.authorId === null, 'Invalid topic provenance');
    const id = `${source.channelId}:${source.messageId ?? 'topic'}`;
    invariant(!ids.has(id), 'Duplicate rules source'); ids.add(id);
    invariant(typeof source.content === 'string' && source.content.trim().length > 0 && source.content.length <= 4000, 'Invalid rules text');
    bytes += Buffer.byteLength(source.content, 'utf8');
    invariant(bytes <= 8192 && source.contentHash === createHash('sha256').update(source.content).digest('hex'), 'Invalid rules content binding');
  }
}
