import 'server-only'
import { sql } from 'drizzle-orm'
import { validateProgramCandidate } from '@openbooks/engine/src/stored-value/accounts.ts'
import type { SetupEntityValidationHook } from './types'

type CurrentProgram = {
  name: string
  kind: string
  liability_account_id: string | null
  breakage_income_account_id: string | null
  breakage_policy: string
  breakage_rate: string
  expiry_months: number | null
}

/**
 * Setup writes validate through the same candidate validator as the engine
 * create path, so a program saved in Setup → Billing carries the identical
 * guarantees (account types, rate bounds, income-account requirements)
 * with named refusals instead of constraint violations.
 */
export const validateStoredValueProgramWrite: SetupEntityValidationHook = async ({ orgId, body, rowId, executor }) => {
  const current = rowId
    ? (await executor.execute<CurrentProgram>(sql`
        select name, kind, liability_account_id, breakage_income_account_id,
               breakage_policy, breakage_rate::text as breakage_rate, expiry_months
          from stored_value_programs where id = ${rowId} and org_id = ${orgId}`)).rows[0]
    : null
  if (rowId && !current) return 'not found'
  const str = (value: unknown, fallback: string | null): string | null => {
    if (value === undefined) return fallback
    if (value === null || value === '') return null
    return String(value)
  }
  await validateProgramCandidate(executor, orgId, {
    name: String(body.name ?? current?.name ?? ''),
    kind: String(body.kind ?? current?.kind ?? ''),
    liabilityAccountId: str(body.liabilityAccountId, current?.liability_account_id ?? null),
    breakageIncomeAccountId: str(body.breakageIncomeAccountId, current?.breakage_income_account_id ?? null),
    breakagePolicy: String(body.breakagePolicy ?? current?.breakage_policy ?? 'none'),
    breakageRate: String(body.breakageRate ?? current?.breakage_rate ?? '0'),
    expiryMonths: body.expiryMonths === undefined
      ? (current?.expiry_months ?? null)
      : body.expiryMonths === null || body.expiryMonths === ''
        ? null
        : Number(body.expiryMonths),
  }, rowId ?? null)
}
