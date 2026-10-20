import assert from 'node:assert/strict';
import { test } from '@jest/globals';
import { copyJson } from '../../src/platform/db/entity-values.js';

test('valid JSON can be copied repeatedly without changing prototypes, values or ownership', () => {
  const shared = { value: 'original' };
  const input = { nested: [shared, shared], zero: -0, ['__proto__']: { value: 'data' } };
  const first = copyJson(input);
  const second = copyJson(first);
  assert.deepEqual(second, input);
  assert.equal(Object.getPrototypeOf(second), Object.prototype);
  assert.equal(Object.getPrototypeOf(second.nested), Array.prototype);
  assert.equal(Object.getPrototypeOf(second.nested[0]), Object.prototype);
  assert.equal(second.nested[0], second.nested[1]);
  assert.notEqual(second.nested[0], first.nested[0]);
  shared.value = 'changed';
  assert.equal(second.nested[0]?.value, 'original');
  assert.ok(Object.is(second.zero, -0));
  assert.ok(Object.hasOwn(second, '__proto__'));
  assert.throws(() => copyJson({ invalid: new Date() }), /plain JSON/);
});

test('the Jest clone bridge retains native cycles, sparse arrays, transfer and rejection behavior', () => {
  const input: { self?: unknown; sparse: unknown[] } = { sparse: new Array(2) };
  input.self = input;
  const cloned = structuredClone(input);
  assert.notEqual(cloned, input);
  assert.equal(cloned.self, cloned);
  assert.equal(cloned.sparse.length, 2);
  assert.equal(0 in cloned.sparse, false);
  assert.throws(() => copyJson(cloned), /cycles/);
  const buffer = new ArrayBuffer(1);
  new Uint8Array(buffer)[0] = 42;
  const transferred = structuredClone({ buffer }, { transfer: [buffer] });
  assert.equal(buffer.byteLength, 0);
  assert.equal(new Uint8Array(transferred.buffer)[0], 42);
  assert.throws(() => structuredClone(() => undefined), { name: 'DataCloneError' });
});
