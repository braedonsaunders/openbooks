import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  readFieldTimeSettingsValue,
  saveFieldTimeSettings,
  validateFieldTimeSettings,
} from "@openbooks/engine/hrm/field-time/settings";
import { FieldTimeError } from "@openbooks/engine/hrm/field-time/errors";
import {
  fieldTimeSettingsBody,
  normalizeFieldTimeSettingsBody,
} from "@/lib/field-time/settings-body";

export const runtime = "nodejs";

function bad(error: string, status = 422) {
  return NextResponse.json({ error }, { status });
}

/**
 * Field-time rules (Timesheets setup): rounding, break, auto-close,
 * signature, equipment tolerance, photo. Stored on
 * orgs.settings->'fieldTime' — one source of truth, read by every
 * clock/crew path. Every rule is required; the service refuses without
 * them rather than guessing.
 *
 * The rules are org-wide policy with no subsidiary lineage — one write
 * re-times every entity's clocks at once — so PUT needs unrestricted
 * subsidiary scope (canonical shape 2): restricted callers get the named
 * 403 and store nothing. GET stays open to every time.manage holder: the
 * rules are operational policy disclosing no per-subsidiary material, and
 * foremen need them to enter time.
 */
async function legacyGET(gate: Authz) {
  return NextResponse.json({ settings: await readFieldTimeSettingsValue(gate.user.orgId) });
}

async function legacyPUT(
  body: z.output<typeof fieldTimeSettingsBody>,
  injectedGate?: Authz | null,
) {
  const gate = injectedGate as Authz;
  const { user } = gate;
  try {
    // validateFieldTimeSettings refuses missing or undeclared rules by
    // name before anything is stored — the settings write and the
    // service reads agree on exactly this shape. Explicit nulls arrive
    // normalized to absent (see settings-body), so a cleared rule gets
    // the same named refusal as a never-set one.
    const settings = validateFieldTimeSettings(normalizeFieldTimeSettingsBody(body));
    const moved = await saveFieldTimeSettings(user.orgId, settings);
    if (!moved) return bad("The organization is unknown — reload and retry");
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof FieldTimeError) return bad(error.message);
    throw error;
  }
}

export const GET = defineRoute({
  permission: "time.manage",
  feature: "fieldTime",

  handler: ({ authz }) => legacyGET(authz),
});

export const PUT = defineRoute({
  permission: "time.manage",
  feature: "fieldTime",
  scope: "unrestricted",
  body: fieldTimeSettingsBody,
  handler: ({ body, authz }) => legacyPUT(body, authz),
});
