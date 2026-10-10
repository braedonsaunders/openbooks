import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { db } from "@openbooks/engine/platform/database";
import { createOrganization, lockPendingAdministrator } from "@openbooks/engine/provisioning/organizations";
import { authRequestContext, normalizeLoginEmail } from "../../../../lib/auth-policy";
import {
  InviteIssuanceRefusedError,
  issueInviteSetPasswordLink,
  setPasswordUrl,
} from "../../../../lib/auth-reset";
import { normalizeCountryCode } from "../../../../lib/countries";
import { ISO_CURRENCIES } from "../../../../lib/iso-currencies";
import { guardSuperAdmin, lockSuperAdminActor, SuperAdminAuthorityError } from "../../../../lib/super-admin";

export const runtime = "nodejs";

const SUPPORTED_CURRENCY_CODES: ReadonlySet<string> = new Set(ISO_CURRENCIES.map((currency) => currency.code));

const createOrganizationBody = z.object({
  name: z.string().trim().min(1).max(200),
  country: z.string().refine((value) => normalizeCountryCode(value) !== null, {
    message: "country must be an ISO 3166-1 alpha-2 country code",
  }).transform((value) => normalizeCountryCode(value)!),
  currency: z.string().trim().toUpperCase().refine((value) => SUPPORTED_CURRENCY_CODES.has(value), {
    message: "currency must be a supported ISO 4217 code",
  }),
  adminName: z.string().trim().min(1).max(200),
  adminEmail: z.string().trim().max(320).email().transform((value) => normalizeLoginEmail(value) ?? value),
  reason: z.string().trim().min(1).max(1000),
}).strict();

/**
 * Create a production organization with its first administrator. Platform
 * super-admin authority only; never an organization feature.
 *
 * The engine command commits the organization, its seeded configuration,
 * the pending administrator and the audit evidence as one unit. Access is
 * then delivered through the native set-password link: emailed when the
 * new organization has an email transport, otherwise returned once in this
 * response for the operator to hand over out of band. No password is ever
 * generated or shown.
 */
export const POST = defineRoute({
  authorize: () => guardSuperAdmin(),
  feature: { none: "Organization creation is a platform-wide operator surface guarded by super-admin authority." },
  body: createOrganizationBody,
  handler: async ({ request, authz, body }) => {
    const actorId = authz.user.homeUserId;
    const created = await createOrganization({
      name: body.name,
      country: body.country,
      currency: body.currency,
      administrator: { name: body.adminName, email: body.adminEmail },
      actorId,
      reason: body.reason,
    });

    const administrator = created.administrator;
    let issuance: { raw: string; emailQueued: boolean } | null;
    try {
      issuance = await issueInviteSetPasswordLink({
        user: { id: administrator.userId, org_id: created.orgId, name: administrator.name, email: administrator.email },
        context: authRequestContext(request),
        // Re-verified inside the mint transaction: the operator must still be
        // an active super administrator, and the administrator must still be
        // a pending invitation, before any link exists.
        authorize: async () => {
          try {
            await lockSuperAdminActor(db, actorId);
          } catch (error) {
            if (error instanceof SuperAdminAuthorityError) {
              throw new InviteIssuanceRefusedError({ error: error.message, status: 403 });
            }
            throw error;
          }
          if (!(await lockPendingAdministrator(created.orgId, administrator.userId))) {
            throw new InviteIssuanceRefusedError({
              error: "the first administrator is no longer a pending invitation; manage access from Admin → Users in the new organization",
              status: 409,
            });
          }
        },
      });
    } catch (error) {
      if (error instanceof InviteIssuanceRefusedError) {
        return NextResponse.json(
          {
            error: error.refusal.error,
            remedy: "The organization was created; an administrator of it can re-send the invitation from Admin → Users.",
            orgId: created.orgId,
          },
          { status: error.refusal.status },
        );
      }
      console.error("[platform] first administrator set-password issuance failed", error);
      return NextResponse.json(
        {
          error: "the organization was created, but the administrator's set-password link could not be issued",
          remedy: "Open the organization and re-send the invitation from Admin → Users.",
          orgId: created.orgId,
        },
        { status: 502 },
      );
    }
    if (!issuance) {
      return NextResponse.json(
        {
          error: "the organization was created, but too many set-password links were requested for its administrator",
          remedy: "Wait an hour, then re-send the invitation from Admin → Users in the new organization.",
          orgId: created.orgId,
        },
        { status: 429 },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        orgId: created.orgId,
        name: created.name,
        administrator: { userId: administrator.userId, email: administrator.email },
        emailQueued: issuance.emailQueued,
        // One-time operator copy, present only when no mailbox carried it.
        // Never persisted or logged; the stored SHA-256 cannot reproduce it.
        ...(issuance.emailQueued ? {} : { setPasswordUrl: setPasswordUrl(issuance.raw) }),
      },
      { status: 201 },
    );
  },
});
