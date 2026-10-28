/** Verify approved knowledge with real PostgreSQL scopes, native authority and transaction rollback. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, test } from '@jest/globals';
import { MikroORM } from '@mikro-orm/postgresql';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';
import { prepareDatabase } from '../../src/platform/db/migrations/migrate.js';
import { entityOrmConfig } from '../../src/platform/db/mikro-orm.config.js';
import { AuthorityService } from '../../src/contexts/administration/authority.service.js';
import { GuildLifecycleService } from '../../src/contexts/administration/guild-lifecycle.service.js';
import { KnowledgeService } from '../../src/contexts/community/knowledge.service.js';
import { KnowledgeEntry } from '../../src/contexts/community/entities/knowledge-entry.entity.js';
import { ConversationService } from '../../src/contexts/community/conversation.service.js';
import { ReplyDeliveryService } from '../../src/contexts/community/reply-delivery.service.js';
import { ConversationRequest } from '../../src/contexts/community/entities/conversation-request.entity.js';
import { ReplyDelivery } from '../../src/contexts/community/entities/reply-delivery.entity.js';
import { IntakeService } from '../../src/platform/intake/intake.service.js';
import { TaskService } from '../../src/platform/jobs/task.service.js';
import { WorkerTaskStore } from '../../src/platform/jobs/worker-task.store.js';
import { LlmService } from '../../src/ai/llm/llm.service.js';
import { AuditEntry } from '../../src/platform/audit/entities/audit-entry.entity.js';
import type { AdministrationFactReader } from '../../src/contexts/administration/contracts.js';
import type { ApproveKnowledgeEntryDto, KnowledgeEntryDto } from '../../src/contexts/community/dto/knowledge.dto.js';
import type { AudienceBinding, ContextBinding } from '../../src/contexts/community/entities/community-values.js';

let database: ReturnType<typeof temporaryPostgres>, bot: MikroORM, workerOrm: MikroORM;
let serial = 0;
const ownerId = '830000000000000001', staffId = '830000000000000002';
const channelA = '830000000000000003', channelB = '830000000000000004', channelThread = '830000000000000005';

beforeAll(async () => {
  database = temporaryPostgres();
  const url = new URL('postgresql://yuna_test@localhost:55432/postgres'); url.searchParams.set('host', database.options.host);
  await prepareDatabase({ adminDatabaseUrl: url.href, botDatabasePassword: 'knowledge-test-bot', workerDatabasePassword: 'knowledge-test-worker' });
  bot = new MikroORM({ ...entityOrmConfig(), ...database.options, user: 'yuna_bot', ensureDatabase: false }); await bot.connect();
  workerOrm = new MikroORM({ ...database.options, user: 'yuna_worker', entities: [], discovery: { warnWhenNoEntities: false }, ensureDatabase: false }); await workerOrm.connect();
}, 60_000);
afterAll(async () => { try { await bot?.close(true); await workerOrm?.close(true); } finally { database?.close(); } }, 30_000);

/** Build a fresh installation with deterministic native facts and observable same-transaction invalidation. */
async function scenario() {
  const scope = await new GuildLifecycleService(bot).registerGuild(String(840000000000000000n + BigInt(++serial)), 'knowledge-test-model');
  const lifecycle = new GuildLifecycleService(bot); let requestNumber = 0, failInvalidation = false, nativePermitted = true;
  const invalidations: string[][] = [];
  /** Bind a fixture user to this installation with independent request provenance. */
  const caller = (actorId = ownerId) => ({ ...scope, actorId, sourceRequestId: `knowledge:${serial}:${++requestNumber}` });
  const reader: AdministrationFactReader = { /** Supply deterministic native authority facts; no real Discord permissions are consulted. */ async readFacts(actor, operation) {
    assert.equal(bot.em.isInTransaction(), false);
    return { ...actor, operation, observedAt: new Date(), complete: true, ownerId, actorIsMember: true,
      actorPermissions: nativePermitted ? '8' : '0', botPermissions: '8' };
  } };
  const authority = new AuthorityService(bot, reader, async () => {});
  await authority.bootstrapOwner(caller());
  const model = 'knowledge-test-model', tasks = new TaskService(), intake = new IntakeService();
  const conversation = new ConversationService(bot, scope, model, lifecycle, intake, tasks);
  const knowledge = new KnowledgeService(bot, scope, authority, lifecycle, async (em, ids) => {
    assert.equal(em.isInTransaction(), true); invalidations.push([...ids]); if (failInvalidation) throw new Error('knowledge_invalidation_failed');
    await conversation.invalidateKnowledge(em, ids, 'knowledge_changed', new Date());
  });
  conversation.setKnowledgeService(knowledge);
  let sends = 0;
  const sourceText = 'When does the support desk open?', sourceHash = createHash('sha256').update(sourceText).digest('hex');
  /** Create a normalized source message scoped to this knowledge fixture. */
  const source = () => ({ ...scope, channelId: channelA, messageId: String(850000000000000000n + BigInt(serial * 100 + ++requestNumber)),
    authorId: staffId, text: sourceText, sourceHash, createdAt: new Date() });
  const delivery = new ReplyDeliveryService(bot, scope, lifecycle, intake, { /** Return the simulated current Discord source and permission state. */ async readSource() { return { exists: true, canSend: true, sourceHash }; },
    /** Capture one simulated send and return this scenario's chosen transport outcome. */
    async sendReply() { sends++; return { classification: 'delivered', messageId: '860000000000000001' }; }, /** Return only the remotely attributed fixture reply during reconciliation. */ async findReply() { return null; } }, tasks);
  delivery.setKnowledgeService(knowledge);
  return { scope, authority, knowledge, conversation, delivery, source, model, worker: new WorkerTaskStore(workerOrm),
    sends: () => sends, caller, invalidations, failInvalidation: () => { failInvalidation = true; },
    denyNative: () => { nativePermitted = false; } };
}

