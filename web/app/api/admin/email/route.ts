import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import type { Authz } from "@/lib/authz";
import { apiErrorResponse } from "@/lib/api/error-response";
import {
  emailSettingsBodySchema,
  readEmailSettingsAction,
  saveEmailSettingsAction,
} from "@/lib/delivery/email-admin-actions";
import { OrgEmailConfigConflictError } from "@openbooks/engine/delivery/email-config/module";

export const runtime = "nodejs";

// The org-wide outbound transport serves every workflow (invoices, dunning,
// password resets), so redirecting it is setup authority, not user
// administration — same gate as the rest of org configuration.

/** GET — the org's email config view (never the sealed secret, only hasSecret). */
async function legacyGET(gate: Authz) {
  return NextResponse.json(await readEmailSettingsAction(gate.user.orgId));
}

/** PUT — persist the org's email provider config (secret sealed on the way in). */

export const GET = defineRoute({
  permission: "admin.setup.manage",
  feature: {
    none: "Organization email transport serves workflows across modules and has no module-specific feature gate.",
  },
  handler: async ({ authz }) => legacyGET(authz),
});

export const PUT = defineRoute({
  permission: "admin.setup.manage",
  feature: {
    none: "Organization email transport serves workflows across modules and has no module-specific feature gate.",
  },
  scope: "unrestricted",
  body: emailSettingsBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ body, authz: routeAuthz }) => {
    const gate = routeAuthz;

    try {
      const saved = await saveEmailSettingsAction(gate.user.orgId, gate.user.id, body);
      return NextResponse.json(saved);
    } catch (err) {
      if (err instanceof OrgEmailConfigConflictError)
        return apiErrorResponse(err, { safeStatus: 409 });
      return apiErrorResponse(err);
    }
  },
});
