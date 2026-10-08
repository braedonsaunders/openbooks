import { z } from "zod";
import { normalizeMoney } from "@openbooks/engine/money";
import { canonicalDecimal } from "../exact-decimal";
import { isUuid } from "../list-params";

/**
 * Object-only transition schema for routes that retain narrower field and
 * lifecycle validation in their existing domain code. It still closes the
 * malformed/null/array body gap and keeps all JSON decoding on this boundary.
 */
export const jsonObject = z.looseObject({}) as z.ZodType<Record<string, unknown>>;

/**
 * Boundary atoms for financial bodies. Money crosses the wire as decimal
 * text and is canonicalized through the exact-decimal primitives. JSON
 * numbers are refused because they have already crossed IEEE-754 before zod
 * can inspect them.
 */

/** Exact numeric(19,4)-scale money string ("1234.5", "-10", "0.0001"). */
export function exactMoney(message = "must be a decimal string; JSON numbers are refused to preserve precision") {
  return z
    .preprocess(
      // Absent/null amounts funnel through the same refusal as junk input,
      // so a required-money field always fails with the caller's message.
      (v) => (v === undefined || v === null ? "" : v),
      z.unknown()
        .refine((v) => toExactMoney(v) !== null, message)
        .transform((v) => toExactMoney(v)!),
    );
}

function toExactMoney(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const exact = canonicalDecimal(v, 4);
  if (exact === null) return null;
  try {
    return normalizeMoney(exact);
  } catch {
    return null;
  }
}

const UUID_MESSAGE = "must be a valid id";

/** A tenant-entity uuid reference. */
export const uuidId = z.string().refine(isUuid, UUID_MESSAGE);

/** Assign a warehouse to one approved order line. */
export const assignWarehouseBody = z.object({
  lineId: uuidId,
  stockLocationId: uuidId,
  expectedUpdatedAt: z.string().optional(),
});

/** Optional nullable uuid reference (null clears the reference). */
export const nullableUuidId = z
  .union([z.string(), z.null()])
  .refine((v) => v === null || isUuid(v), UUID_MESSAGE);

/** Calendar date (YYYY-MM-DD), matching every document-date column. */
export const ISO_DATE_RE = z.regexes.date;

export function isoDate(message = "must be YYYY-MM-DD") {
  return z.string({ error: message }).regex(ISO_DATE_RE, message)
    .refine((value) => !value.startsWith("0000-"), message);
}

/** One unsaved-create order line: references stay uuid-or-null, numerics stay
 *  strings for the exact-decimal domain check, dims stay a string map. */
export const orderCreateLineBody = z.object({
  itemId: nullableUuidId.optional(),
  accountId: nullableUuidId.optional(),
  description: z.string().nullable().optional(),
  quantity: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  unitPrice: z.string().nullable().optional(),
  taxCodeId: nullableUuidId.optional(),
  taxGroupId: nullableUuidId.optional(),
  departmentId: nullableUuidId.optional(),
  projectId: nullableUuidId.optional(),
  stockLocationId: nullableUuidId.optional(),
  workFrom: isoDate().nullable().optional(),
  workTo: isoDate().nullable().optional(),
  extraDims: z.record(z.string(), z.string().nullable()).optional(),
  // Preview provenance only signals that the line was catalog priced. Save
  // derives its authoritative basis from the server's item-price resolver;
  // no client-supplied field is persisted.
  priceBasis: z.unknown().optional(),
});

/**
 * Unsaved-create collection body (quote / sales_order / purchase_order).
 * Shape only — the create kernel still owns calendar, subsidiary, segment,
 * warehouse, inventory and tenant-reference refusal. Creation always yields
 * draft, so any other status is a 400 here, never an issued order.
 */
export const orderCreateBody = z.object({
  partyId: nullableUuidId.optional(),
  documentDate: isoDate().optional(),
  dueDate: isoDate().nullable().optional(),
  workCompletedOn: isoDate().nullable().optional(),
  memo: z.string().nullable().optional(),
  departmentId: nullableUuidId.optional(),
  projectId: nullableUuidId.optional(),
  subsidiaryId: nullableUuidId.optional(),
  extraDims: z.record(z.string(), z.string().nullable()).optional(),
  lines: z.array(orderCreateLineBody).optional(),
  status: z.literal("draft").optional(),
});

export type OrderCreateBody = z.output<typeof orderCreateBody>;
