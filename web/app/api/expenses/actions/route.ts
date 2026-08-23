import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { submitAndReleaseIfUngated } from '@openbooks/engine/src/flows/index.ts'
import {
  ControlAccountsIncompleteError,
  loadRequiredControlAccounts,
} from '@openbooks/engine/src/control-accounts.ts'
import { postDocument, PostingError } from '@openbooks/engine/src/posting.ts'
import { can, getAuthz } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'

export const runtime = 'nodejs'

/**
 * Expense report lifecycle: draft → submit (Flows approval) → approved → post.
 * Per-action permission gates: submit = expenses.create, post = ap.post.
 * Approval decisions are owned by the Flows engine (via the /approvals worklist
 * and the record flyout → /api/flows/gates/decide), not this route.
 */

/** The document must be an expense report in the caller's org. */
async function expenseReport(id: string, orgId: string) {
  const r = (await db.execute<{ id: string; status: string }>(
    sql`select id, status from documents where id = ${id} and kind = 'expense_report' and org_id = ${orgId}`,
  ))
  return r.rows[0] ?? null
}

export async function POST(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const user = authz.user
  // This route resolves authz itself rather than through guardPermission (the
  // permission differs per action), so it carries the feature gate inline. A
  // disabled module must not keep a submit/post path open. 404, not 403 — an
  // off feature is indistinguishable from an absent API.
  if (!(await isFeatureEnabled(user.orgId, 'expenses'))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    action: 'submit' | 'post'
    documentId?: string
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
        const { gated, runId, flowError, autoApproved } =
          await submitAndReleaseIfUngated('expense_report', body.documentId, user.id)
        if (flowError) {
          return NextResponse.json(
            { error: `approval could not be routed: ${flowError}` },
            { status: 422 },
          )
        }
        return NextResponse.json({ ok: true, requestId: runId, autoApproved })
      }
      case 'post': {
        if (!can(authz, 'ap.post')) {
          return NextResponse.json({ error: 'missing permission: ap.post' }, { status: 403 })
        }
        if (!body.documentId) {
          return NextResponse.json({ error: 'expense report not found' }, { status: 404 })
        }
        const expense = await expenseReport(body.documentId, user.orgId)
        if (!expense) return NextResponse.json({ error: 'expense report not found' }, { status: 404 })
        if (expense.status !== 'approved') {
          return NextResponse.json(
            { error: `expense report is ${expense.status}; only an approved report can be posted` },
            { status: 422 },
          )
        }
        const deps = { control: await loadRequiredControlAccounts(user.orgId) }
        const entryId = await postDocument(body.documentId, deps, {
          audit: { actorId: user.id, source: 'ui' },
        })
        return NextResponse.json({ ok: true, entryId })
      }
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
  } catch (e) {
    // Posting refusals (kernel rules or unconfigured org control accounts) are
    // request-state failures, not server defects.
    const status =
      e instanceof PostingError || e instanceof ControlAccountsIncompleteError
        ? 422
        : 500
    return NextResponse.json({ error: (e as Error).message }, { status })
  }
}
