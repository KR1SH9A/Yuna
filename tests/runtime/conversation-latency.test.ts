/** Mock database commits and Discord transport to exercise telemetry without external side effects. */
import assert from 'node:assert/strict';
import { jest, test } from '@jest/globals';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { ConversationService } from '../../src/contexts/community/conversation.service.js';
import { ReplyDeliveryService } from '../../src/contexts/community/reply-delivery.service.js';
import { ConversationRequest } from '../../src/contexts/community/entities/conversation-request.entity.js';
import { ReplyDelivery } from '../../src/contexts/community/entities/reply-delivery.entity.js';
import { ChannelReplySettings } from '../../src/contexts/community/entities/channel-reply-settings.entity.js';
import type { GuildLifecycleService } from '../../src/contexts/administration/guild-lifecycle.service.js';
import type { IntakeService } from '../../src/platform/intake/intake.service.js';
import type { TaskService } from '../../src/platform/jobs/task.service.js';
import type { ConversationTaskCompletion } from '../../src/platform/jobs/conversation-task.contracts.js';
import type { LatencySample } from '../../src/platform/runtime/latency.js';
import type { DiscordGateway } from '../../src/discord/discord.module.js';
import type { DiscordReplyRequest, DiscordSendResult, NormalizedConversationMessage } from '../../src/discord/contracts.js';
import { defaultYunaPolicy } from '../../src/platform/config/policy-config.js';

