import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { getAuthz } from "../../../../lib/authz";
import { ENTRY_PREFERENCES_PATCH_SCHEMA } from "../../../../lib/entry-preferences";
import {
  loadEntryPreferences,
  saveEntryPreferences,
} from "../../../../lib/entry-preferences-server";

export const runtime = "nodejs";

/**
 * The signed-in person's data-entry preferences (Enter behaviour, auto
 * decimal, what Save & new carries, last-document recall). Personal and
 * self-service: any signed-in user reads and changes only their own, and
 * every change is audited with its before and after values.
 */
export const GET = defineRoute({
  public: "session",
  handler: async () => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    return NextResponse.json({ preferences: await loadEntryPreferences(authz.user) });
  },
});

export const PATCH = defineRoute({
  public: "session",
  body: ENTRY_PREFERENCES_PATCH_SCHEMA,
  handler: async ({ body }) => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (Object.keys(body).length === 0) {
      return NextResponse.json(
        { error: "Name at least one data-entry preference to change." },
        { status: 400 },
      );
    }
    const preferences = await saveEntryPreferences(authz.user, body);
    if (!preferences) {
      return NextResponse.json(
        {
          error: "Your account is not active in this workspace, so the preference was not saved.",
          remedy: "Sign in again, then choose the preference.",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ preferences });
  },
});
