/**
 * HR-20 feature keys and org settings.
 *
 * fieldTime is the parent (parentKey timeTracking, requiresAll
 * projects): office orgs never see a clock. Sub-features hide optional
 * complexity; turning any off stops rendering and writing, never data.
 */

export const FIELD_TIME_FEATURE = "fieldTime" as const;
export const FIELD_TIME_GEOFENCE_FEATURE = "fieldTimeGeofence" as const;
export const FIELD_TIME_PHOTO_FEATURE = "fieldTimePhoto" as const;
export const FIELD_TIME_KIOSK_FEATURE = "fieldTimeKiosk" as const;
export const FIELD_TIME_CREW_ENTRY_FEATURE = "fieldTimeCrewEntry" as const;
export const FIELD_TIME_EQUIPMENT_FEATURE = "fieldTimeEquipment" as const;
export const FIELD_TIME_MULTI_STAGE_APPROVAL_FEATURE = "fieldTimeMultiStageApproval" as const;

export { CREW_TIME_BATCH_SUBJECT_KIND } from "../../flows/crew-batches-adapter.ts";

/** Permissions: self clock, foreman entry, kiosk devices. */
export const FIELD_TIME_PERMISSIONS = [
  "time.clock",
  "time.crew.enter",
  "time.kiosk.manage",
] as const;

import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { FieldTimeError } from "./errors.ts";
import type { RoundingRule } from "./pure.ts";

/**
 * Declared field-time rules (Timesheets setup). Every rule is required —
 * there is intentionally no silent default: guessing a rounding rule or
 * an auto-close window rewrites hours nobody typed.
 */
export interface FieldTimeSettings {
  rounding: RoundingRule;
  /** Minutes per shift auto-deducted when no longer break is recorded. */
  unpaidBreakMinutes: number;
  /** Open pairs older than this are auto-closed with a flag, never silently. */
  autoCloseHours: number;
  /** Sign-and-submit needs a signature before a batch may be submitted. */
  signatureRequired: boolean;
  /** Equipment hours may exceed entry hours by this much. */
  equipmentToleranceHours: string;
  /** Mobile clock events need a photo even outside a photo kiosk. */
  photoRequired: boolean;
}

export function validateFieldTimeSettings(raw: unknown): FieldTimeSettings {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const increment = rec.roundingIncrement;
  if (increment !== 0 && increment !== 6 && increment !== 15) {
    throw new FieldTimeError(
      "rounding_not_declared",
      "Rounding is not declared — set rounding to none, 6 or 15 minutes in Timesheets setup before anyone clocks in",
    );
  }
  const mode = rec.roundingMode ?? "nearest";
  if (mode !== "nearest" && mode !== "up" && mode !== "down") {
    throw new FieldTimeError(
      "rounding_not_declared",
      "Rounding mode is not declared — set it to nearest, up or down in Timesheets setup before anyone clocks in",
    );
  }
  const unpaid = rec.unpaidBreakMinutes;
  if (typeof unpaid !== "number" || !Number.isFinite(unpaid) || unpaid < 0) {
    throw new FieldTimeError(
      "break_rule_not_declared",
      "The unpaid break rule is not declared — set unpaid break minutes to 0 or more in Timesheets setup before anyone clocks in",
    );
  }
  const autoClose = rec.autoCloseHours;
  if (typeof autoClose !== "number" || !Number.isFinite(autoClose) || autoClose <= 0) {
    throw new FieldTimeError(
      "auto_close_not_declared",
      "Auto-close is not declared — set auto-close hours in Timesheets setup before anyone clocks in",
    );
  }
  const tol = rec.equipmentToleranceHours;
  if (tol !== undefined && (typeof tol !== "string" || !/^\d+(?:\.\d{1,4})?$/.test(tol))) {
    throw new FieldTimeError(
      "equipment_tolerance_not_declared",
      "Equipment tolerance is not a valid hours value — set it in Timesheets setup before posting equipment time",
    );
  }
  return {
    rounding: { incrementMinutes: increment, mode },
    unpaidBreakMinutes: unpaid,
    autoCloseHours: autoClose,
    signatureRequired: rec.signatureRequired !== false,
    equipmentToleranceHours: typeof tol === "string" ? tol : "0.5000",
    photoRequired: rec.photoRequired === true,
  };
}

export async function loadFieldTimeSettings(orgId: string): Promise<FieldTimeSettings> {
  const row = (await db.execute<{ settings: unknown }>(sql`
    select settings->'fieldTime' as settings from orgs where id = ${orgId}`)).rows[0];
  if (!row || row.settings == null) {
    throw new FieldTimeError(
      "field_time_not_configured",
      "Field time is not configured — declare rounding, break, auto-close and signature rules in Timesheets setup before anyone clocks in",
    );
  }
  return validateFieldTimeSettings(row.settings);
}