/** The source channel has already been verified by Community before this internal retrieval call. */
function audience(channelId = channelA): AudienceBinding { return { schemaVersion: 1, visibility: 'channel', channelId, requesterUserId: staffId, revision: 1 }; }
/** The approval DTO contains arguments only, never an actor or trusted request identity. */
function approval(content = 'The support desk opens at nine.', channels?: string[]): ApproveKnowledgeEntryDto {
  return { content, provenance: { kind: 'staff_submission', sourceReference: 'reviewed handbook' },
    visibility: channels ? { schemaVersion: 1, kind: 'channels', channelIds: channels } : { schemaVersion: 1, kind: 'guild' } };
}
/** Context bindings retain only identity, immutable hash and access revision. */
function binding(entry: KnowledgeEntryDto): ContextBinding { return { owner: 'knowledge', recordId: entry.entryId, revision: entry.rowRevision, contentHash: entry.contentHash }; }

 test('approval binds trusted provenance, is idempotent and audits only references', async () => {
  const f = await scenario(), caller = f.caller(), input = approval();
  const [first, repeat] = await Promise.all([f.knowledge.approveEntry(caller, input), f.knowledge.approveEntry(caller, input)]);
  assert.equal(first.entryId, repeat.entryId); assert.equal(first.provenance?.requestId, caller.sourceRequestId); assert.equal(first.approvalActorId, ownerId);
  assert.equal(await bot.em.fork().count(KnowledgeEntry, f.scope), 1);
  await assert.rejects(f.knowledge.approveEntry(caller, approval('Changed content.')), /replay mismatch/);
  const audit = await bot.em.fork().findOneOrFail(AuditEntry, { ...f.scope, operation: 'community.knowledge_approved' });
  assert(!JSON.stringify(audit).includes(input.content)); assert(!JSON.stringify(audit).includes(input.provenance.sourceReference));
  await assert.rejects(f.knowledge.approveEntry(f.caller(), { ...input, actorId: ownerId }), /Unknown knowledge argument/);
});

 test('current native administrator alone cannot approve and scoped knowledge authority cannot widen its audience', async () => {
  const f = await scenario();
  await assert.rejects(f.knowledge.approveEntry(f.caller(staffId), approval()), /application_grant_required/);
  await f.authority.grantCapability(f.caller(), { granteeUserId: staffId, capability: 'knowledge.manage',
    scope: { channelIds: [channelA], targetUserIds: [] }, expiresAt: null, sourceOperationKey: 'knowledge' });
  const entry = await f.knowledge.approveEntry(f.caller(staffId), approval(undefined, [channelA]));
  await assert.rejects(f.knowledge.changeVisibility(f.caller(staffId), { entryId: entry.entryId, expectedRowRevision: 1,
    visibility: { schemaVersion: 1, kind: 'guild' } }), /application_grant_required/);
  await assert.rejects(f.knowledge.changeVisibility(f.caller(staffId), { entryId: entry.entryId, expectedRowRevision: 1,
    visibility: { schemaVersion: 1, kind: 'channels', channelIds: [channelB] } }), /application_grant_required/);
  f.denyNative(); await assert.rejects(f.knowledge.retireEntry(f.caller(staffId), { entryId: entry.entryId, expectedRowRevision: 1, reasonCode: 'removed' }), /native_administrator_required/);
});

 test('lexical retrieval is bounded and never returns another channel, thread, installation, expired or retired entry', async () => {
  const f = await scenario(), other = await scenario();
  const global = await f.knowledge.approveEntry(f.caller(), approval());
  const restricted = await f.knowledge.approveEntry(f.caller(), approval('The support desk is in room A.', [channelA]));
  await f.knowledge.approveEntry(f.caller(), approval('The support desk is in room B.', [channelB]));
  await other.knowledge.approveEntry(other.caller(), approval('Foreign support desk.'));
  /** Read visible knowledge using the fixture audience and query. */
  const find = (channelId: string, entryIds?: string[]) => bot.em.fork().transactional(em => f.knowledge.findVisibleEntries(em, { search: 'support desk', entryIds }, audience(channelId)));
  assert.deepEqual(new Set((await find(channelA)).map(entry => entry.entryId)), new Set([global.entryId, restricted.entryId]));
  assert.deepEqual((await find(channelThread)).map(entry => entry.entryId), [global.entryId]);
  assert.deepEqual((await find(channelA, [restricted.entryId])).map(entry => entry.entryId), [restricted.entryId]);
  await f.knowledge.retireEntry(f.caller(), { entryId: global.entryId, expectedRowRevision: 1, reasonCode: 'outdated' });
  assert.equal((await find(channelThread)).length, 0);
  const future = new Date(Date.parse(restricted.purgeAfter) + 1);
  assert.equal((await bot.em.fork().transactional(em => f.knowledge.findVisibleEntries(em, { search: 'support' }, audience(channelA), future))).length, 0);
});

 test('retrieval uses whole entries within a total 6000 character and five-result bound', async () => {
  const f = await scenario();
  for (let index = 0; index < 7; index++) await f.knowledge.approveEntry(f.caller(), approval(`support ${index} ${'a'.repeat(1_500)}`));
  const entries = await bot.em.fork().transactional(em => f.knowledge.findVisibleEntries(em, { search: 'support', limit: 5 }, audience()));
  assert.equal(entries.length, 3); assert(entries.reduce((sum, entry) => sum + entry.content!.length, 0) <= 6_000);
  await assert.rejects(f.knowledge.findVisibleEntries(bot.em.fork(), { search: 'support' }, audience()), /owner transaction/);
  await assert.rejects(bot.em.fork().transactional(em => f.knowledge.findVisibleEntries(em, { search: 'support' }, { ...audience(), visibility: 'requester' })), /verified channel/);
});

