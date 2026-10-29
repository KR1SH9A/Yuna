/** Real PostgreSQL ownership tests: original captures, case receipts and policy transitions commit atomically. */
import assert from 'node:assert/strict';
import { beforeAll, afterAll, test } from '@jest/globals';
import { MikroORM } from '@mikro-orm/postgresql';
import { LockMode, type FlushEventArgs } from '@mikro-orm/core';
import { entityOrmConfig } from '../../src/platform/db/mikro-orm.config.js';
import { prepareDatabase } from '../../src/platform/db/migrations/migrate.js';
import { temporaryPostgres } from '../helpers/temporary-postgres.js';
import { GuildLifecycleService, type InstallationScope } from '../../src/contexts/administration/guild-lifecycle.service.js';
import { GuildInstallation } from '../../src/contexts/administration/entities/guild-installation.entity.js';
import { ModerationService } from '../../src/contexts/moderation/moderation.service.js';
import { IntakeService, type OriginalMessageCapture, type OriginalMessageProvenance } from '../../src/platform/intake/intake.service.js';
import { IntakeEvent } from '../../src/platform/intake/entities/intake-event.entity.js';
import { IntakeDelivery } from '../../src/platform/intake/entities/intake-delivery.entity.js';
import { ModerationCase } from '../../src/contexts/moderation/entities/moderation-case.entity.js';
import { ModerationPolicyRevision } from '../../src/contexts/moderation/entities/moderation-policy-revision.entity.js';
import { EvidenceRevision } from '../../src/contexts/moderation/entities/evidence-revision.entity.js';
import { ModerationAction } from '../../src/contexts/moderation/entities/moderation-action.entity.js';
import { defaultYunaPolicy, validatePolicyConfig, type YunaPolicyConfig } from '../../src/platform/config/policy-config.js';
import type { JsonObject } from '../../src/platform/db/entity-values.js';

let database: ReturnType<typeof temporaryPostgres>, orm: MikroORM;
let sequence = 1000;
beforeAll(async () => {
  database = temporaryPostgres();
  const url = new URL('postgresql://yuna_test@localhost:55432/postgres'); url.searchParams.set('host', database.options.host);
  await prepareDatabase({ adminDatabaseUrl: url.href, botDatabasePassword: 'intake-bot', workerDatabasePassword: 'intake-worker' });
  orm = new MikroORM({ ...entityOrmConfig(), ...database.options }); await orm.connect();
}, 60_000);
afterAll(async () => { if (orm) await orm.close(true); database?.close(); }, 30_000);

