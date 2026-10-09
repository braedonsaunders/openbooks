import { z } from "zod";
export const schedulePdfLayoutSchema = z.strictObject({
  paperSize: z.enum(["letter", "a4", "legal", "tabloid"]),
  orientation: z.enum(["portrait", "landscape"]),
  marginMm: z.number().int().min(5).max(30),
  density: z.enum(["standard", "compact"]),
  daysPerSection: z.union([z.literal(7), z.literal(14)]),
  detail: z.enum(["assignments", "hours", "full"]),
});
export type SchedulePdfLayout = z.infer<typeof schedulePdfLayoutSchema>;
/** Stored native board policy; enabling and timing remain owned by Flows. */
export const automaticScheduleDeliverySchema = z
  .strictObject({
    operatorId: z.string().uuid(),
    timeZone: z
      .string()
      .min(1)
      .max(64)
      .refine((zone) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: zone });
          return true;
        } catch {
          return false;
        }
      }, "Choose a valid IANA time zone."),
    days: z.number().int().min(1).max(42),
    anchor: z.enum(["today", "week"]),
    weekStartsOn: z.number().int().min(0).max(6),
    visibility: z.enum(["personal", "board"]),
    recipientMode: z.enum(["automatic", "selected", "combined"]),
    subjectIds: z
      .array(z.string().uuid())
      .max(500)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Choose distinct native subjects.",
      )
      .default([]),
    cohort: z.enum(["scope", "scheduled", "supervisors", "self"]).optional(),
    additionalRoleKeys: z
      .array(z.string().min(1).max(80))
      .max(20)
      .refine(
        (keys) => new Set(keys).size === keys.length,
        "Choose distinct native roles.",
      )
      .default([]),
    additionalPartyIds: z
      .array(z.string().uuid())
      .max(500)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Choose distinct additional native contacts.",
      )
      .default([]),
    includePdf: z.boolean(),
    pdfLayout: schedulePdfLayoutSchema.nullable().optional(),
    message: z.string().max(4000).default(""),
  })
  .refine(
    (p) =>
      p.recipientMode !== "selected" ||
      p.subjectIds.length +
        p.additionalPartyIds.length +
        p.additionalRoleKeys.length >
        0,
    "Choose at least one explicit native recipient rule.",
  )
  .refine(
    (p) =>
      p.recipientMode !== "automatic" ||
      p.additionalPartyIds.length +
        p.additionalRoleKeys.length +
        p.subjectIds.length ===
        0,
    "Use combined delivery when adding explicit recipients to an automatic audience.",
  )
  .refine(
    (p) =>
      p.additionalPartyIds.length + p.additionalRoleKeys.length === 0 ||
      p.visibility === "board",
    "Additional contacts require explicitly shared whole-board reports.",
  );
export type AutomaticScheduleDeliveryPolicy = z.infer<
  typeof automaticScheduleDeliverySchema
>;
