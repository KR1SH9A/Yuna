/** Real runtime roles verify explicit private consent, subject isolation, race fences and physical erasure. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, test } from '@jest/globals';
import { MikroORM } from '@mikro-orm/postgresql';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';
import { prepareDatabase } from '../../src/platform/db/migrations/migrate.js';
import { entityOrmConfig } from '../../src/platform/db/mikro-orm.config.js';
import { GuildLifecycleService } from '../../src/contexts/administration/guild-lifecycle.service.js';
import { GuildInstallation } from '../../src/contexts/administration/entities/guild-installation.entity.js';
import { GuildSafetyState } from '../../src/contexts/administration/entities/guild-safety-state.entity.js';
import { MemoryService } from '../../src/contexts/memory/memory.service.js';
import { MemoryScope } from '../../src/contexts/memory/entities/memory-scope.entity.js';
import { MemoryFact } from '../../src/contexts/memory/entities/memory-fact.entity.js';
import { MemoryDeletionRequest } from '../../src/contexts/memory/entities/memory-deletion-request.entity.js';
import { AuditRecorder } from '../../src/platform/audit/audit.recorder.js';
import { AuditEntry } from '../../src/platform/audit/entities/audit-entry.entity.js';

let database: ReturnType<typeof temporaryPostgres>, orm: MikroORM, worker: MikroORM, serial = 0;
const actorId = '980000000000000001', otherId = '980000000000000002';
beforeAll(async () => {
  database = temporaryPostgres();
  const url = new URL('postgresql://yuna_test@localhost:55432/postgres'); url.searchParams.set('host', database.options.host);
  await prepareDatabase({ adminDatabaseUrl: url.href, botDatabasePassword: 'memory-bot', workerDatabasePassword: 'memory-worker' });
  orm = new MikroORM({ ...entityOrmConfig(), ...database.options, user: 'yuna_bot', ensureDatabase: false });
  worker = new MikroORM({ ...database.options, user: 'yuna_worker', entities: [], discovery: { warnWhenNoEntities: false }, ensureDatabase: false });
  await Promise.all([orm.connect(), worker.connect()]);
}, 60_000);
afterAll(async () => { try { await Promise.all([orm?.close(true), worker?.close(true)]); } finally { database?.close(); } }, 30_000);

/** Every fixture owns a separate installation; no provider, embedding or Discord I/O is involved. */
async function fixture(enabled = true) {
  const lifecycle = new GuildLifecycleService(orm), scope = await lifecycle.registerGuild(String(980000000000000100n + BigInt(++serial)), 'fake');
  if (enabled) await orm.em.fork().transactional(async em => {
    const installation = await em.findOneOrFail(GuildInstallation, { id: scope.installationId });
    installation.updateFeatureAdmission(installation.rowRevision, { ...installation.featureAdmission, memory: 'enabled' }, new Date());
  });
  let sequence = 0;
  /** Bind a fixture user to this installation with independent request provenance. */
  const caller = (userId = actorId) => ({ ...scope, actorId: userId, sourceRequestId: `memory:${serial}:${++sequence}` });
  /** Create the member memory owner for this installation. */
  const service = (audit?: AuditRecorder) => new MemoryService(orm, scope, lifecycle, audit);
  const memory = service();
  return { scope, lifecycle, caller, memory, service,
    consent: (userId = actorId, days = 30) => memory.setConsent(caller(userId), { granted: true, retentionDays: days, expectedPrivacyRevision: 0 }),
    save: (text = 'I prefer quiet mornings', revision = 1, userId = actorId) => memory.remember(caller(userId), { text, expectedPrivacyRevision: revision }),
    stored: () => orm.em.fork().findOneOrFail(MemoryScope, { ...scope, userId: actorId }) };
}

test('memory defaults off, requires enabled feature plus explicit consent, and stores only exact submitted private text', async () => {
  const f = await fixture(false);
  assert.equal((await f.memory.inspectOwnFacts(f.caller())).granted, false);
  await assert.rejects(f.consent(), /admission is closed/);
  const active = await fixture(); await assert.rejects(active.save(), /consent is required/);
  const consent = await active.consent(); assert.equal(consent.privacyRevision, 1);
  const text = '  Exact self-submitted preference\nwith spacing  ', saved = await active.save(text);
  const fact = await orm.em.fork().findOneOrFail(MemoryFact, { ...active.scope, id: saved.factId });
  assert.equal(fact.factText, text); assert.equal(fact.acceptedTaskResultId, null); assert.equal(fact.sourceProvenance[0]?.kind, 'user_submission');
  assert.deepEqual(fact.audience, { kind: 'subject' }); assert.equal(fact.subjectUserId, actorId);
  assert.ok(!JSON.stringify(await orm.em.fork().find(AuditEntry, active.scope)).includes(text));
});