test('staff search snapshots its authorized channel before waiting for fresh native facts', async () => {
  const f = await scenario();
  const visible = await f.knowledge.approveEntry(f.caller(), approval('Support desk in channel A.', [channelA]));
  await f.knowledge.approveEntry(f.caller(), approval('Support desk in channel B.', [channelB]));
  await f.authority.grantCapability(f.caller(), { granteeUserId: staffId, capability: 'knowledge.manage',
    scope: { channelIds: [channelA], targetUserIds: [] }, expiresAt: null, sourceOperationKey: 'knowledge-search' });
  const input = { search: 'support', channelId: channelA };
  const result = f.knowledge.searchEntries(f.caller(staffId), input);
  input.channelId = channelB;
  assert.deepEqual((await result).map(entry => entry.entryId), [visible.entryId]);
});

 test('visibility changes preserve approval identity and invalidate old bindings atomically', async () => {
  const f = await scenario(), entry = await f.knowledge.approveEntry(f.caller(), approval(undefined, [channelA, channelB]));
  assert.equal(await bot.em.fork().transactional(em => f.knowledge.validateBindings(em, [binding(entry)], audience())), true);
  const changed = await f.knowledge.changeVisibility(f.caller(), { entryId: entry.entryId, expectedRowRevision: 1,
    visibility: { schemaVersion: 1, kind: 'channels', channelIds: [channelB] } });
  assert.equal(changed.rowRevision, 2); assert.equal(changed.approvedAt, entry.approvedAt); assert.equal(changed.contentHash, entry.contentHash);
  assert.deepEqual(f.invalidations, [[entry.entryId]]);
  assert.equal(await bot.em.fork().transactional(em => f.knowledge.validateBindings(em, [binding(entry)], audience())), false);
  assert.equal(await bot.em.fork().transactional(em => f.knowledge.validateBindings(em, [binding(changed)], audience(channelB))), true);
  await assert.rejects(f.knowledge.retireEntry(f.caller(), { entryId: entry.entryId, expectedRowRevision: 1, reasonCode: 'stale' }), /Stale knowledge revision/);
});

 test('replacement retires only the expected predecessor and does not mutate its content', async () => {
  const f = await scenario(), original = await f.knowledge.approveEntry(f.caller(), approval());
  const corrected = await f.knowledge.approveEntry(f.caller(), { ...approval('The support desk opens at ten.'), predecessor: { entryId: original.entryId, expectedRowRevision: 1 } });
  const old = await bot.em.fork().findOneOrFail(KnowledgeEntry, { ...f.scope, id: original.entryId });
  assert.equal(old.content, original.content); assert.equal(old.replacementEntryId, corrected.entryId); assert.ok(old.retiredAt);
  assert.deepEqual(f.invalidations, [[original.entryId]]);
  assert.equal(await bot.em.fork().transactional(em => f.knowledge.validateBindings(em, [binding(original)], audience())), false);
  await assert.rejects(f.knowledge.approveEntry(f.caller(), { ...approval('Another correction.'), predecessor: { entryId: original.entryId, expectedRowRevision: 1 } }), /Stale knowledge predecessor/);
});

 test('failed invalidation rolls back retirement, visibility change, replacement and audit', async () => {
  const f = await scenario(), entry = await f.knowledge.approveEntry(f.caller(), approval()); f.failInvalidation();
  await assert.rejects(f.knowledge.retireEntry(f.caller(), { entryId: entry.entryId, expectedRowRevision: 1, reasonCode: 'retired' }), /knowledge_invalidation_failed/);
  await assert.rejects(f.knowledge.changeVisibility(f.caller(), { entryId: entry.entryId, expectedRowRevision: 1, visibility: { schemaVersion: 1, kind: 'channels', channelIds: [channelA] } }), /knowledge_invalidation_failed/);
  await assert.rejects(f.knowledge.approveEntry(f.caller(), { ...approval('replacement'), predecessor: { entryId: entry.entryId, expectedRowRevision: 1 } }), /knowledge_invalidation_failed/);
  const stored = await bot.em.fork().findOneOrFail(KnowledgeEntry, { ...f.scope, id: entry.entryId });
  assert.equal(stored.rowRevision, 1); assert.equal(stored.retiredAt, null); assert.equal(await bot.em.fork().count(KnowledgeEntry, f.scope), 1);
  assert.equal(await bot.em.fork().count(AuditEntry, { ...f.scope, operation: { $like: 'community.knowledge%' } }), 1);
});

 test('retention and installation removal erase content and provenance after invalidating pending copies', async () => {
  const f = await scenario(), entry = await f.knowledge.approveEntry(f.caller(), approval());
  const afterExpiry = new Date(Date.parse(entry.purgeAfter) + 1);
  assert.equal(await bot.em.fork().transactional(em => f.knowledge.purgeExpired(em, afterExpiry)), 1);
  const purged = await bot.em.fork().findOneOrFail(KnowledgeEntry, { ...f.scope, id: entry.entryId });
  assert.equal(purged.content, null); assert.equal(purged.provenance, null); assert.ok(purged.retiredAt); assert.equal(purged.contentHash, entry.contentHash);
  const next = await f.knowledge.approveEntry(f.caller(), approval('Support desk replacement.'));
  const cleanup = await bot.em.fork().transactional(em => f.knowledge.cleanupForRemoval(em));
  assert.equal(cleanup.disposition, 'retained');
  assert.equal((await bot.em.fork().findOneOrFail(KnowledgeEntry, { ...f.scope, id: next.entryId })).content, null);
  assert.deepEqual(f.invalidations, [[entry.entryId], [next.entryId]]);
});

 test('cross-installation mutation and forged content or revision bindings fail closed', async () => {
  const f = await scenario(), other = await scenario(), entry = await f.knowledge.approveEntry(f.caller(), approval());
  await assert.rejects(f.knowledge.approveEntry(other.caller(), approval()), /Wrong knowledge installation/);
  await assert.rejects(other.knowledge.retireEntry(other.caller(), { entryId: entry.entryId, expectedRowRevision: 1, reasonCode: 'cross_scope' }));
  for (const wrong of [{ ...binding(entry), contentHash: 'a'.repeat(64) }, { ...binding(entry), revision: 2 }, { ...binding(entry), recordId: randomUUID() }]) {
    assert.equal(await bot.em.fork().transactional(em => f.knowledge.validateBindings(em, [wrong], audience())), false);
  }
});

