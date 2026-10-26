import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { db } from "@openbooks/engine/platform/database";
import { guardPermission } from "@/lib/authz";
import {
  readAuthorityConnectionStatus,
  refreshHmrcToken,
  saveAuthorityCredentials,
  verifyAuthorityConnection,
} from "@openbooks/engine/tax";

export const runtime = "nodejs";

const AuthoritySchema = z.enum(["hmrc", "abn"]);

const HmrcCredentialsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  scope: z.string().min(1),
});

const AbnCredentialsSchema = z.object({
  guid: z.string().min(1),
});

const SaveSchema = z.object({
  action: z.literal("save"),
  authority: AuthoritySchema,
  credentials: z.unknown(),
});

const VerifySchema = z.object({
  action: z.literal("verify"),
  authority: AuthoritySchema,
});

const RefreshSchema = z.object({
  action: z.literal("refresh"),
});

/**
 * Sealed tax-authority connections for Tax setup: the HMRC VAT API OAuth
 * client and the ABN Lookup GUID. Reads report connection state only —
 * credential material is sealed at rest and never leaves the server.
 * Saving converges on the new value (rotation is the expected path);
 * verifying performs a live authority round-trip.
 */
export const GET = defineRoute({
  permission: "admin.setup.manage",
  feature: {
    none: "Authority connections are Tax setup configuration, governed by the setup permission.",
  },
  handler: async ({ authz: routeAuthz }) => {
    try {
      const [hmrc, abn] = await Promise.all([
        readAuthorityConnectionStatus(db, routeAuthz.user.orgId, "hmrc"),
        readAuthorityConnectionStatus(db, routeAuthz.user.orgId, "abn"),
      ]);
      return NextResponse.json({ connections: [hmrc, abn] });
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 });
    }
  },
});

export const POST = defineRoute({
  authorize: async ({ request }) => {
    const gate = await guardPermission("admin.setup.manage");
    if (gate instanceof NextResponse) return gate;
    try {
      await request.clone().json();
    } catch {
      return NextResponse.json(
        { error: "a JSON body with action save|verify|refresh is required" },
        { status: 400 },
      );
    }
    return gate;
  },
  feature: {
    none: "Authority connections are Tax setup configuration, governed by the setup permission.",
  },
  body: z.unknown(),
  opaque: {
    body: "Action-specific schemas validate each supported authority credential payload.",
  },
  handler: async ({ authz: routeAuthz, body }) => {
    const gate = routeAuthz;
    const action = (body as { action?: unknown } | null)?.action;
    try {
      if (action === "save") {
        const parsed = SaveSchema.safeParse(body);
        if (!parsed.success) {
          return NextResponse.json(
            { error: "save needs authority hmrc|abn and its credentials object" },
            { status: 400 },
          );
        }
        const { authority } = parsed.data;
        const credentials =
          authority === "hmrc"
            ? HmrcCredentialsSchema.safeParse(parsed.data.credentials)
            : AbnCredentialsSchema.safeParse(parsed.data.credentials);
        if (!credentials.success) {
          return NextResponse.json(
            {
              error:
                authority === "hmrc"
                  ? "hmrc credentials need clientId, clientSecret and scope from the HMRC developer hub"
                  : "abn credentials need the GUID from ABN Lookup web services",
            },
            { status: 400 },
          );
        }
        return NextResponse.json(
          await saveAuthorityCredentials(
            db,
            gate.user.orgId,
            gate.user.id,
            authority,
            credentials.data,
          ),
        );
      }
      if (action === "verify") {
        const parsed = VerifySchema.safeParse(body);
        if (!parsed.success) {
          return NextResponse.json({ error: "verify needs authority hmrc|abn" }, { status: 400 });
        }
        return NextResponse.json(
          await verifyAuthorityConnection(db, gate.user.orgId, gate.user.id, parsed.data.authority),
        );
      }
      if (action === "refresh") {
        RefreshSchema.parse(body);
        return NextResponse.json(await refreshHmrcToken(db, gate.user.orgId, gate.user.id));
      }
      return NextResponse.json({ error: "action must be save|verify|refresh" }, { status: 400 });
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 });
    }
  },
});