test('authenticated subjects cannot inspect, overwrite or delete another member or installation memory', async () => {
  const f = await fixture(); await f.consent(); const fact = await f.save('Private one'); await f.consent(otherId);
  assert.deepEqual((await f.memory.inspectOwnFacts(f.caller(otherId))).facts, []);
  await assert.rejects(f.memory.forget(f.caller(otherId), { factId: fact.factId, expectedPrivacyRevision: 1 }), /does not belong/);
  await assert.rejects(f.memory.inspectOwnFacts({ ...f.caller(), installationId: randomUUID() }), /scope mismatch/);
  await assert.rejects(f.memory.remember(f.caller(), { text: 'Injected subject', expectedPrivacyRevision: 1, subjectUserId: otherId } as never), /Unknown/);
  await assert.rejects(worker.em.fork().execute('select fact_text from memory_fact'));
  await assert.rejects(worker.em.fork().execute('delete from memory_scope'));
  assert.equal((await f.memory.inspectOwnFacts(f.caller())).facts[0]?.text, 'Private one');
});

test('replayed submissions deduplicate exact content and a forgotten source cannot resurrect under its stale revision', async () => {
  const f = await fixture(); await f.consent(); const caller = f.caller(), input = { text: 'Deduplicated private fact', expectedPrivacyRevision: 1 };
  const results = await Promise.all([f.memory.remember(caller, input), f.memory.remember(caller, input)]);
  assert.equal(results[0]!.factId, results[1]!.factId); assert.equal(results.filter(result => result.duplicate).length, 1);
  await assert.rejects(f.memory.remember(caller, { ...input, text: 'Different' }), /replay differs/);
  const forgotten = await f.memory.forget(f.caller(), { factId: results[0]!.factId, expectedPrivacyRevision: 1 });
  assert.equal(forgotten.state, 'complete'); assert.equal(forgotten.privacyRevision, 2);
  await assert.rejects(f.memory.remember(caller, input), /Stale privacy revision/);
  assert.equal(await orm.em.fork().count(MemoryFact, f.scope), 0);
  const receipt = await orm.em.fork().findOneOrFail(MemoryDeletionRequest, { ...f.scope, id: forgotten.deletionId });
  assert.equal(receipt.ownerProgress.memory?.disposition, 'deleted'); assert.ok(!JSON.stringify(receipt).includes(input.text));
});

test('private literal search and pagination return only bounded current facts', async () => {
  const f = await fixture(); await f.consent();
  for (const text of ['Favorite tea', 'Favorite color', 'Travel preference', 'Favorite hobby']) await f.save(text);
  const first = await f.memory.inspectOwnFacts(f.caller()); assert.equal(first.facts.length, 3); assert.equal(first.nextOffset, 3);
  const last = await f.memory.inspectOwnFacts(f.caller(), { offset: 3 }); assert.equal(last.facts.length, 1); assert.equal(last.nextOffset, null);
  assert.equal((await f.memory.inspectOwnFacts(f.caller(), { query: 'FAVORITE' })).facts.length, 3);
  assert.equal((await f.memory.inspectOwnFacts(f.caller(), { query: '%' })).facts.length, 0);
  await assert.rejects(f.memory.inspectOwnFacts(f.caller(), { offset: -1 }), /Invalid memory page/);
});

test('withdrawal erases all facts and shorter consent retention cannot silently retain older content', async () => {
  const f = await fixture(); await f.consent(); await f.save();
  const narrowed = await f.memory.setConsent(f.caller(), { granted: true, retentionDays: 1, expectedPrivacyRevision: 1 });
  assert.equal(narrowed.erasedFacts, 1); assert.equal(narrowed.privacyRevision, 3);
  await f.save('New terms', 3);
  const withdrawn = await f.memory.setConsent(f.caller(), { granted: false, retentionDays: 1, expectedPrivacyRevision: 3 });
  assert.equal(withdrawn.erasedFacts, 1); assert.equal(withdrawn.granted, false);
  await assert.rejects(f.save('Late memory', withdrawn.privacyRevision), /consent is required/);
  assert.equal(await orm.em.fork().count(MemoryFact, f.scope), 0);
});