test('conversation preparation passes only visible approved text and retains exact knowledge bindings through delivery', async () => {
  const f = await scenario(), entry = await f.knowledge.approveEntry(f.caller(), approval());
  await f.knowledge.approveEntry(f.caller(), approval('Private support desk instructions.', [channelB]));
  assert.equal(await f.conversation.receiveInput(f.source()), 'admitted');
  const claim = await f.worker.claimNext('knowledge-worker', f.model); assert.ok(claim);
  const input = await f.worker.releasePreparedInput(claim); assert.ok(input);
  assert.deepEqual(input.approvedKnowledge?.map(value => value.entryId), [entry.entryId]);
  assert.equal(await f.worker.recordProviderStart(claim), true);
  const answer = await new LlmService({ mode: 'fake' }, 1000).generateReply(input);
  assert.equal(await f.worker.recordResult(claim, { outcome: 'success', reason: 'completed', payload: answer }), 'stored');
  assert.equal(await f.conversation.acceptReplyResults(), 1);
  const intent = await bot.em.fork().findOneOrFail(ReplyDelivery, f.scope);
  assert(intent.supportingReferences?.some(reference => reference.owner === 'knowledge' && reference.recordId === entry.entryId));
  await f.delivery.dispatchReadyDeliveries(new AbortController().signal); assert.equal(f.sends(), 1);
});

