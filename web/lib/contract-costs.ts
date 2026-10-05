import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { ContractCostError } from '@openbooks/engine/revenue'
import { db } from '@openbooks/engine/platform/database'
import { toUnits } from '@openbooks/engine/money'

/**
 * Named contract-cost refusals (feature off, no policy, unconfigured
 * accounts, closed window, missing approval) keep the engine status with
 * the engine message and its remedy — the operator acts on the remedy, so
 * a 500 or a parse error must never stand in for it. Only unexpected
 * defects stay a generic 500.
 */
export function contractCostErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof ContractCostError) {
    return NextResponse.json(
      { error: error.message, code: error.code, remedy: error.remedy },
      { status: error.status },
    )
  }
  console.error(fallback, error)
  return NextResponse.json({ error: fallback }, { status: 500 })
}

/**
 * Operator-entered major units (e.g. "1200.00") to engine minor units
 * through the currency's ISO exponent. Refuses unknown currencies and
 * non-positive amounts by name instead of coercing them.
 */
export async function parseCostAmountMinor(
  orgId: string,
  amount: string,
  currency: string,
): Promise<bigint> {
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ContractCostError(`Currency ${currency} is not an ISO 4217 code.`, {
      code: 'contract_cost_currency_invalid',
      remedy: 'Enter the cost currency as a three-letter ISO code such as CAD.',
    })
  }
  const row = (await db.execute<{ minor_units: number }>(sql`
    select minor_units from currencies where code = ${currency}`)).rows[0]
  if (!row) {
    throw new ContractCostError(`Unknown currency ${currency}.`, {
      code: 'contract_cost_currency_unknown',
      remedy: 'Record the cost in a currency from the ISO registry.',
    })
  }
  const units = toUnits(amount)
  const minor = units / 10n ** BigInt(4 - Math.min(4, Math.max(0, row.minor_units)))
  if (minor <= 0n) {
    throw new ContractCostError('Capitalize a positive cost amount.', {
      remedy: 'Enter the commission or fulfilment cost above zero.',
    })
  }
  return minor
}
