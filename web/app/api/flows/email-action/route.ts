import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withBypassContext, withOrgContext } from '@openbooks/engine/src/db.ts'
import {
  decideGate,
  verifyEmailActionToken,
  GateError,
  type EmailActionClaims,
} from '@openbooks/engine/src/flows/index.ts'

export const runtime = 'nodejs'

/**
 * One-click email approvals — NO session required (web/middleware.ts excludes
 * this path). The HMAC token (engine/src/flows/email-tokens.ts) is the entire
 * grant: it binds one gate row + one decision + one assignee with a 7-day
 * expiry, and decideGate still authorizes that assignee normally, so the link
 * can never do more than the assignee could in the app.
 *
 *   GET  ?token=…   verify → standalone confirmation page (never decides)
 *   POST (form)     verify → decide as the token's assignee → done page
 *                   (idempotent: an already-decided gate reports who handled
 *                   it instead of erroring)
 *
 * With no session there is no request-org RLS scope. We resolve the gate first
 * from the signed token claim, then rerun writes/reads under that gate's org.
 */

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/** Minimal standalone shell — inline styles only, no app chrome. */
function page(title: string, bodyHtml: string, status = 200): NextResponse {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} — OpenBooks</title>
</head>
<body style="margin:0;background:#f4f4f5;font-family:ui-sans-serif,system-ui,sans-serif;color:#18181b">
  <div style="max-width:480px;margin:48px auto;padding:0 16px">
    <div style="background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px">
      <div style="font-size:13px;color:#71717a;margin-bottom:12px">OpenBooks approvals</div>
      <h1 style="font-size:20px;margin:0 0 16px">${esc(title)}</h1>
      ${bodyHtml}
    </div>
  </div>
</body>
</html>`
  return new NextResponse(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
}
type GateSummary = {
  id: string
  orgId: string
  title: string
  status: string
  subject_kind: string
  decided_by_name: string | null
  document_number: string | null
  doc_kind: string | null
  total: string | null
  currency: string | null
  document_date: string | null
  party_name: string | null
};

async function loadGateSummary(gateId: string): Promise<GateSummary | null> {
  const r = (await db.execute<GateSummary>(sql`
    select g.id, g.org_id as "orgId", g.title, g.status, g.subject_kind,
           du.name as decided_by_name,
           d.document_number, d.kind as doc_kind, d.total, d.currency,
           d.document_date, p.display_name as party_name
      from flow_gates g
      left join users du on du.id = g.decided_by
      left join documents d on d.id = g.subject_id
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
     where g.id = ${gateId}
  `))
  return r.rows[0] ?? null
}

function documentSummaryHtml(g: GateSummary): string {
  if (!g.document_number) return `<p style="color:#52525b">${esc(g.subject_kind.replace(/_/g, ' '))}</p>`
  const rows: [string, string][] = [
    ['Document', `${g.doc_kind?.replace(/_/g, ' ') ?? ''} ${g.document_number}`.trim()],
    ...(g.party_name ? ([['Party', g.party_name]] as [string, string][]) : []),
    ...(g.total ? ([['Total', `${g.total} ${g.currency ?? ''}`.trim()]] as [string, string][]) : []),
    ...(g.document_date ? ([['Date', g.document_date]] as [string, string][]) : []),
  ]
  return `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 8px">${rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#71717a;white-space:nowrap">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`,
    )
    .join('')}</table>`
}

const invalidTokenPage = () =>
  page(
    'This approval link is invalid or has expired',
    `<p style="color:#52525b">Approval links expire after 7 days. Open <strong>OpenBooks → Approvals</strong> to decide there.</p>`,
    400,
  )

function alreadyHandledPage(g: GateSummary): NextResponse {
  const who = g.decided_by_name ? ` by ${g.decided_by_name}` : ''
  const what = g.status === 'approved' || g.status === 'rejected' ? g.status : 'handled'
  return page(
    'Already handled',
    `<p style="color:#52525b">This approval was already ${esc(what)}${esc(who)}. Nothing further is needed.</p>
     ${documentSummaryHtml(g)}`,
  )
}

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token') ?? ''
  const claims = verifyEmailActionToken(token)
  if (!claims) return invalidTokenPage()

  const gate = await withBypassContext(() => loadGateSummary(claims.gateId))
  if (!gate) return invalidTokenPage()
  if (gate.status !== 'pending') return alreadyHandledPage(gate)

  return confirmationPage(token, claims, gate)
}

function confirmationPage(token: string, claims: EmailActionClaims, gate: GateSummary): NextResponse {
  const approving = claims.decision === 'approved'
  const verb = approving ? 'Approve' : 'Reject'
  const color = approving ? '#16a34a' : '#dc2626'
  return page(
    `${verb}: ${gate.title}`,
    `${documentSummaryHtml(gate)}
     <form method="post" action="/api/flows/email-action" style="margin-top:16px">
       <input type="hidden" name="token" value="${esc(token)}">
       ${
         approving
           ? ''
           : `<label style="display:block;font-size:13px;color:#52525b;margin-bottom:6px">Reason (optional)</label>
              <textarea name="reason" rows="3" maxlength="2000" style="width:100%;box-sizing:border-box;border:1px solid #d4d4d8;border-radius:8px;padding:8px;font:inherit;margin-bottom:14px"></textarea>`
       }
       <button type="submit" style="display:inline-block;padding:10px 24px;background:${color};color:#fff;border:0;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer">Confirm ${verb}</button>
     </form>
     <p style="color:#a1a1aa;font-size:12px;margin-top:16px">Not you, or changed your mind? Just close this page — nothing happens until you confirm.</p>`,
  )
}

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null)
  const token = typeof form?.get('token') === 'string' ? (form!.get('token') as string) : ''
  const reason = typeof form?.get('reason') === 'string' ? (form!.get('reason') as string).trim() : ''
  const claims = verifyEmailActionToken(token)
  if (!claims) return invalidTokenPage()

  const gate = await withBypassContext(() => loadGateSummary(claims.gateId))
  if (!gate) return invalidTokenPage()
  if (gate.status !== 'pending') return alreadyHandledPage(gate)

  try {
    await withOrgContext(gate.orgId, () =>
      decideGate({
        gateId: claims.gateId,
        decision: claims.decision,
        userId: claims.assigneeUserId,
        comment: reason || null,
      }),
    )
  } catch (e) {
    if (e instanceof GateError) {
      // Race: someone decided between the check and the update — idempotent.
      if (/already resolved/.test(e.message)) {
        const fresh = await withOrgContext(gate.orgId, () => loadGateSummary(claims.gateId))
        return fresh ? alreadyHandledPage(fresh) : invalidTokenPage()
      }
      return page('Could not record your decision', `<p style="color:#52525b">${esc(e.message)}</p>`, 409)
    }
    console.error('[flows] email-action decide failed:', e)
    return page('Something went wrong', `<p style="color:#52525b">Your decision was not recorded. Please try again from OpenBooks → Approvals.</p>`, 500)
  }

  const approved = claims.decision === 'approved'
  const updatedGate = await withOrgContext(gate.orgId, () => loadGateSummary(claims.gateId))
  return page(
    approved ? 'Approved' : 'Rejected',
    `<p style="color:#52525b">Your decision was recorded${approved ? '' : reason ? ' with your reason' : ''}. You can close this page.</p>
     ${documentSummaryHtml(updatedGate ?? gate)}`,
  )
}
