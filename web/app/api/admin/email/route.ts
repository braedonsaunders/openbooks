import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { guardPermission, guardUnrestrictedScope } from '../../../../lib/authz'
import { OrgEmailConfigConflictError, readOrgEmailConfigView, saveOrgEmailConfig } from '@openbooks/engine/src/delivery/email-config.ts'
import { isDocumentRevisionToken } from '@openbooks/engine/src/records/revision.ts'
import { isEmailProvider } from '@openbooks/emails'

export const runtime = 'nodejs'

// The org-wide outbound transport serves every workflow (invoices, dunning,
// password resets), so redirecting it is setup authority, not user
// administration — same gate as the rest of org configuration.
const PERMISSION = 'admin.setup.manage'

/** GET — the org's email config view (never the sealed secret, only hasSecret). */
export async function GET() {
  const gate = await guardPermission(PERMISSION)
  if (gate instanceof NextResponse) return gate
  return NextResponse.json(await readOrgEmailConfigView(gate.user.orgId))
}

/** PUT — persist the org's email provider config (secret sealed on the way in). */
export async function PUT(req: Request) {
  const gate = await guardPermission(PERMISSION)
  if (gate instanceof NextResponse) return gate
  const scopeDenied = guardUnrestrictedScope(gate)
  if (scopeDenied) return scopeDenied
  let body: Record<string, unknown>
  try {
    const parsedBody = await parseJsonBody(req, jsonObject);
    if (!parsedBody.ok) return parsedBody.response;
    body = (parsedBody.data) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }

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
      smtpSecure: smtpSecure === true,
      smtpUsername: clearableStr(body.smtpUsername),
      // secret: non-empty string ⇒ seal; null ⇒ clear; blank/omitted ⇒ keep.
      secret: body.secret === null ? null : typeof body.secret === 'string' && body.secret.trim() ? body.secret.trim() : undefined,
    }, { kind: "user", userId: gate.user.id }, { expectedUpdatedAt: body.expectedUpdatedAt })
    return NextResponse.json(saved)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'save failed' }, { status: err instanceof OrgEmailConfigConflictError ? 409 : 422 })
  }
}