/** Persist a configured installation through the real lifecycle and owner publication APIs. */
async function fixture(intake = new IntakeService()) {
  const administration = new GuildLifecycleService(orm), scope = await administration.registerGuild(String(900000000000000000n + BigInt(sequence++)), 'fake');
  const config = validatePolicyConfig({ ...structuredClone(defaultYunaPolicy), moderation: { enabled: true, policy: {
    rules: [{ id: 'abuse', version: '1', description: 'Fixture original-author conduct rule', enabled: true }],
    requiredEvidence: [{ ruleId: 'abuse', originalBody: true, originalMedia: false, establishedAuthor: true }], exclusions: [],
    evaluationConfiguration: { schemaVersion: 1, observationModel: 'observe', assessmentModel: 'assess', promptVersion: '1',
      decisionThresholds: { minimumConfidence: 0.9, yesThreshold: 0.95, noThreshold: 0.05 } },
    actionMapping: [{ ruleId: 'abuse', supportedDisposition: 'violation', action: 'ban', deleteMessageSeconds: 0 }],
  } } });
  const service = new ModerationService(orm, scope, administration, intake);
  const caller = { ...scope, actorId: '900000000000000002', sourceRequestId: `publish-${sequence}` };
  await orm.em.fork().transactional(async em => {
    const installed = await em.findOneOrFail(GuildInstallation, { id: scope.installationId }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    const now = new Date(); installed.updateOperatorPolicy(0, config as unknown as JsonObject, now);
    installed.updateFeatureAdmission(installed.rowRevision, { community: 'enabled', moderation: 'enabled' }, now);
    await service.publishPolicy(em, caller, config, now);
  });
  const provenance: OriginalMessageProvenance = { guildId: scope.guildId, channelId: '900000000000000003', messageId: '900000000000000004',
    eventKind: 'message_create', authorKind: 'user', authorUserId: '900000000000000005', webhookId: null, messageType: 0,
    createdAt: new Date(), observedAt: new Date() };
  const capture: OriginalMessageCapture = { originalContent: '  Original <@123> body\n', attachments: [], contentAccess: 'available', attachmentsComplete: true, missingReasons: [] };
  return { scope, administration, service, caller, config, provenance, capture, intake };
}

/** Assert canonical progress without converting ignored admission into success. */
function recorded(result: Awaited<ReturnType<ModerationService['ingestMessage']>>) {
  assert.equal(result.status, 'recorded'); if (result.status !== 'recorded') throw new Error('Expected recorded case'); return result.case;
}

test('concurrent repeated originals preserve exact first bytes, one case/evidence and one completed owner receipt', async () => {
  const f = await fixture();
  const results = await Promise.all([f.service.ingestMessage(f.provenance, f.capture), f.service.ingestMessage(f.provenance, f.capture)]);
  assert.equal(recorded(results[0]!).caseId, recorded(results[1]!).caseId);
  assert.equal(results.map(recorded).filter(item => item.duplicate).length, 1);
  const em = orm.em.fork(), evidence = await em.findOneOrFail(EvidenceRevision, f.scope);
  assert.equal(evidence.originalContent, f.capture.originalContent);
  const duplicate = await f.service.ingestMessage({ ...f.provenance, authorUserId: '900000000000000099' }, { ...f.capture, originalContent: 'replacement' });
  assert.equal(recorded(duplicate).duplicate, true);
  assert.equal((await orm.em.fork().findOneOrFail(EvidenceRevision, f.scope)).originalContent, f.capture.originalContent);
  assert.equal(await em.count(ModerationCase, f.scope), 1); assert.equal(await em.count(EvidenceRevision, f.scope), 1);
  const receipt = await em.findOneOrFail(IntakeDelivery, { ...f.scope, owner: 'moderation' });
  assert.equal(receipt.state, 'DONE'); assert.equal(receipt.ownerRecordRef, recorded(results[0]!).caseId);
  const event = await em.findOneOrFail(IntakeEvent, { ...f.scope, eventKind: 'message_create' });
  assert.equal(event.isCurrentSourceMarker, false); assert.equal(event.sourceVersion, 0);
  assert.equal(await em.count(ModerationAction, f.scope), 0);
});

test('Community current-source tombstones and originals remain independent in both capture orders', async () => {
  for (const originalFirst of [true, false]) {
    const f = await fixture(), now = new Date();
    if (originalFirst) await f.service.ingestMessage(f.provenance, f.capture);
    await orm.em.fork().transactional(async em => {
      await f.administration.lockAdmission(em, f.scope);
      await f.intake.invalidate(em, f.scope, f.provenance, now);
    });
    if (!originalFirst) await f.service.ingestMessage(f.provenance, f.capture);
    assert.equal((await orm.em.fork().findOneOrFail(EvidenceRevision, f.scope)).originalContent, f.capture.originalContent);
    assert.equal(await orm.em.fork().count(IntakeEvent, f.scope), 2);
    await orm.em.fork().transactional(async em => {
      await f.administration.lockAdmission(em, f.scope);
      assert.equal(await f.intake.receiveInput(em, f.scope, { ...f.provenance, authorId: f.provenance.authorUserId!, text: 'normalized',
        createdAt: now, sourceHash: 'hash' }, now, new Date(now.getTime() + 10_000), new Date(now.getTime() + 86_400_000)), null);
    });
  }
});

test('original capture does not suppress independent Community create admission', async () => {
  const f = await fixture(); await f.service.ingestMessage(f.provenance, f.capture);
  await orm.em.fork().transactional(async em => {
    await f.administration.lockAdmission(em, f.scope); const now = new Date();
    const community = await f.intake.receiveInput(em, f.scope, { ...f.provenance, authorId: f.provenance.authorUserId!, text: 'normalized', 
      createdAt: now, sourceHash: 'hash' }, now, new Date(now.getTime() + 10_000), new Date(now.getTime() + 86_400_000));
    assert.ok(community); community.receipt.complete(community.receipt.claimGeneration, 'handled', null, now);
  });
  assert.equal(await orm.em.fork().count(IntakeEvent, f.scope), 2);
});

test('a report of an uncaptured original stays incomplete and later authentic capture fills that same canonical case', async () => {
  const f = await fixture(), report = { channelId: f.provenance.channelId, messageId: f.provenance.messageId, allegation: 'Reporter claims another user said replacement content' };
  const first = recorded(await f.service.ingestReport({ ...f.caller, sourceRequestId: 'report-1' }, report));
  assert.equal(first.disposition, 'incomplete'); assert.equal(first.reasonCode, 'original_capture_missing');
  const before = await orm.em.fork().findOneOrFail(ModerationCase, f.scope); assert.equal(before.subjectUserId, null);
  assert.equal(await orm.em.fork().count(EvidenceRevision, f.scope), 0);
  const captured = recorded(await f.service.ingestMessage(f.provenance, f.capture)); assert.equal(captured.caseId, first.caseId);
  assert.equal(captured.phase, 'captured');
  const after = await orm.em.fork().findOneOrFail(ModerationCase, f.scope); assert.equal(after.subjectUserId, f.provenance.authorUserId);
  const duplicate = recorded(await f.service.ingestReport({ ...f.caller, sourceRequestId: 'report-1' }, { ...report, allegation: 'changed allegation' }));
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.caseId, first.caseId);
  await assert.rejects(f.service.ingestReport({ ...f.caller, sourceRequestId: 'report-1' }, { ...report, messageId: '900000000000000006' }));
});

