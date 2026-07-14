import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { submitForApproval, decide } from '@openbooks/engine/src/approvals.ts'
import { postDocument, PostingError } from '@openbooks/engine/src/posting.ts'
import { can, getAuthz } from '../../../../lib/authz'

export const runtime = 'nodejs'

/**
 * Expense report lifecycle: draft → submit (approval engine) → approved → post.
 * Per-action permission gates: submit = expenses.create, decide = ap.approve,
 * post = ap.post.
 */

async function controlDeps(orgId: string) {
  const r = (await db.execute(sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`)) as any
  const c = r.rows[0]?.c ?? {}
  return {
    control: {
      ar: c.ar,
      ap: c.ap,
      bank: c.bank,
      taxCollected: c.taxCollected,
      taxPaid: c.taxPaid,
      employeePayable: c.employeePayable,
    },
  }
}

/** The document must be an expense report in the caller's org. */
async function expenseReport(id: string, orgId: string) {
  const r = (await db.execute(
    sql`select id from documents where id = ${id} and kind = 'expense_report' and org_id = ${orgId}`,
  )) as unknown as { rows: { id: string }[] }
  return r.rows[0] ?? null
}

export async function POST(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const user = authz.user
  const body = (await req.json()) as {
    action: 'submit' | 'decide' | 'post'
    documentId?: string
    requestId?: string
    stepNumber?: number
    decision?: 'approved' | 'rejected'
    note?: string
  }

  try {
    switch (body.action) {
      case 'submit': {
        if (!can(authz, 'expenses.create')) {
          return NextResponse.json({ error: 'missing permission: expenses.create' }, { status: 403 })
        }
        if (!body.documentId || !(await expenseReport(body.documentId, user.orgId))) {
          return NextResponse.json({ error: 'expense report not found' }, { status: 404 })
        }
        const requestId = await submitForApproval('expense_report', body.documentId)
        return NextResponse.json({ ok: true, requestId })
      }
      case 'decide': {
        if (!can(authz, 'ap.approve')) {
          return NextResponse.json({ error: 'missing permission: ap.approve' }, { status: 403 })
        }
        const request = (await db.execute(
          sql`select id from approval_requests
               where id = ${body.requestId ?? null} and target_kind = 'expense_report' and org_id = ${user.orgId}`,
        )) as unknown as { rows: { id: string }[] }
        if (!request.rows[0]) {
          return NextResponse.json({ error: 'approval request not found' }, { status: 404 })
        }
        const res = await decide(body.requestId!, body.stepNumber!, body.decision!, user.id, body.note)
        return NextResponse.json({ ok: true, ...res })
      }
      case 'post': {
        if (!can(authz, 'ap.post')) {
          return NextResponse.json({ error: 'missing permission: ap.post' }, { status: 403 })
        }
        if (!body.documentId || !(await expenseReport(body.documentId, user.orgId))) {
          return NextResponse.json({ error: 'expense report not found' }, { status: 404 })
        }
        const deps = await controlDeps(user.orgId)
        const entryId = await postDocument(body.documentId, deps)
        return NextResponse.json({ ok: true, entryId })
      }
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
  } catch (e) {
    const status = e instanceof PostingError ? 422 : 500
    return NextResponse.json({ error: (e as Error).message }, { status })
  }
}
