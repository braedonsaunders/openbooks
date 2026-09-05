import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
import { OrgEmailConfigConflictError, readOrgEmailConfigView, saveOrgEmailConfig } from '@openbooks/engine/src/email-config.ts'
import { isDocumentRevisionToken } from '@openbooks/engine/src/document-revision.ts'
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
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const provider = body.provider
  if (provider !== undefined && provider !== null && !isEmailProvider(provider)) {
    return NextResponse.json({ error: 'invalid provider' }, { status: 422 })
  }

  try {
    const saved = await saveOrgEmailConfig(gate.user.orgId, {
      enabled: body.enabled === true,
      provider: isEmailProvider(provider) ? provider : undefined,
      fromName: str(body.fromName),
      fromEmail: str(body.fromEmail),
      replyTo: str(body.replyTo),
      mailgunDomain: str(body.mailgunDomain),
      mailgunRegion: body.mailgunRegion === 'eu' ? 'eu' : body.mailgunRegion === 'us' ? 'us' : undefined,
      smtpHost: str(body.smtpHost),
      smtpPort: typeof body.smtpPort === 'number' ? body.smtpPort : body.smtpPort ? Number(body.smtpPort) : undefined,
      smtpSecure: body.smtpSecure === true,
      smtpUsername: str(body.smtpUsername),
      // secret: string ⇒ seal; null ⇒ clear; undefined ⇒ keep existing.
      secret: body.secret === null ? null : str(body.secret),
    }, { kind: "user", userId: gate.user.id }, { expectedUpdatedAt: body.expectedUpdatedAt })
    return NextResponse.json(saved)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'save failed' }, { status: err instanceof OrgEmailConfigConflictError ? 409 : 422 })
  }
}
