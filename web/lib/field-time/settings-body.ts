import { z } from "zod";

/**
 * The transport shape of the field-time rules PUT body. Every key accepts an
 * explicit null: null is "no declaration", exactly like a missing key, and
 * must reach validateFieldTimeSettings — which names the missing rule and
 * its remedy — rather than failing closed here with an unnamed type error.
 * Only a key of the wrong TYPE is refused at this boundary (a broken client,
 * not an unconfigured org), and that refusal keeps the field path in
 * `issues`.
 */
export const fieldTimeSettingsBody = z.object({
  roundingIncrement: z.number().nullable().optional(),
  roundingMode: z.string().nullable().optional(),
  unpaidBreakMinutes: z.number().nullable().optional(),
  autoCloseHours: z.number().nullable().optional(),
  signatureRequired: z.boolean().nullable().optional(),
  equipmentToleranceHours: z.string().nullable().optional(),
  photoRequired: z.boolean().nullable().optional(),
});

export type FieldTimeSettingsBody = z.output<typeof fieldTimeSettingsBody>;

/**
 * Normalize explicit nulls to absent before domain validation. Every rule
 * stays undeclared until supplied; a cleared rule receives the same named
 * refusal and remedy as a never-set rule.
 */
export function normalizeFieldTimeSettingsBody(
  body: FieldTimeSettingsBody,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [key, value === null ? undefined : value]),
  );
}
