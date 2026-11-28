import { z } from 'zod';

/** Upper bound for a single price/cost: $1,000,000.00 MXN in centavos. */
export const MAX_UNIT_CENTS = 100_000_000;
/** PostgreSQL `integer` upper bound; order totals must stay below it. */
export const MAX_INT4 = 2_147_483_647;

export const centsSchema = z.number().int().min(0).max(MAX_UNIT_CENTS);

/** Converts a PostgreSQL bigint/numeric aggregate (returned as string) to a safe JS integer. */
export function toInt(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`Aggregate is not a safe integer: ${String(value)}`);
  return n;
}
