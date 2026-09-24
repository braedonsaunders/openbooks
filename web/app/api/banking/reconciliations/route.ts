import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { startReconciliation } from '@openbooks/engine/src/banking/banking.ts'
import { normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { canonicalDecimal } from '../../../../lib/exact-decimal'
import { subsidiaryVisibleFilter } from '../../../../lib/subsidiaries'
import { moneyRefusal } from '../../../../lib/payroll-decimal-refusal'
import { bankingErrorResponse } from '../util'

export const runtime = 'nodejs'

/** List reconciliation sessions, optionally for one account. */
export async function GET(req: Request) {
  const gate = await guardFeaturePermission('banking.read', 'banking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const accountId = new URL(req.url).searchParams.get('accountId')
  if (accountId && !isUuid(accountId)) {
    return NextResponse.json({ error: 'invalid accountId' }, { status: 400 })
  }
  const rows = (await db.execute(sql`
    select r.id, r.account_id, r.through_date, r.statement_balance, r.status,
           r.signed_off_at, r.created_at,
           a.number as account_number, a.name as account_name
      from reconciliations r
      join accounts a on a.id = r.account_id and a.org_id = r.org_id
     where r.org_id = ${user.orgId}
       ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, gate.allowedSubsidiaryIds)}
       ${accountId ? sql` and r.account_id = ${accountId}` : sql``}
     order by r.created_at desc
     limit 200
  `))
  return NextResponse.json({ reconciliations: rows.rows })
}

/** Start a reconciliation session (one open session per account). */
export async function POST(req: Request) {
  const gate = await guardFeaturePermission('banking.reconcile', 'banking')
  if (gate instanceof NextResponse) return gate
  const { user } = gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    accountId?: string
    throughDate?: string
    statementBalance?: string
  }
  if (!body.accountId || !body.throughDate || body.statementBalance == null || body.statementBalance === '') {
    return NextResponse.json(
      { error: 'accountId, throughDate and statementBalance are required' },
      { status: 400 },
    )
  }
  // A malformed account id dies in the reconcilable-account lookup as an
  // unhandled uuid throw (raw 500); the GET verb in this file already refuses
  // it as a domain error, so refuse it here the same way.
  if (!isUuid(body.accountId)) {
    return NextResponse.json({ error: 'invalid accountId' }, { status: 400 })
  }
  const statementBalanceRaw = canonicalDecimal(body.statementBalance, 4)
  if (statementBalanceRaw === null) {
    return NextResponse.json({ error: moneyRefusal('Statement balance', body.statementBalance) }, { status: 422 })
  }
  let statementBalance: string
  try {
    statementBalance = normalizeMoney(statementBalanceRaw)
  } catch {
    return NextResponse.json({ error: 'Statement balance is out of range for the ledger' }, { status: 422 })
  }
  try {
    const { id } = await startReconciliation(
      {
        accountId: body.accountId,
        throughDate: body.throughDate,
        statementBalance,
      },
      { orgId: user.orgId, userId: user.id, allowedSubsidiaryIds: gate.allowedSubsidiaryIds },
    )
    return NextResponse.json({ id })
  } catch (e) {
    return bankingErrorResponse(e)
  }
}
