import { createHash } from "node:crypto";

type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export class NonJsonValueError extends Error {
  readonly name = "NonJsonValueError";
}

export function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new NonJsonValueError("non-finite number");
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as object).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = toJsonValue(child);
    }
    return out;
  }
  throw new NonJsonValueError("unsupported JSON value");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toJsonValue(value));
}

export function requestHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
