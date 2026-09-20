import { z } from "zod";

/**
 * profile_change payload contract (HR-9).
 *
 * A leaf module — zod only, zero engine imports — so both the
 * change-request service (engine/src/hrm/change-requests.ts, which owns
 * the kind vocabulary and the approval application) and the self-service
 * orchestration (profile-changes.ts, same directory) share one schema
 * with no import cycle.
 *
 * Field semantics: a MISSING key leaves the field untouched; an explicit
 * null clears a scalar (phone, personal email, emergency contact); the
 * address object is a full replacement of the profile address row (the
 * client prefills it from the current row, so a partial edit that drops
 * a line reads as clearing that line — stated, tested, and rendered in
 * the edit drawer). At least one key must be present or the proposal
 * changes nothing and is refused.
 */

export const PAYLOAD_SCHEMA_VERSION_PROFILE = "1";

const nonBlank = (field: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${field} must not be blank`)
    .max(max, `${field} must be at most ${max} characters`);

const optionalText = (field: string, max: number) =>
  z.string().trim().max(max, `${field} must be at most ${max} characters`);

export const profileAddressSchema = z
  .object({
    line1: nonBlank("address.line1", 240),
    line2: optionalText("address.line2", 240).nullable().default(null),
    city: optionalText("address.city", 120).nullable().default(null),
    region: optionalText("address.region", 120).nullable().default(null),
    postalCode: optionalText("address.postalCode", 32).nullable().default(null),
    // Free text, never validated against a registry: no hardcoded country
    // fact may decide whether a person's address is well-formed.
    country: optionalText("address.country", 64).nullable().default(null),
  })
  .strict();

export const profileEmergencyContactSchema = z
  .object({
    name: optionalText("emergencyContact.name", 240).nullable().default(null),
    relationship: optionalText("emergencyContact.relationship", 120).nullable().default(null),
    phone: optionalText("emergencyContact.phone", 40).nullable().default(null),
  })
  .strict()
  .superRefine((contact, ctx) => {
    if (contact.name === null && contact.relationship === null && contact.phone === null) {
      ctx.addIssue({
        code: "custom",
        message: "emergencyContact names nothing — give at least one of name, relationship, or phone, or clear it with null",
      });
    }
  });

export const profileChangePayloadSchema = z
  .object({
    kind: z.literal("profile_change"),
    phone: nonBlank("phone", 40).nullable().optional(),
    email: z.string().trim().max(254, "email must be at most 254 characters").nullable().optional(),
    address: profileAddressSchema.optional(),
    emergencyContact: profileEmergencyContactSchema.nullable().optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (
      payload.phone === undefined &&
      payload.email === undefined &&
      payload.address === undefined &&
      payload.emergencyContact === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "a profile change must set at least one of phone, email, address, or emergencyContact — file nothing when nothing changes",
      });
    }
    if (typeof payload.email === "string") {
      const email = payload.email.trim();
      if (email.length === 0 || !email.includes("@") || email.includes(" ")) {
        ctx.addIssue({ code: "custom", message: "email must be a deliverable address with an @ sign" });
      }
    }
  });

export type ProfileChangePayload = z.infer<typeof profileChangePayloadSchema>;
export type ProfileAddress = z.infer<typeof profileAddressSchema>;
export type ProfileEmergencyContact = z.infer<typeof profileEmergencyContactSchema>;
