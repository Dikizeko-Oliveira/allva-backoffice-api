import { Prisma } from 'generated/prisma/client';

/**
 * Bridges the domain's `Record<string, unknown>` to Prisma's `InputJsonValue`
 * when writing a `Json` column.
 *
 * The two describe the same runtime value; they disagree only on paper, because
 * `unknown` members are not assignable to `InputJsonValue`. Every caller here
 * holds a value that is JSON by construction — it came from `JSON.parse` on a
 * provider response, or from an object literal the code just built.
 *
 * The point of centralising it is that this is the *only* unsound step. The
 * repositories used to reach for `(this.prisma as any)`, which silenced type
 * checking on the entire delegate — every column, every `where`, every result —
 * to work around this one mismatch.
 */
export function toPrismaJson(
  value: Record<string, unknown>,
): Prisma.InputJsonValue;
export function toPrismaJson(
  value: Record<string, unknown> | undefined,
): Prisma.InputJsonValue | undefined;
export function toPrismaJson(
  value: Record<string, unknown> | undefined,
): Prisma.InputJsonValue | undefined {
  return value as Prisma.InputJsonValue | undefined;
}

/** Reads a `Json` column back as an object, defending against the shapes the
 *  database can legitimately hold regardless of what the entity promises. */
export function fromPrismaJsonObject(
  value: Prisma.JsonValue,
): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Reads a `Json` column back as a string list, dropping non-string members. */
export function fromPrismaJsonStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