test('retirement invalidates a claimed prepared input and cancels its request before external disclosure', async () => {
  const f = await scenario(), entry = await f.knowledge.approveEntry(f.caller(), approval());
  await f.conversation.receiveInput(f.source());
  const claim = await f.worker.claimNext('knowledge-retire', f.model); assert.ok(claim);
  await f.knowledge.retireEntry(f.caller(), { entryId: entry.entryId, expectedRowRevision: 1, reasonCode: 'outdated' });
  assert.equal(await f.worker.releasePreparedInput(claim), null);
  assert.equal((await bot.em.fork().findOneOrFail(ConversationRequest, f.scope)).stage, 'canceled');
});

test('expiry blocks worker disclosure without waiting for maintenance or an invalidation callback', async () => {
  const f = await scenario(), entry = await f.knowledge.approveEntry(f.caller(), approval());
  await f.conversation.receiveInput(f.source());
  const claim = await f.worker.claimNext('knowledge-expiry', f.model); assert.ok(claim);
  await bot.em.fork().execute('update knowledge_entry set purge_after=clock_timestamp() where id=?', [entry.entryId]);
  assert.equal(await f.worker.releasePreparedInput(claim), null);
});

test('expiry between inference and acceptance rejects generated text and prevents a delivery intent', async () => {
  const f = await scenario(), entry = await f.knowledge.approveEntry(f.caller(), approval());
  await f.conversation.receiveInput(f.source()); const claim = await f.worker.claimNext('knowledge-acceptance', f.model); assert.ok(claim);
  const input = await f.worker.releasePreparedInput(claim); assert.ok(input); assert.equal(await f.worker.recordProviderStart(claim), true);
  const answer = await new LlmService({ mode: 'fake' }, 1000).generateReply(input);
  assert.equal(await f.worker.recordResult(claim, { outcome: 'success', reason: 'completed', payload: answer }), 'stored');
  await bot.em.fork().execute('update knowledge_entry set purge_after=clock_timestamp() where id=?', [entry.entryId]);
  assert.equal(await f.conversation.acceptReplyResults(), 0); assert.equal(await bot.em.fork().count(ReplyDelivery, f.scope), 0);
});

test('expiry after acceptance is rechecked before a Discord send', async () => {
  const f = await scenario(), entry = await f.knowledge.approveEntry(f.caller(), approval());
  await f.conversation.receiveInput(f.source()); const claim = await f.worker.claimNext('knowledge-dispatch', f.model); assert.ok(claim);
  const input = await f.worker.releasePreparedInput(claim); assert.ok(input); assert.equal(await f.worker.recordProviderStart(claim), true);
  const answer = await new LlmService({ mode: 'fake' }, 1000).generateReply(input);
  assert.equal(await f.worker.recordResult(claim, { outcome: 'success', reason: 'completed', payload: answer }), 'stored');
  assert.equal(await f.conversation.acceptReplyResults(), 1);
  await bot.em.fork().execute('update knowledge_entry set purge_after=clock_timestamp() where id=?', [entry.entryId]);
  await f.delivery.dispatchReadyDeliveries(new AbortController().signal);
  assert.equal(f.sends(), 0); assert.equal((await bot.em.fork().findOneOrFail(ReplyDelivery, f.scope)).state, 'CANCELED');
});