/** Real request/delivery transitions; database durability and external responses are controlled. */
function harness() {
  const scope = { installationId: '11111111-1111-4111-8111-111111111111', guildId: '940000000000000001' };
  const taskId = '22222222-2222-4222-8222-222222222222';
  const resultId = '33333333-3333-4333-8333-333333333333';
  const sourceEventId = '44444444-4444-4444-8444-444444444444';
  const message: NormalizedConversationMessage = { ...scope, channelId: '940000000000000002', messageId: '940000000000000003',
    authorId: '940000000000000004', text: 'private fixture message', sourceHash: 'a'.repeat(64), createdAt: new Date() };
  const samples: LatencySample[] = [];
  const sent: DiscordReplyRequest[] = [];
  const queries: unknown[] = [];
  let request: ConversationRequest | undefined;
  let delivery: ReplyDelivery | undefined;
  let completion: ConversationTaskCompletion | undefined;
  let rejectCommit = false;
  let rejectOutcomeCommit = false;
  let sendGate: (() => Promise<void>) | undefined;
  let outcome: DiscordSendResult = { classification: 'delivered', messageId: '940000000000000005' };
  let reconciliations = 0;
  const em = {
    /** Return the isolated in-memory entity-manager fixture used by this test. */
    fork() { return em; },
    /** Run the callback within the fixture transaction and simulate its commit behavior. */
    async transactional<T>(callback: (transaction: EntityManager) => Promise<T>): Promise<T> {
      const priorSamples = samples.length;
      const deliveryBefore = delivery ? structuredClone(delivery) : undefined;
      const result = await callback(em as unknown as EntityManager);
      assert.equal(samples.length, priorSamples, 'Telemetry must wait until the transaction resolves');
      if (rejectCommit) {
        rejectCommit = false;
        if (delivery && deliveryBefore) Object.assign(delivery, deliveryBefore);
        throw new Error('fixture-commit-failure');
      }
      return result;
    },
    /** Return the fixture count used by bounded-admission or maintenance checks. */
    async count() { return 0; },
    /** Return this scenario's matching fixture record instead of querying a database. */
    async findOne(entity: unknown, where: Record<string, unknown>) {
      if (entity === ChannelReplySettings) return { mode: 'direct', rowRevision: 1, limits: { maxContextCharacters: 6000 }, approvedKnowledgeScope: { entryIds: [] } };
      if (entity === ConversationRequest) return request ?? null;
      if (entity === ReplyDelivery) return delivery && (!where.state || delivery.state === where.state) ? delivery : null;
      throw new Error('Unexpected entity lookup');
    },
    /** Return the fixture record set used by the selected owner query. */
    async find(_entity: unknown, where: Record<string, unknown>) {
      queries.push(where.state);
      if (!delivery) return [];
      return typeof where.state === 'string' ? (delivery.state === where.state ? [delivery] : [])
        : (['DISPATCHED', 'UNKNOWN'].includes(delivery.state) ? [delivery] : []);
    },
    /** Capture the record the service intends to persist in the fixture transaction. */
    persist(entity: unknown) {
      if (entity instanceof ConversationRequest) request = entity;
      if (entity instanceof ReplyDelivery) delivery = entity;
    },
  };
  const orm = { em } as unknown as MikroORM;
  const administration = { /** Supply the fixture installation/safety gate while preserving the service call order. */ async lockAdmission() { return { safetyRevision: 1 }; }, /** Return the isolated policy fixture used by admission and retention. */ async readPolicyConfig() { return defaultYunaPolicy; } } as unknown as GuildLifecycleService;
  const intake = {
    /** Simulate durable ingress and return the fixture event and delivery references. */
    async receiveInput() { return { revision: 1, eventId: sourceEventId, receipt: { claimGeneration: 1, /** Record that the fixture ingress receipt has completed. */ complete() {} } }; },
    /** Return the fixture current-source marker used by disclosure and delivery checks. */
    async current() { return { hash: message.sourceHash }; },
    /** This timing fixture uses one unchanged source; context invalidation has PostgreSQL coverage. */
    async validateContextBindings() { return true; },
  } as unknown as IntakeService;
  const tasks = {
    /** Capture the service's task registration and expose its durable task ID. */
    registerTask() { return taskId; },
    /** Return fixture result references available for owner acceptance. */
    async pendingResults() { return completion ? [completion] : []; },
    /** Record the fixture owner acknowledgment for atomicity assertions. */
    async acknowledge() { completion = undefined; },
    /** Report whether the test result still matches its owner binding. */
    async isResultCurrent() { return true; },
  } as unknown as TaskService;
  const transport: Pick<DiscordGateway, 'readSource' | 'sendReply' | 'findReply'> = {
    /** Return the simulated current Discord source and permission state. */
    async readSource() { return { exists: true, canSend: true, sourceHash: message.sourceHash }; },
    /** Capture one simulated send and return this scenario's chosen transport outcome. */
    async sendReply(payload) {
      sent.push(payload);
      await sendGate?.();
      if (rejectOutcomeCommit) rejectCommit = true;
      return outcome;
    },
    /** Return only the remotely attributed fixture reply during reconciliation. */
    async findReply() { reconciliations++; return null; },
  };
  /** Capture committed latency samples for this test. */
  const record = (sample: LatencySample) => { samples.push(sample); };
  const conversation = new ConversationService(orm, scope, 'fixture-model', administration, intake, tasks, record);
  const deliveryService = new ReplyDeliveryService(orm, scope, administration, intake, transport, tasks, record);
  return { message, samples, sent, queries, conversation, deliveryService,
    /** Expose the fixture conversation request for assertions. */
    get request() { return request!; }, /** Expose the fixture reply intent for assertions. */ get delivery() { return delivery!; }, /** Expose how many remote lookups the scenario performed. */ get reconciliations() { return reconciliations; },
    /** Arm the next simulated transaction commit failure. */
    failCommit() { rejectCommit = true; },
    /** Arm a failure while saving the observed transport outcome. */
    failOutcomeCommit() { rejectOutcomeCommit = true; },
    /** Select the result that the next simulated transport call will return. */
    setOutcome(value: DiscordSendResult) { outcome = value; },
    /** Pause the simulated send until the test explicitly releases it. */
    setSendGate(gate: () => Promise<void>) { sendGate = gate; },
    /** Complete the fixture observation and release its listeners or pending waiters. */
    finish(outcome: ConversationTaskCompletion['outcome'] = 'success') {
      completion = { taskId, resultId, requestId: request!.id, sourceEventId, sourceRevision: 1, safetyRevision: 1,
        outcome, payload: outcome === 'success' ? { text: 'private fixture reply', model: 'fixture-model', providerRequestId: 'secret-provider-id',
          inputTokens: 5, outputTokens: 5, totalTokens: 10, truncated: false } : null,
        resultCreatedAt: new Date(Date.now() - 400), queueWaitMs: 321 };
    },
  };
}

test('admission timings follow the commit and never expose message or user data', async () => {
  const f = harness();
  assert.equal(await f.conversation.receiveInput(f.message), 'admitted');
  assert.equal(f.samples.length, 1);
  assert.equal(f.samples[0]!.stage, 'admission_commit');
  assert.equal(f.samples[0]!.requestId, f.request.id);
  assert.equal(f.samples[0]!.outcome, 'admitted');
  assert.ok(!JSON.stringify(f.samples).includes('private'));
  assert.ok(!JSON.stringify(f.samples).includes(f.message.authorId));
  const failed = harness();
  failed.failCommit();
  await assert.rejects(failed.conversation.receiveInput(failed.message), /fixture-commit-failure/);
  assert.deepEqual(failed.samples, []);
});

test('accepted and discarded completions report persisted queue age and commit timing only after commit', async () => {
  for (const outcome of ['success', 'failure'] as const) {
    const f = harness();
    await f.conversation.receiveInput(f.message);
    f.samples.length = 0;
    f.finish(outcome);
    assert.equal(await f.conversation.acceptReplyResults(), outcome === 'success' ? 1 : 0);
    assert.deepEqual(f.samples.map(sample => sample.stage), ['completion_wait', 'acceptance_commit', 'queue_wait']);
    assert.ok(f.samples[0]!.durationMs >= 400);
    assert.equal(f.samples[2]!.durationMs, 321);
    assert.ok(f.samples.every(sample => sample.outcome === (outcome === 'success' ? 'accepted' : 'discarded')));
    assert.ok(f.samples.every(sample => sample.requestId === f.request.id));
  }
  const failed = harness();
  await failed.conversation.receiveInput(failed.message);
  failed.samples.length = 0;
  failed.finish();
  failed.failCommit();
  await assert.rejects(failed.conversation.acceptReplyResults(), /fixture-commit-failure/);
  assert.deepEqual(failed.samples, []);
});