test('parallel reports and original capture produce one author from original provenance and independent receipts', async () => {
  const f = await fixture();
  const results = await Promise.all([f.service.ingestReport({ ...f.caller, sourceRequestId: 'parallel-report' },
    { channelId: f.provenance.channelId, messageId: f.provenance.messageId, allegation: 'Untrusted allegation' }), f.service.ingestMessage(f.provenance, f.capture)]);
  assert.equal(recorded(results[0]!).caseId, recorded(results[1]!).caseId);
  assert.equal(await orm.em.fork().count(ModerationCase, f.scope), 1);
  assert.equal(await orm.em.fork().count(IntakeDelivery, { ...f.scope, state: 'DONE' }), 2);
  assert.equal((await orm.em.fork().findOneOrFail(ModerationCase, f.scope)).subjectUserId, f.provenance.authorUserId);
});

test('restricted content and webhook attribution remain explicit missing evidence without inferred human targets', async () => {
  const f = await fixture();
  const result = recorded(await f.service.ingestMessage({ ...f.provenance, authorKind: 'webhook', authorUserId: null, webhookId: '900000000000000007' },
    { ...f.capture, originalContent: null, contentAccess: 'restricted', attachmentsComplete: false, missingReasons: ['content_restricted'] }));
  assert.equal(result.disposition, 'incomplete');
  const evidence = await orm.em.fork().findOneOrFail(EvidenceRevision, f.scope);
  assert.equal(evidence.originalContent, null); assert.equal(evidence.originalAuthorUserId, null);
  assert.equal(evidence.captureCoverage.attachments, 'missing');
});

