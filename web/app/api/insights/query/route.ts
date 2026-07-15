import { NextResponse } from 'next/server'
import { getTranslations } from 'next-intl/server'
import { pool } from '@openbooks/engine/src/db.ts'
import { runInsightQuery } from '@openbooks/analytics/server'
import { InsightCompileError, InsightValidationError } from '@openbooks/analytics'
import { guardPermission } from '../../../../lib/authz'
import { insightCompileErrorMessage, insightLabelResolver } from '../../../../lib/insight-labels'
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
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  let query
  try {
    query = normalizeQuery((body as any)?.query)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'invalid query'
    return NextResponse.json({ error: msg }, { status: 422 })
  }

  try {
    // Column labels compile in the caller's locale (results are never persisted).
    const result = await runInsightQuery(pool, query, gate.user.orgId, await insightLabelResolver())
    return NextResponse.json(result)
  } catch (e) {
    if (e instanceof InsightCompileError) {
      return NextResponse.json({ error: await insightCompileErrorMessage(e) }, { status: 422 })
    }
    if (e instanceof InsightValidationError) {
      // Structural plan corruption (the studio can't produce this) — technical detail verbatim.
      return NextResponse.json({ error: e.message }, { status: 422 })
    }
    const msg = e instanceof Error ? e.message : 'query failed'
    // Postgres statement_timeout / cancel surfaces as a friendly 400.
    if (/statement timeout|canceling statement/i.test(msg)) {
      const t = await getTranslations('insights')
      return NextResponse.json({ error: t('compileErrors.timeout') }, { status: 400 })
    }
    return NextResponse.json({ error: msg }, { status: 400 })
  }
}
