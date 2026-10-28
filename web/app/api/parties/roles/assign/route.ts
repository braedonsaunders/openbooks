import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { assignPartyRolesInSlice } from "@/lib/party-role-actions";

export const runtime = "nodejs";

const assignBody = z
  .object({
    role: z.enum(["customer", "vendor", "employee"]),
    /** Same free-text filter as the party directory (?q=). */
    q: z.string().trim().max(200).optional(),
    /** Mirror the directory's show-inactives toggle; active parties only by default. */
    includeInactive: z.boolean().optional(),
  })
  .strict();

/**
 * Bulk-assign one native role to every role-less party in the directory
 * slice the caller names. The slice is the directory's own filter — the
 * search text and the show-inactives toggle — re-applied server-side under
 * the caller's subsidiary fence, so a restricted caller can only promote
 * parties its lists already show.
 *
 * Each party is promoted independently through the native role command
 * (insert-only: an existing role row, active or deactivated, is never
 * flipped), audited with its before/after state. The request refuses above
 * the shared bulk ceiling instead of truncating — narrow the directory
 * search and repeat. Re-running is safe: promoting an already-promoted
 * party is a no-op that still reports it.
 *
 * POST { role, q?, includeInactive? } → { assigned, total }
 */
export const POST = defineRoute({
  permission: "parties.manage",
  feature: { none: "Parties are shared master records; CRM capabilities do not gate their roles." },
  body: assignBody,
  invalidBodyStatus: 422,
  handler: async ({ body, authz }) => {
    const result = await assignPartyRolesInSlice(authz, body);
    return result instanceof NextResponse ? result : NextResponse.json(result);
  },
});
