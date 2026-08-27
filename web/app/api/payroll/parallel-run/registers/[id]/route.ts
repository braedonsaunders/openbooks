import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { deletePriorRegister } from '@openbooks/engine/src/payroll-parallel-run-store.ts'
import { guardFeaturePermission } from '../../../../../../lib/feature-gates'
import { isUuid } from '../../../../../../lib/list-params'
import { guardSubsidiaryScope } from '../../../../../../lib/authz'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Discard an imported register.
 *
 * A prior register is not accounting data — it is somebody else's report, held
 * so we can check ours against it — so it is genuinely deletable rather than
 * voidable. Its comparisons go with it, because a reconciliation whose prior
 * side no longer exists cannot be re-derived and would be unverifiable
 * evidence. The audit log records the discard.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate
  const { id } = await ctx.params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (gate.allowedSubsidiaryIds !== null) {
    const ids = [...gate.allowedSubsidiaryIds]
    const register = (await db.execute<{ id: string }>(sql`
      select r.id
        from payroll_prior_registers r
       where r.org_id = ${gate.user.orgId} and r.id = ${id}
         and not exists (
           select 1
             from payroll_prior_stubs s
             left join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
            where s.org_id = r.org_id and s.register_id = r.id
              and (p.id is null or p.subsidiary_id is null
                or not (p.subsidiary_id = any(${`{${ids.join(',')}}`}::uuid[])))
       }`)).rows[0]
    // The direct probe is intentionally indistinguishable from a nonexistent
    // register. An empty allowed set therefore denies every register.
    if (!register) return NextResponse.json({ error: 'not found' }, { status: 404 })
    // Keep the direct record twin explicit as well as the aggregate NOT EXISTS
    // probe above; both paths intentionally return the same 404 response.
    const sample = (await db.execute<{ subsidiaryId: string | null }>(sql`
      select p.subsidiary_id as "subsidiaryId"
        from payroll_prior_stubs s
        left join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
       where s.org_id = ${gate.user.orgId} and s.register_id = ${id}
       limit 1`)).rows[0]
    if (sample) {
      const denied = guardSubsidiaryScope(gate, sample.subsidiaryId)
      if (denied) return denied
    }
  }
  await deletePriorRegister(gate.user.orgId, id, gate.user.id)
  return NextResponse.json({ ok: true })
}
