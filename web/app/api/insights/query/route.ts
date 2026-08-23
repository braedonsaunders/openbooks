import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'
import { pool } from '@openbooks/engine/src/db.ts'
import { runInsightQuery } from '@openbooks/analytics/server'
import { InsightCompileError, InsightValidationError, sourcePermission } from '@openbooks/analytics'
import { can, guardPermission } from '../../../../lib/authz'
import { insightCompileErrorMessage, insightLabelResolver } from '../../../../lib/insight-labels'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { normalizeQuery } from '../_lib'

export const runtime = 'nodejs'

/**
 * Compile + execute an insight query and return the typed result — the card
 * studio's live preview and (server-side) card tiles both call this. Guarded by
 * insights.read; runs read-only as openbooks_read, 10k rows / 8s cap.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('insights.read')
  if (gate instanceof NextResponse) return gate

  let body: unknown
  try {
    const parsedBody = await parseJsonBody(req, jsonObject);
    if (!parsedBody.ok) return parsedBody.response;
    body = parsedBody.data
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  let query
  try {
    query = normalizeQuery((body as any)?.query)
  } catch (e) {
    // Catalog-referencing validation failures carry a code — translate them;
    // structural corruption stays technical detail verbatim.
    if (e instanceof InsightValidationError && e.code) {
      return NextResponse.json(
        { error: await insightCompileErrorMessage({ code: e.code, subject: e.subject }) },
        { status: 422 },
      )
    }
    const msg = e instanceof Error ? e.message : 'invalid query'
    return NextResponse.json({ error: msg }, { status: 422 })
  }

  // Sources over sensitive data (payroll wages) carry their own permission in
  // the shared catalog — insights.read alone never unlocks them, on a card the
  // caller built or one someone else pinned to their dashboard.
  const needed = sourcePermission(query.source)
  if (needed && !can(gate, needed)) {
    return NextResponse.json({ error: `missing permission: ${needed}` }, { status: 403 })
  }

  try {
    // Column labels compile in the caller's locale (results are never persisted).
    const result = await runInsightQuery(
      pool, query, gate.user.orgId, await insightLabelResolver(), await businessToday(gate.user.orgId),
    )
    return NextResponse.json(result)
  } catch (e) {
    if (e instanceof InsightCompileError) {
      return NextResponse.json({ error: await insightCompileErrorMessage(e) }, { status: 422 })
    }
    if (e instanceof InsightValidationError) {
      // Catalog-referencing failures carry a compile-error code — translate
      // those; pure structural corruption (the studio can't produce it) stays
      // technical detail verbatim.
      const error = e.code
        ? await insightCompileErrorMessage({ code: e.code, subject: e.subject })
        : e.message
      return NextResponse.json({ error }, { status: 422 })
    }
    const msg = e instanceof Error ? e.message : 'query failed'
    // Postgres statement_timeout / cancel surfaces as a friendly 400.
    if (/statement timeout|canceling statement/i.test(msg)) {
      const t = await getTranslations('insights')
      return NextResponse.json({ error: t('compileErrors.timeout') }, { status: 400 })
    }
    // Full error stays in the server log only; the client gets a generic
    // message so database internals never reach the browser.
    console.error('[insights-query] execution failed', e)
    return NextResponse.json({ error: 'query failed' }, { status: 400 })
  }
}
