/** Dedicated session ownership must fail closed on loss and release after partial startup/shutdown. */
import { EventEmitter } from 'node:events';
import type { MikroORM } from '@mikro-orm/postgresql';
import { expect, jest, test, afterEach } from '@jest/globals';
import { createBotOwnership } from '../../src/platform/runtime/bot-ownership.js';

afterEach(() => { jest.useRealTimers(); });
/** The SQL session is the mocked boundary; assertions exercise lifecycle and loss behavior. */
function fixture(acquired = true) {
  const client = Object.assign(new EventEmitter(), {
    query: jest.fn(async (sql: string) => ({ rows: sql.includes('pg_try') ? [{ acquired }] : [] })),
    release: jest.fn(),
  });
  const connect = jest.fn(async () => client);
  const orm = { em: { getConnection: () => ({ getNativeClient: async () => ({ connect }) }) } } as unknown as MikroORM;
  const lost = jest.fn();
  return { client, connect, lost, resource: createBotOwnership(() => orm, '123', lost) };
}

test('ownership loss fires once, never reconnects, and shutdown destroys its dedicated session', async () => {
  jest.useFakeTimers();
  const f = fixture();
  await f.resource.start(new AbortController().signal);
  f.client.emit('error', new Error('private driver message')); f.client.emit('end');
  await f.resource.failure;
  expect(f.lost).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(10_000);
  expect(f.client.query).toHaveBeenCalledTimes(2);
  await f.resource.stop(); await f.resource.stop();
  expect(f.client.release).toHaveBeenCalledTimes(1);
  expect(f.client.release).toHaveBeenCalledWith(true);
  f.client.emit('error', new Error('late')); expect(f.lost).toHaveBeenCalledTimes(1);
});

test('a competing owner rejects startup and the application can clean the attempted resource', async () => {
  const f = fixture(false);
  await expect(f.resource.start(new AbortController().signal)).rejects.toThrow('Bot ownership unavailable');
  await f.resource.stop(); expect(f.client.release).toHaveBeenCalledWith(true);
});

test('heartbeat storage failure closes ownership without exposing the driver error', async () => {
  jest.useFakeTimers(); const f = fixture();
  await f.resource.start(new AbortController().signal);
  f.client.query.mockRejectedValueOnce(new Error('private query'));
  await jest.advanceTimersByTimeAsync(5_000);
  expect(f.lost).toHaveBeenCalledTimes(1);
  await f.resource.stop();
});

test('a silently stalled heartbeat fails once at its local deadline and never resumes after a late answer', async () => {
  jest.useFakeTimers(); const f = fixture();
  await f.resource.start(new AbortController().signal);
  let answer!: (value: { rows: { acquired: boolean }[] }) => void;
  f.client.query.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  await jest.advanceTimersByTimeAsync(5_000);
  expect(f.client.query).toHaveBeenCalledTimes(3);
  await jest.advanceTimersByTimeAsync(4_999); expect(f.lost).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1); await f.resource.failure;
  expect(f.lost).toHaveBeenCalledTimes(1);
  answer({ rows: [] }); await jest.advanceTimersByTimeAsync(20_000);
  expect(f.client.query).toHaveBeenCalledTimes(3); expect(f.lost).toHaveBeenCalledTimes(1);
  await f.resource.stop(); expect(f.client.release).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('shutdown cancels a pending heartbeat deadline and ignores its late rejection', async () => {
  jest.useFakeTimers(); const f = fixture();
  await f.resource.start(new AbortController().signal);
  let rejectQuery!: (error: Error) => void;
  f.client.query.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectQuery = reject; }));
  await jest.advanceTimersByTimeAsync(5_000); await f.resource.stop();
  await jest.advanceTimersByTimeAsync(20_000);
  rejectQuery(new Error('private late socket failure')); await jest.advanceTimersByTimeAsync(0);
  expect(f.lost).not.toHaveBeenCalled(); expect(f.client.query).toHaveBeenCalledTimes(3);
  expect(f.client.release).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});

test('a stalled connection acquisition reports failure and a late session cannot start ownership', async () => {
  jest.useFakeTimers(); const f = fixture();
  let connect!: (client: typeof f.client) => void;
  f.connect.mockImplementationOnce(() => new Promise(resolve => { connect = resolve; }));
  const pending = f.resource.start(new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow('Bot ownership unavailable');
  await jest.advanceTimersByTimeAsync(5_000); await f.resource.failure;
  expect(f.lost).toHaveBeenCalledTimes(1);
  connect(f.client); await rejected; await f.resource.stop();
  expect(f.client.query).not.toHaveBeenCalled(); expect(f.client.release).toHaveBeenCalledWith(true);
  expect(jest.getTimerCount()).toBe(0);
});

test('a stalled setup query cannot acquire ownership after its watchdog has fired', async () => {
  jest.useFakeTimers(); const f = fixture();
  let answer!: (value: { rows: { acquired: boolean }[] }) => void;
  f.client.query.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  const pending = f.resource.start(new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow('Bot ownership unavailable');
  await jest.advanceTimersByTimeAsync(5_000); await f.resource.failure;
  expect(f.lost).toHaveBeenCalledTimes(1);
  answer({ rows: [] }); await rejected; await f.resource.stop();
  expect(f.client.query).toHaveBeenCalledTimes(1); expect(f.client.release).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
});

test('a session arriving after shutdown is destroyed without starting queries or reporting loss', async () => {
  jest.useFakeTimers(); const f = fixture();
  let connect!: (client: typeof f.client) => void;
  f.connect.mockImplementationOnce(() => new Promise(resolve => { connect = resolve; }));
  const pending = f.resource.start(new AbortController().signal);
  const rejected = expect(pending).rejects.toThrow('Bot ownership unavailable');
  await jest.advanceTimersByTimeAsync(0); await f.resource.stop();
  connect(f.client); await rejected; await jest.advanceTimersByTimeAsync(20_000);
  f.client.emit('error', new Error('private late socket failure'));
  expect(f.lost).not.toHaveBeenCalled(); expect(f.client.query).not.toHaveBeenCalled();
  expect(f.client.release).toHaveBeenCalledTimes(1); expect(f.client.release).toHaveBeenCalledWith(true);
  expect(jest.getTimerCount()).toBe(0);
});