test('post-flush failure rolls original event, case, evidence and completed receipt back together', async () => {
  const f = await fixture(); let injected = false;
  const subscriber = { /** Inject a failure after ORM flush so the test verifies that the entire transaction rolls back. */ afterFlush(args: FlushEventArgs) {
    if (!injected && args.uow.getChangeSets().some(change => change.entity instanceof EvidenceRevision && change.entity.installationId === f.scope.installationId)) {
      injected = true; throw new Error('injected after evidence flush');
    }
  } };
  orm.em.getEventManager().registerSubscriber(subscriber);
  await assert.rejects(f.service.ingestMessage(f.provenance, f.capture), /injected after evidence flush/);
  assert.equal(injected, true);
  assert.equal(await orm.em.fork().count(IntakeEvent, f.scope), 0);
  assert.equal(await orm.em.fork().count(IntakeDelivery, f.scope), 0);
  assert.equal(await orm.em.fork().count(ModerationCase, f.scope), 0);
  assert.equal(await orm.em.fork().count(EvidenceRevision, f.scope), 0);
  assert.equal(recorded(await f.service.ingestMessage(f.provenance, f.capture)).phase, 'captured');
});

test('publication is idempotent across jsonb key order and freezes prior revisions while fencing pending cases', async () => {
  const f = await fixture(); await f.service.ingestMessage(f.provenance, f.capture);
  const previous = await orm.em.fork().findOneOrFail(ModerationCase, f.scope);
  await orm.em.fork().transactional(async em => {
    await f.administration.lockFeatureAdmission(em, f.scope, 'moderation');
    assert.equal((await f.service.publishPolicy(em, f.caller, structuredClone(f.config), new Date())).changed, false);
  });
  assert.equal(await orm.em.fork().count(ModerationPolicyRevision, f.scope), 1);
  const config = structuredClone(f.config); config.moderation.policy!.rules[0]!.version = '2';
  await orm.em.fork().transactional(async em => {
    await f.administration.lockFeatureAdmission(em, f.scope, 'moderation');
    assert.equal((await f.service.publishPolicy(em, { ...f.caller, sourceRequestId: 'revision-2' }, config, new Date())).changed, true);
  });
  const after = await orm.em.fork().findOneOrFail(ModerationCase, f.scope);
  assert.notEqual(after.policyRevisionId, previous.policyRevisionId); assert.equal(after.generation, previous.generation + 1);
  assert.equal((await orm.em.fork().findOneOrFail(ModerationPolicyRevision, { id: previous.policyRevisionId })).rules[0]!.version, '1');
  await assert.rejects(orm.em.fork().execute('update moderation_policy_revision set revision_number = 99 where id = ?', [previous.policyRevisionId]));
});

test('disabled admission and wrong installation callers cannot create captures or report evidence', async () => {
  const f = await fixture();
  await assert.rejects(f.service.ingestReport({ ...f.caller, guildId: '900000000000000009' }, { channelId: f.provenance.channelId, messageId: f.provenance.messageId, allegation: '' }));
  await orm.em.fork().transactional(async em => {
    const installed = await em.findOneOrFail(GuildInstallation, f.scope.installationId, { lockMode: LockMode.PESSIMISTIC_WRITE });
    installed.updateFeatureAdmission(installed.rowRevision, { community: 'enabled', moderation: 'disabled' }, new Date());
  });
  assert.deepEqual(await f.service.ingestMessage(f.provenance, f.capture), { status: 'ignored', reasonCode: 'admission_closed' });
  assert.equal(await orm.em.fork().count(IntakeEvent, f.scope), 0);
});

test('removal purges payloads and retains referenced provenance; metadata retention deletes only expired unreferenced done receipts', async () => {
  const f = await fixture(); await f.service.ingestMessage(f.provenance, f.capture);
  const now = new Date(Date.now() + 40 * 86_400_000);
  await orm.em.fork().transactional(async em => {
    await f.administration.lockFeatureAdmission(em, f.scope, 'moderation');
    assert.equal((await f.service.cleanupForRemoval(em, now)).disposition, 'retained');
    assert.equal((await f.intake.cleanupForRemoval(em, f.scope, now)).disposition, 'retained');
    assert.equal(await f.intake.purgeMetadata(em, f.scope, now), 0);
  });
  assert.equal((await orm.em.fork().findOneOrFail(EvidenceRevision, f.scope)).originalContent, null);
  assert.equal((await orm.em.fork().findOneOrFail(IntakeEvent, f.scope)).snapshot, null);
  const g = await fixture();
  const source = { ...g.provenance, authorId: g.provenance.authorUserId!, text: 'current', createdAt: new Date(), sourceHash: 'hash' };
  await orm.em.fork().transactional(async em => {
    await g.administration.lockAdmission(em, g.scope); const at = new Date();
    const received = await g.intake.receiveInput(em, g.scope, source, at, new Date(at.getTime() + 60_000), new Date(at.getTime() + 1000), new Date(at.getTime() + 2000));
    assert.ok(received); received.receipt.complete(received.receipt.claimGeneration, 'handled', null, at);
  });
  await orm.em.fork().transactional(async em => {
    await g.administration.lockAdmission(em, g.scope);
    await g.intake.purgeExpired(em, g.scope, now); await em.flush();
    assert.equal(await g.intake.purgeMetadata(em, g.scope, now), 1);
  });
  assert.equal(await orm.em.fork().count(IntakeDelivery, g.scope), 0); assert.equal(await orm.em.fork().count(IntakeEvent, g.scope), 0);
});

