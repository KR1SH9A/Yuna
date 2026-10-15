import { assertNonNegativeInteger, invariant } from '../../../platform/db/entity-values.js';

/** PostgreSQL integer counters must fail before overflowing or losing an execution fence. */
export function nextCounter(value: number): number {
  assertNonNegativeInteger(value, 'counter');
  invariant(value < 2147483647, 'Counter exhausted its storage range');
  return value + 1;
}
