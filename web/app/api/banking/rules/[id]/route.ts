import { defineRoute } from '@/lib/api/route';
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardUnrestrictedScope } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { lockBankMatchRuleSet } from '../../../../../lib/banking-rule-set-lock'
import { notFound } from "@/lib/api/responses";


export const runtime = 'nodejs'

export const DELETE = defineRoute({
  permission: 'banking.reconcile',
  feature: 'banking',
  handler: async ({ request: req, authz: routeAuthz, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const gate = routeAuthz;
    const unrestricted = guardUnrestrictedScope(gate)
    if (unrestricted) return unrestricted
    const user = gate.user
    const { id } = await params
    if (!isUuid(id)) return notFound("record")
    const missing = await db.transaction(async (tx) => {
        await lockBankMatchRuleSet(user.orgId)
        // Snapshot the rule first: deletion removes the record of what used to
        // auto-categorize bank lines.
        const existing = (await tx.execute<Record<string, unknown>>(sql`
          select * from bank_match_rules where id = ${id} and org_id = ${user.orgId}
           for update
        `))
        if (!existing.rows[0]) return true
        const deleted = (await tx.execute<{ id: string }>(sql`
          delete from bank_match_rules where id = ${id} and org_id = ${user.orgId}
          returning id
        `)).rows[0]
        if (!deleted) return true
        await tx.execute(sql`
          insert into audit_log
            (org_id, table_name, row_id, action, changes, actor_id)
          values
            (${user.orgId}, 'bank_match_rules', ${id}, 'delete',
             ${JSON.stringify({ before: existing.rows[0] })}::jsonb, ${user.id})
        `)
        return false
      })
    if (missing) return notFound("record")
    return NextResponse.json({ ok: true })
  },
});