test('metadata cleanup is capped at fifty and preserves unfinished receipts and future metadata deadlines', async () => {
  const f = await fixture(), now = new Date(), expired = new Date(now.getTime() + 10_000);
  await orm.em.fork().transactional(async em => {
    await f.administration.lockAdmission(em, f.scope);
    for (let index = 0; index < 53; index++) {
      const event = new IntakeEvent({ ...f.scope, createdAt: now, eventKind: 'message_create', sourceEventKey: `retention-fixture:${index}`,
        sourceKey: `retention-fixture:${index}`, ingressSequence: BigInt(index), observedAt: now, authorKind: 'unknown', contentAccess: 'unknown', coverage: [],
        purgeAfter: new Date(now.getTime() + 1000), metadataPurgeAfter: new Date(now.getTime() + (index === 52 ? 20_000 : 2000)) });
      event.purgePayload(new Date(now.getTime() + 1000), 'retention');
      const receipt = new IntakeDelivery({ ...f.scope, createdAt: now, eventId: event.id, owner: 'community', orderKey: event.sourceKey! });
      receipt.claim('retention-fixture', now, new Date(now.getTime() + 1000), receipt.rowRevision);
      if (index !== 51) receipt.complete(receipt.claimGeneration, 'handled', null, now);
      em.persist([event, receipt]);
    }
  });
  await orm.em.fork().transactional(async em => {
    await f.administration.lockAdmission(em, f.scope);
    assert.equal(await f.intake.purgeMetadata(em, f.scope, expired), 50);
    assert.equal(await f.intake.purgeMetadata(em, f.scope, expired), 1);
    assert.equal(await f.intake.purgeMetadata(em, f.scope, expired), 0);
  });
  const survivors = await orm.em.fork().find(IntakeEvent, f.scope);
  assert.deepEqual(survivors.map(item => item.sourceEventKey).sort(), ['retention-fixture:51', 'retention-fixture:52']);
});

test('normal retention erases expired original bodies, fences case work and never reconstructs evidence on duplicate create', async () => {
  const f = await fixture(); const initial = recorded(await f.service.ingestMessage(f.provenance, f.capture));
  await orm.em.fork().transactional(async em => {
    await f.administration.lockFeatureAdmission(em, f.scope, 'moderation');
    await f.service.runRetention(em, new Date(Date.now() + 31 * 86_400_000));
  });
  const evidence = await orm.em.fork().findOneOrFail(EvidenceRevision, f.scope);
  assert.equal(evidence.originalContent, null); assert.equal(evidence.purgeReason, 'retention');
  const record = await orm.em.fork().findOneOrFail(ModerationCase, f.scope);
  assert.equal(record.disposition, 'incomplete'); assert.equal(record.expectedTaskId, null);
  const duplicate = recorded(await f.service.ingestMessage(f.provenance, f.capture));
  assert.equal(duplicate.evidenceRevisionId, initial.evidenceRevisionId); assert.equal(duplicate.duplicate, true);
  assert.equal((await orm.em.fork().findOneOrFail(EvidenceRevision, f.scope)).originalContent, null);
});
