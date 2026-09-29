import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'

import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
import { OrgEmailConfigConflictError, readOrgEmailConfigView, saveOrgEmailConfig } from '@openbooks/engine/src/delivery/email-config.ts'
import { isDocumentRevisionToken } from '@openbooks/engine/src/records/revision.ts'
import { isEmailProvider } from '@openbooks/emails'

const requestBodySchema = z.object({
  "enabled": z.boolean().optional(),
  // Keep semantic revision refusals at the conflict boundary below.
  "expectedUpdatedAt": z.union([z.string(), z.null()]).optional(),
  "fromEmail": z.string().nullable().optional(),
  "fromName": z.string().nullable().optional(),
  "mailgunDomain": z.string().nullable().optional(),
  "mailgunRegion": z.enum(["eu", "us"]).nullable().optional(),
  "provider": z.enum(["resend", "sendgrid", "mailgun", "postmark", "smtp"]).nullable().optional(),
  "replyTo": z.string().nullable().optional(),
  "secret": z.string().nullable().optional(),
  "smtpHost": z.string().nullable().optional(),
  "smtpPort": z.union([z.number().int(), z.string().regex(/^\\d+$/), z.null()]).optional(),
  "smtpSecure": z.boolean().optional(),
  "smtpUsername": z.string().nullable().optional(),
}).refine((body) => Object.keys(body).length > 0, "Provide an email setting to update or reload the page before saving");


export const runtime = 'nodejs'

// The org-wide outbound transport serves every workflow (invoices, dunning,
// password resets), so redirecting it is setup authority, not user
// administration — same gate as the rest of org configuration.
const PERMISSION = 'admin.setup.manage'

/** GET — the org's email config view (never the sealed secret, only hasSecret). */
async function legacyGET() {
  const gate = await guardPermission(PERMISSION)
  if (gate instanceof NextResponse) return gate
  return NextResponse.json(await readOrgEmailConfigView(gate.user.orgId))
}

/** PUT — persist the org's email provider config (secret sealed on the way in). */


export const GET = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  handler: async () => legacyGET(),
});

export const PUT = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  scope: "unrestricted",
  body: requestBodySchema,
  invalidBodyStatus: 422,
  handler: async ({ body, authz: routeAuthz }) => {

    const gate = routeAuthz






    if (!isDocumentRevisionToken(body.expectedUpdatedAt)) {
      return NextResponse.json({ error: 'Reload the email settings and supply their exact revision before saving' }, { status: 409 })
    }
    // Omitted settings mean keep; explicit blank strings mean clear.
    const clearableStr = (v: unknown) => v === undefined ? undefined : typeof v === 'string' ? v.trim() || null : undefined
    const provider = body.provider
    if (provider !== undefined && provider !== null && !isEmailProvider(provider)) {
      return NextResponse.json({ error: 'invalid provider' }, { status: 422 })
    }
    const enabled = body.enabled
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return NextResponse.json({ error: 'enabled must be a boolean' }, { status: 422 })
    }
    const smtpSecure = body.smtpSecure
    if (smtpSecure !== undefined && typeof smtpSecure !== 'boolean') {
      return NextResponse.json({ error: 'smtpSecure must be a boolean' }, { status: 422 })
    }
    const mailgunRegion = body.mailgunRegion
    if (mailgunRegion !== undefined && mailgunRegion !== null && mailgunRegion !== 'eu' && mailgunRegion !== 'us') {
      return NextResponse.json({ error: 'mailgunRegion must be us, eu, or null' }, { status: 422 })
    }

    try {
      const saved = await saveOrgEmailConfig(gate.user.orgId, {
        enabled: enabled === true,
        provider: provider === undefined ? undefined : isEmailProvider(provider) ? provider : null,
        fromName: clearableStr(body.fromName),
        fromEmail: clearableStr(body.fromEmail),
        replyTo: clearableStr(body.replyTo),
        mailgunDomain: clearableStr(body.mailgunDomain),
        mailgunRegion,
        smtpHost: clearableStr(body.smtpHost),
        smtpPort: body.smtpPort === undefined ? undefined : typeof body.smtpPort === 'number' ? body.smtpPort : body.smtpPort ? Number(body.smtpPort) : null,
        // Omission keeps the saved value (validated boolean above when
        // present); coercing to === true here would silently turn TLS off on
        // a partial update.
        smtpSecure: smtpSecure === undefined ? undefined : smtpSecure === true,
        smtpUsername: clearableStr(body.smtpUsername),
        // secret: non-empty string ⇒ seal; null ⇒ clear; blank/omitted ⇒ keep.
        secret: body.secret === null ? null : typeof body.secret === 'string' && body.secret.trim() ? body.secret.trim() : undefined,
      }, { kind: "user", userId: gate.user.id }, { expectedUpdatedAt: body.expectedUpdatedAt })
      return NextResponse.json(saved)
    } catch (err) {
      if (err instanceof OrgEmailConfigConflictError) return apiErrorResponse(err, { safeStatus: 409 })
      return apiErrorResponse(err)
    }
  },
});