test('pause and feature disable block new saves but never prevent private inspection or erasure', async () => {
  const f = await fixture(); await f.consent(); const fact = await f.save();
  await orm.em.fork().transactional(async em => {
    const installation = await em.findOneOrFail(GuildInstallation, { id: f.scope.installationId });
    installation.updateFeatureAdmission(installation.rowRevision, { ...installation.featureAdmission, memory: 'disabled' }, new Date());
    const safety = await em.findOneOrFail(GuildSafetyState, f.scope);
    safety.pause(safety.safetyRevision, { kind: 'system', operation: 'test' }, 'paused', new Date());
  });
  await assert.rejects(f.save(), /admission is closed/);
  assert.equal((await f.memory.inspectOwnFacts(f.caller())).facts[0]?.factId, fact.factId);
  assert.equal((await f.memory.forget(f.caller(), { expectedPrivacyRevision: 1 })).erasedFacts, 1);
});

test('concurrent save versus forget cannot leave a late fact behind the committed privacy fence', async () => {
  const f = await fixture(); await f.consent();
  const results = await Promise.allSettled([f.save('Racing explicit submission'), f.memory.forget(f.caller(), { expectedPrivacyRevision: 1 })]);
  assert.equal(results[1]!.status, 'fulfilled'); assert.equal((await f.stored()).privacyRevision, 2);
  assert.equal(await orm.em.fork().count(MemoryFact, f.scope), 0);
  const attempts = await Promise.allSettled([f.memory.forget(f.caller(), { expectedPrivacyRevision: 2 }), f.memory.forget(f.caller(), { expectedPrivacyRevision: 2 })]);
  assert.equal(attempts.filter(value => value.status === 'fulfilled').length, 1);
});

test('audit failure rolls back erasure, receipt and privacy revision together; retry completes physical cleanup', async () => {
  const f = await fixture(); await f.consent(); const saved = await f.save(), audit = new AuditRecorder();
  audit.recordTransition = async () => { throw new Error('audit_failed'); };
  await assert.rejects(f.service(audit).forget(f.caller(), { expectedPrivacyRevision: 1 }), /audit_failed/);
  assert.equal((await f.stored()).privacyRevision, 1); assert.equal(await orm.em.fork().count(MemoryDeletionRequest, f.scope), 0);
  assert.equal((await f.memory.inspectOwnFacts(f.caller())).facts[0]?.factId, saved.factId);
  await f.memory.forget(f.caller(), { expectedPrivacyRevision: 1 }); assert.equal(await orm.em.fork().count(MemoryFact, f.scope), 0);
});

test('expiry physically removes content, rejects old request replay and later expires non-content receipts', async () => {
  const f = await fixture(); await f.consent(actorId, 1); const caller = f.caller(), input = { text: 'Expires privately', expectedPrivacyRevision: 1 };
  const saved = await f.memory.remember(caller, input), expiry = new Date(Date.parse(saved.expiresAt) + 1);
  assert.equal(await f.memory.runRetention(expiry), 1); assert.equal(await orm.em.fork().count(MemoryFact, f.scope), 0);
  await assert.rejects(f.memory.remember(caller, input), /Stale privacy revision/);
  await f.memory.runRetention(new Date(expiry.getTime() + 40 * 86400_000));
  assert.equal(await orm.em.fork().count(MemoryDeletionRequest, f.scope), 0);
});

test('installation cleanup erases private content and revokes consent using the caller transaction', async () => {
  const f = await fixture(); await f.consent(); await f.save(); await f.consent(otherId); await f.save('Other own memory', 1, otherId);
  const result = await orm.em.fork().transactional(em => f.memory.cleanupForRemoval(em, new Date()));
  assert.equal(result.disposition, 'complete'); assert.equal(await orm.em.fork().count(MemoryFact, f.scope), 0);
  assert.equal((await f.memory.inspectOwnFacts(f.caller())).granted, false);
  assert.equal((await f.memory.inspectOwnFacts(f.caller(otherId))).granted, false);
});

test('bounded storage rejects overlong input and more than fifty private facts', async () => {
  const f = await fixture(); await f.consent();
  await assert.rejects(f.save('x'.repeat(501)), /1 to 500/);
  for (let index = 0; index < 50; index++) await f.save(`Private fact ${index}`);
  await assert.rejects(f.save('Beyond limit'), /limit reached/);
  assert.equal(await orm.em.fork().count(MemoryFact, f.scope), 50);
});