test('confirmed Discord deliveries report request age once after outcome persistence', async () => {
  const f = harness();
  await f.conversation.receiveInput(f.message);
  f.finish();
  await f.conversation.acceptReplyResults();
  f.samples.length = 0;
  await f.deliveryService.dispatchReadyDeliveries(new AbortController().signal);
  assert.deepEqual(f.samples.map(sample => sample.stage), ['discord_delivery', 'end_to_end']);
  assert.ok(f.samples.every(sample => sample.requestId === f.request.id && sample.outcome === 'delivered'));
  assert.equal(f.sent.length, 1);
  assert.ok(!('requestId' in f.sent[0]!));
  await f.deliveryService.dispatchReadyDeliveries(new AbortController().signal);
  assert.equal(f.samples.length, 2);
  assert.equal(f.sent.length, 1);
});

test('the fast delivery scan neither reconciles unknown sends nor labels them successful', async () => {
  const f = harness();
  await f.conversation.receiveInput(f.message);
  f.finish();
  await f.conversation.acceptReplyResults();
  f.samples.length = 0;
  f.setOutcome({ classification: 'unknown', code: 'fixture-uncertain' });
  await f.deliveryService.dispatchReadyDeliveries(new AbortController().signal);
  assert.deepEqual(f.samples.map(sample => [sample.stage, sample.outcome]), [['discord_delivery', 'unknown']]);
  assert.equal(f.reconciliations, 0);
  assert.deepEqual(f.queries, ['READY']);
  await f.deliveryService.reconcileDueDeliveries(new AbortController().signal);
  assert.equal(f.reconciliations, 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.delivery.state, 'UNKNOWN');
});

test('failed dispatch or outcome commits emit no delivery success timings', async () => {
  for (const boundary of ['dispatch', 'outcome'] as const) {
    const f = harness();
    await f.conversation.receiveInput(f.message);
    f.finish();
    await f.conversation.acceptReplyResults();
    f.samples.length = 0;
    if (boundary === 'dispatch') f.failCommit(); else f.failOutcomeCommit();
    await assert.rejects(f.deliveryService.dispatch(f.delivery.id, new AbortController().signal), /fixture-commit-failure/);
    assert.deepEqual(f.samples, []);
    assert.equal(f.sent.length, boundary === 'dispatch' ? 0 : 1);
  }
});

test('reconciliation cannot fence an active send after thirty seconds or lose its confirmed response', async () => {
  const f = harness();
  await f.conversation.receiveInput(f.message);
  f.finish();
  await f.conversation.acceptReplyResults();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  f.setSendGate(async () => { entered(); await blocked; });
  const pending = f.deliveryService.dispatch(f.delivery.id, new AbortController().signal);
  await started;
  jest.useFakeTimers({ now: Date.now() + 31_000, doNotFake: ['performance'] });
  try {
    await f.deliveryService.reconcileDueDeliveries(new AbortController().signal);
    assert.equal(f.delivery.state, 'DISPATCHED');
    assert.equal(f.reconciliations, 0);
    // Duplicate callers share the original in-flight opportunity; they cannot send again.
    await f.deliveryService.dispatch(f.delivery.id, new AbortController().signal);
    assert.equal(f.sent.length, 1);
    release();
    await pending;
    assert.equal(f.delivery.state, 'DELIVERED');
    assert.ok(f.samples.some(sample => sample.stage === 'end_to_end'));
  } finally {
    release();
    try { await pending; } finally { jest.useRealTimers(); }
  }
});

test('a failed outcome commit releases active ownership so later recovery can reconcile without resending', async () => {
  const f = harness();
  await f.conversation.receiveInput(f.message);
  f.finish();
  await f.conversation.acceptReplyResults();
  f.failOutcomeCommit();
  await assert.rejects(f.deliveryService.dispatch(f.delivery.id, new AbortController().signal), /fixture-commit-failure/);
  assert.equal(f.delivery.state, 'DISPATCHED');
  jest.useFakeTimers({ now: Date.now() + 31_000, doNotFake: ['performance'] });
  try {
    await f.deliveryService.reconcileDueDeliveries(new AbortController().signal);
    assert.equal(f.delivery.state, 'UNKNOWN');
    assert.equal(f.reconciliations, 1);
    assert.equal(f.sent.length, 1);
  } finally { jest.useRealTimers(); }
});
