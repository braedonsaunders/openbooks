type JsonPrimitive = string | number | boolean | null;
export type CanonicalJsonValue =
  | JsonPrimitive
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

export class NonJsonValueError extends Error {
  readonly name = "NonJsonValueError";
}

/**
 * Normalize a value into OpenBooks canonical JSON v1.
 *
 * Object keys are sorted recursively while array order is preserved. Dates and
 * bigint values receive stable JSON representations, undefined object fields
 * are omitted, and unsafe/non-JSON values are rejected. Hashes produced from
 * this representation survive a jsonb store/read cycle and can therefore be
 * independently reproduced from downloaded audit evidence.
 */
export function toCanonicalJsonValue(value: unknown): CanonicalJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new NonJsonValueError("non-finite number");
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toCanonicalJsonValue);
  if (typeof value === "object") {
    const out: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(value as object).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = toCanonicalJsonValue(child);
    }
    return out;
  }
  throw new NonJsonValueError("unsupported JSON value");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalJsonValue(value));
}
