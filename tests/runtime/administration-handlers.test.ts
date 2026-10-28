/** Command routing must bind the running installation and disclose only explicit operational fields. */
import { expect, test, jest } from '@jest/globals';
import { handleAdministrationCommand, type AdministrationCommands } from '../../apps/bot/discord.handlers.js';
import type { NormalizedAdministrationCommand } from '../../src/discord/contracts.js';

const identity = { actorId: '1', guildId: '2', channelId: '3', sourceRequestId: '4' };
/** Narrow service fakes expose each argument without database or Discord credentials. */
function fixture() {
  const calls: unknown[] = [];
  const status = { installationId: 'install', installationState: 'active' as const, cleanupProgress: {}, installationRevision: 8, policyRevision: 2, usagePolicyRevision: 1,
    paused: false, safetyRevision: 3, featureAdmission: { community: 'enabled' as const }, grants: [], pendingRequests: 2,
    readyDeliveries: 1, unknownDeliveries: 0, secret: 'never-display' };
  const grant = { grantId: 'grant', granteeUserId: '1', capability: 'guild.pause', scope: { channelIds: [], targetUserIds: [] }, expiresAt: null, revoked: false, authorityRevision: 0, rowRevision: 1 };
  const services: AdministrationCommands = {
    scope: { installationId: 'trusted-install', guildId: '2' },
    authority: { /** Capture a bootstrap request without granting real permissions. */ async bootstrapOwner(caller) { calls.push(caller); return grant; },
      /** Capture the exact requested capability grant for handler assertions. */
      async grantCapability(caller, input) { calls.push([caller, input]); return grant; },
      /** Capture the requested grant revision and revocation reason. */
      async revokeGrant(caller, input) { calls.push([caller, input]); return { ...grant, revoked: true }; } },
    safety: { /** Capture the revision-bound pause request for handler assertions. */ async pauseGuild(caller, input) { calls.push([caller, input]); return { paused: true, safetyRevision: 4, reasonCode: 'manual' }; },
      /** Capture the revision-bound resume request for handler assertions. */
      async resumeGuild(caller, input) { calls.push([caller, input]); return { paused: false, safetyRevision: 4, reasonCode: null }; } },
    configuration: { /** Return a bounded operator-status fixture for response-format assertions. */ async status(caller) { calls.push(caller); return status; },
      /** Capture the validated configuration and expected revision passed by the command. */
      async applyConfiguration(caller, config, revision) { calls.push([caller, config, revision]); return { policyRevision: 3, usagePolicyRevision: 2, changed: true }; },
      /** Capture the exact channel configuration requested by the handler. */
      async updateChannelSettings(caller, input) { calls.push([caller, input]); return { ...input, rowRevision: 2 }; } },
    removal: { /** Capture the installation revision used for removal admission. */ async beginRemoval(caller, revision) { calls.push([caller, revision]); return { state: 'removing', installationRevision: 9 }; } },
  };
  return { services, calls };
}

test('commands bind the active installation separately from normalized arguments', async () => {
  const { services, calls } = fixture();
  expect(await handleAdministrationCommand({ ...identity, command: 'bootstrap', arguments: {} }, services)).toContain('Owner enrollment is ready');
  expect(calls[0]).toEqual({ actorId: '1', guildId: '2', installationId: 'trusted-install', sourceRequestId: '4' });
  expect(await handleAdministrationCommand({ ...identity, guildId: '9', command: 'bootstrap', arguments: {} }, services)).toContain('does not belong');
  expect(calls).toHaveLength(1);
});

test('status allowlists fields and configuration loads defaults with the observed expected revision', async () => {
  const { services, calls } = fixture();
  const output = await handleAdministrationCommand({ ...identity, command: 'status', arguments: {} }, services);
  expect(output).toContain('revision 8'); expect(output).not.toContain('never-display');
  expect(await handleAdministrationCommand({ ...identity, command: 'configure', arguments: {} }, services)).toContain('Configuration applied');
  expect((calls[2] as unknown[])[2]).toBe(2);
  expect((calls[2] as unknown[])[1]).toMatchObject({ moderation: { enabled: false }, usage: { dailyBudget: null } });
});

test.each([
  { command: 'pause', arguments: { expectedSafetyRevision: 3, reasonCode: 'manual' } },
  { command: 'resume', arguments: { expectedSafetyRevision: 3 } },
  { command: 'channel', arguments: { channelId: '3', mode: 'silent', expectedRowRevision: 1 } },
  { command: 'remove', arguments: { expectedInstallationRevision: 8 } },
  { command: 'revoke', arguments: { grantId: 'grant', expectedAuthorityRevision: 0, expectedRowRevision: 1, reasonCode: 'manual' } },
  { command: 'grant', arguments: { granteeUserId: '1', capability: 'guild.pause', scope: { channelIds: [], targetUserIds: [] }, sourceOperationKey: 'grant', expiresAt: null } },
])('routes $command through the appropriate owner', async command => {
  const { services, calls } = fixture();
  const output = await handleAdministrationCommand({ ...identity, ...command } as NormalizedAdministrationCommand, services);
  expect(output).not.toContain('not applied'); expect(calls).toHaveLength(1);
});

