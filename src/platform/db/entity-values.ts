/** Small storage values shared by records; business payloads stay with their owning feature. */
export interface RecordEntityInput {
  id?: string;
  createdAt?: Date;
}

export interface ScopedEntityInput extends RecordEntityInput {
  installationId: string;
  guildId: string;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Discord snowflakes remain decimal strings, including values above JS's safe integer range. */
export function assertDiscordId(value: string): void {
  invariant(typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value), 'Invalid Discord ID');
  invariant(BigInt(value) <= 18_446_744_073_709_551_615n, 'Discord ID exceeds uint64');
}

export function assertUuid(value: string): void {
  invariant(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value), 'Invalid UUID');
}

export function assertNonNegativeInteger(value: number, label: string): void {
  invariant(Number.isSafeInteger(value) && value >= 0, `${label} must be a nonnegative safe integer`);
}

export function assertDate(value: Date, label: string): void {
  invariant(value instanceof Date && Number.isFinite(value.getTime()), `${label} must be a valid date`);
}

/** Detach caller-owned JSON and reject values PostgreSQL JSONB cannot faithfully preserve. */
export function copyJson<T>(value: T): T {
  const ancestors = new Set<object>();
  function validate(item: unknown): void {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      invariant(Number.isFinite(item), 'JSON numbers must be finite');
      return;
    }
    invariant(typeof item === 'object', 'Payload must contain only JSON values');
    invariant(!ancestors.has(item), 'JSON payload must not contain cycles');
    invariant(Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null, 'Payload must use plain JSON objects');
    ancestors.add(item);
    for (const child of Object.values(item)) validate(child);
    ancestors.delete(item);
  }
  validate(value);
  return structuredClone(value);
}
