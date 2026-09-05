import 'server-only'
import { sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { db } from '@openbooks/engine/src/db.ts'
import type { Authz } from './authz'
import { insightVisibilitySql } from './insight-access'
import { auditSetupChange } from './setup/audit'

type InsightTable = 'insight_cards' | 'insight_dashboards'
type Executor = Parameters<Parameters<typeof db.transaction>[0]>[0]
class RejectedMutation extends Error {
  constructor(readonly response: NextResponse) {
    super('Insight mutation rejected')
  }
}

/** Lock, authorize, mutate and capture both row images in the same transaction.
 * An error response or failed audit must never commit a partial mutation. */
export async function mutateInsight(
  authz: Authz,
  table: InsightTable,
  id: string,
  action: 'insert' | 'update' | 'delete',
  work: (
    tx: Executor,
    before: Record<string, unknown> | null,
    revision: string | null,
  ) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    return await db.transaction(async (tx) => {
      // Layouts reference cards through JSON, so a row FK cannot serialize a
      // new placement against deletion. All Insight writers take this tenant
      // lock before row locks; unrelated organizations remain independent.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${authz.user.orgId + ':insights'}, 0))`,
      )
      let before: Record<string, unknown> | null = null
      let revision: string | null = null
      if (action !== 'insert') {
        const row = await tx.execute<{
          snapshot: Record<string, unknown>
          revision: string
        }>(sql`
          select to_jsonb(i) as snapshot,
            to_char(i.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as revision from ${sql.identifier(table)} i
          where i.id = ${id} and ${insightVisibilitySql(authz, 'i')} for update of i
        `)
        before = row.rows[0]?.snapshot ?? null
        revision = row.rows[0]?.revision ?? null
        if (!before)
          return NextResponse.json({ error: 'not found' }, { status: 404 })
      }
      const response = await work(tx, before, revision)
      if (response.status >= 400) throw new RejectedMutation(response)
      const row = await tx.execute<{ snapshot: Record<string, unknown> }>(sql`
        select to_jsonb(i) as snapshot from ${sql.identifier(table)} i
        where i.id = ${id} and i.org_id = ${authz.user.orgId}
      `)
      const after = row.rows[0]?.snapshot ?? null
      if (action === 'delete' ? after !== null : after === null)
        throw new Error(
          'Insight mutation did not produce the expected row state',
        )
      await auditSetupChange(
        {
          orgId: authz.user.orgId,
          table,
          rowId: id,
          action,
          changes: {
            ...(before ? { before } : {}),
            ...(after ? { after } : {}),
          },
          actorId: authz.user.id,
        },
        tx,
      )
      return response
    })
  } catch (error) {
    if (error instanceof RejectedMutation) return error.response
    throw error
  }
}