test('storage/native/configuration errors never disclose their original text', async () => {
  const { services } = fixture();
  services.configuration.status = jest.fn(async () => { throw new Error('secret-password-and-body'); });
  const response = await handleAdministrationCommand({ ...identity, command: 'status', arguments: {} }, services);
  expect(response).toContain('not applied'); expect(response).not.toContain('secret');
});

test('channel status binds the trusted caller and displays only the selected channel mode and revision', async () => {
  const { services, calls } = fixture();
  /** Capture the authorized channel request and include an unlisted field to prove response selection. */
  services.configuration.readChannelSettings = async (caller, input) => {
    calls.push([caller, input]); return { channelId: input.channelId, mode: 'silent', rowRevision: 7, secret: 'private-source' };
  };
  const command = { ...identity, command: 'channel-status' as const, arguments: { channelId: '99' } };
  expect(await handleAdministrationCommand(command, services)).toBe('Channel 99: silent; row revision 7.');
  expect(calls).toEqual([[{ ...services.scope, actorId: identity.actorId, sourceRequestId: identity.sourceRequestId }, { channelId: '99' }]]);
  delete services.configuration.readChannelSettings;
  expect(await handleAdministrationCommand(command, services)).toContain('unavailable');
});

test('sanction responses report recorded state without claiming execution, and report intake never implies a violation', async () => {
  const { services, calls } = fixture();
  services.staffModeration = { /** Capture the exact staff ban request without executing any sanction. */ async requestBan(caller, input) { calls.push([caller, input]); return { status: 'accepted', actionId: 'action', kind: 'ban', state: 'READY' }; },
    /** Return a bounded action-status fixture without exposing moderation evidence. */
    async readActionStatus() { return { actionId: 'action', kind: 'ban', state: 'UNKNOWN', unresolved: true, reasonCode: 'timeout' }; },
    /** Capture the exact administrator unban request without executing it. */
    async requestUnban(caller, input) { calls.push([caller, input]); return { status: 'accepted', actionId: 'action', kind: 'unban', state: 'UNKNOWN' }; } };
  services.moderation = { /** Capture the report as an allegation rather than creating original evidence. */ async ingestReport(caller, input) { calls.push([caller, input]); return { status: 'recorded', case: {
    caseId: 'case', evidenceRevisionId: null, policyRevisionId: 'policy', phase: 'complete', disposition: 'incomplete', reasonCode: 'original_capture_missing', duplicate: false } }; } };
  expect(await handleAdministrationCommand({ ...identity, command: 'ban', arguments: { targetUserId: '5', reason: 'Explicit', deleteMessageSeconds: 0 } }, services)).toContain('READY');
  expect(await handleAdministrationCommand({ ...identity, command: 'unban', arguments: { targetUserId: '5', reason: 'Explicit' } }, services)).toContain('UNKNOWN');
  expect(await handleAdministrationCommand({ ...identity, command: 'report', arguments: { channelId: '3', messageId: '6', allegation: 'Report' } }, services)).toContain('does not establish a violation');
  expect((calls[0] as unknown[])[0]).toEqual({ ...services.scope, actorId: identity.actorId, sourceRequestId: identity.sourceRequestId });
});

test('personal quota commands derive the current actor and disclose only bounded self-service facts', async () => {
  const { services, calls } = fixture();
  const status = { windowStart: 'start', windowEnd: 'end', attemptsUsed: 2, attemptLimit: 4, attemptsRemaining: 2,
    dailyBudget: null, committedAmount: null, unknownCostAttempts: 1, blockedReason: null, personalLimit: null, secret: 'private-other-user' };
  services.userUsage = { /** Return only the requesting member's usage-status fixture. */ async readStatus(caller) { calls.push(caller); return status; },
    /** Capture the personal usage limit supplied by the handler. */
    async setLimit(caller, input) { calls.push([caller, input]); return status; }, /** Capture removal of the requester's personal preference. */ async clearLimit(caller) { calls.push(caller); return status; } };
  for (const command of [
    { ...identity, command: 'usage', arguments: {} }, { ...identity, command: 'limit-clear', arguments: {} },
    { ...identity, command: 'limit', arguments: { dailyAttemptLimit: 0 } },
  ] as NormalizedAdministrationCommand[]) {
    const response = await handleAdministrationCommand(command, services);
    expect(response).toContain('unknownCostAttempts'); expect(response).not.toContain('private-other-user');
  }
  expect(calls[0]).toEqual({ ...services.scope, actorId: identity.actorId, sourceRequestId: identity.sourceRequestId });
});
