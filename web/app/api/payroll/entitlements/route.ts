import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { entitlementBalances } from '@openbooks/engine/src/payroll-entitlements.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'

export const dynamic = 'force-dynamic'

/**
 * One employee's entitlement (pay bank) balances and their movement history —
 * the read side of the employee drawer's Payroll tab.
 *
 * Balances come straight from the engine, which sums entitlement_ledger; this
 * route never computes a balance of its own and there is no balance column to
 * read. Pay-bank balances are compensation data, so the whole surface is gated
 * on payroll.read behind the payroll feature.
 */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  const orgId = gate.user.orgId
  const employee = new URL(req.url).searchParams.get('employee')
  if (!employee || !isUuid(employee)) {
    return NextResponse.json({ error: 'invalid employee' }, { status: 422 })
  }

  // Money balances are denominated in the employee's legal entity's functional
  // currency (the same currency their wage and pay run carry).
  const currencyRes = (await db.execute<{ currency: string | null }>(sql`
    select coalesce(s.base_currency, o.base_currency) as currency
      from parties p
      join orgs o on o.id = p.org_id
      left join subsidiaries s on s.id = p.subsidiary_id and s.org_id = p.org_id
     where p.org_id = ${orgId} and p.id = ${employee}
  `))
  const currency = currencyRes.rows[0]?.currency ?? 'CAD'

  const balances = await entitlementBalances(orgId, employee)
  // The movements behind those balances — the append-only evidence trail, most
  // recent first, tied back to the pay run that produced each one.
  const movements = (await db.execute(sql`
    select l.id, l.plan_id, pl.code as plan_code, pl.name as plan_name, pl.unit,
           l.movement_date, l.amount, l.hours, l.kind, l.note,
           d.document_number as run_number, l.pay_run_document_id
      from entitlement_ledger l
      join entitlement_plans pl on pl.id = l.plan_id
      left join documents d on d.id = l.pay_run_document_id and d.org_id = l.org_id
     where l.org_id = ${orgId} and l.employee_party_id = ${employee}
     order by l.movement_date desc, l.created_at desc
     limit 200
  `))

  return NextResponse.json({
    currency,
    balances: balances.map((b) => ({
      planId: b.plan.id,
      planCode: b.plan.code,
      planName: b.plan.name,
      unit: b.plan.unit,
      direction: b.plan.direction,
      balance: b.balance,
      balanceMoney: b.balanceMoney,
      balanceHours: b.balanceHours,
      wage: b.wage,
      maxBalance: b.limit?.maxBalance ?? null,
      notifyBalance: b.limit?.notifyBalance ?? null,
      limitScope: b.limit?.scope ?? null,
      overLimit: b.overLimit,
      nearLimit: b.nearLimit,
      lastMovementDate: b.lastMovementDate,
    })),
    movements: movements.rows,
  })
}
