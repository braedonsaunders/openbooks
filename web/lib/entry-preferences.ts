import { z } from "zod";

/**
 * Personal data-entry preferences. They change how the keyboard behaves for
 * one person and never what gets recorded: every amount, account and date is
 * still validated by the same commands whatever these say.
 *
 *  - enterMovesToNextField: Enter advances to the next field (and from the
 *    last cell of a line to the next line) instead of moving down a column,
 *    for people trained on Enter-driven desktop systems.
 *  - autoDecimal: typing digits only in an amount places the decimal point
 *    before the currency's minor units (1785 → 17.85), for ten-key entry.
 *  - keepDateOnNew / keepPartyOnNew: Save & new carries the document date
 *    (and the vendor or customer) into the next form, for batches of bills
 *    from one statement or one day.
 *  - recallLastDocument: picking a vendor or customer on a new document
 *    offers ("suggest"), applies ("apply") or ignores ("off") the lines of
 *    their most recent document of the same kind.
 */
export const ENTRY_PREFERENCES_SCHEMA = z
  .object({
    enterMovesToNextField: z.boolean(),
    autoDecimal: z.boolean(),
    keepDateOnNew: z.boolean(),
    keepPartyOnNew: z.boolean(),
    recallLastDocument: z.enum(["off", "suggest", "apply"]),
  })
  .strict();

export type EntryPreferences = z.infer<typeof ENTRY_PREFERENCES_SCHEMA>;

export const DEFAULT_ENTRY_PREFERENCES: EntryPreferences = {
  enterMovesToNextField: false,
  autoDecimal: false,
  keepDateOnNew: true,
  keepPartyOnNew: false,
  recallLastDocument: "suggest",
};

/** A partial update: only the named preferences change. */
export const ENTRY_PREFERENCES_PATCH_SCHEMA = ENTRY_PREFERENCES_SCHEMA.partial().strict();

/**
 * Stored preferences merged over the defaults. Unknown or malformed stored
 * keys are ignored key by key, so a preference added later never invalidates
 * the rest of a person's choices.
 */
export function resolveEntryPreferences(stored: unknown): EntryPreferences {
  const resolved: EntryPreferences = { ...DEFAULT_ENTRY_PREFERENCES };
  if (!stored || typeof stored !== "object") return resolved;
  const shape = ENTRY_PREFERENCES_SCHEMA.shape;
  for (const key of Object.keys(shape) as (keyof EntryPreferences)[]) {
    const parsed = shape[key].safeParse((stored as Record<string, unknown>)[key]);
    if (parsed.success) (resolved as Record<string, unknown>)[key] = parsed.data;
  }
  return resolved;
}
