import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import { normalizeMoney } from '@openbooks/engine/src/money/money.ts'
import { PayrollError } from "@openbooks/engine/src/payroll/error.ts";
import { ScopeNotFoundError } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import {
  assertTaxYear,
  declaredProgramBaseFields,
  OPENING_BALANCE_FIELDS,
  OpeningBalanceSaveError,
  saveOpeningBalances,
  type OpeningBalanceWrite,
} from '@openbooks/engine/src/payroll/opening-balances.ts'
import { US_STATES } from '@openbooks/engine/src/payroll/us/rates.ts'
import { canonicalDecimal } from '../../../../lib/exact-decimal'
import { moneyRefusal } from '../../../../lib/payroll-decimal-refusal'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { scopedOpeningBalances } from '../../../../lib/payroll-scoped-views'
import { isUuid } from '../../../../lib/list-params'
import {
  saveItSurtaxSaldoCarryIns,
  SurtaxSaldoSaveError,
} from '@openbooks/engine/src/payroll/it/saldo-carryins.ts'

/**
 * The carry-in grid's two IT-only assessed-saldo columns (migration 0393):
 * grid keys routed to it_addizionali_opening_balances, never to the generic
 * save (which would refuse the unknown keys). All-blank means "untouched":
 * the grid replays full rows, so an absent value must keep what is stored —
 * especially never conjure a zero row that would silence the installment
 * channel's refusal. Explicit values, including explicit zeros, persist
 * (presence is the declaration).
 */
const IT_SALDO_KEYS = ['itRegionaleSaldo', 'itComunaleSaldo'] as const

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Mid-year adoption carry-in: the statutory year-to-date an employer
 * accumulated on a previous payroll system, per employee per tax year.
 *
 * Reading is `payroll.read` and writing is `payroll.manage` — these amounts
 * are compensation facts that move CPP/EI/FICA withholding on a real cheque,
 * so they sit behind payroll's own permissions rather than the generic
 * `admin.setup.manage` the Setup registry API uses.
 *
 * Every rule (money validation, the cross-field sanity checks, and the refusal
 * to edit a carry-in a committed run already consumed) lives in
 * engine/src/payroll/opening-balances.ts, which is the single write path. This
 * route only translates HTTP.
 */

async function currentTaxYear(orgId: string): Promise<number> {
  return Number((await businessToday(orgId)).slice(0, 4))
}

async function parseYear(orgId: string, raw: string | null): Promise<number> {
  if (!raw) return currentTaxYear(orgId)
  const year = Number(raw)
  return Number.isInteger(year) ? year : currentTaxYear(orgId)
}

export async function GET(req: Request) {
  const gate = await guardFeaturePermission('payroll.read', 'payroll')
  if (gate instanceof NextResponse) return gate
  let year: number
  try {
    year = assertTaxYear(await parseYear(gate.user.orgId, new URL(req.url).searchParams.get('year')))
  } catch (error) {
    return NextResponse.json({ error: message(error) }, { status: 422 })
  }
  const data = await scopedOpeningBalances(gate, year)
  // Pack-declared contribution programs ride alongside the statutory fields:
  // the grid shows one carry-in column per program some employee's country
  // pack declares, labeled from the declaration itself.
  const programs = await declaredProgramBaseFields()
  return NextResponse.json({
    ...data,
    fields: OPENING_BALANCE_FIELDS.map((field) => ({
      key: field.key, label: field.label, help: field.help, packs: field.packs,
    })),
    programs: programs.map((program) => ({
      key: program.programKey, label: program.label, help: program.help,
      packs: [program.country],
    })),
    // Per-state SUI carry-in codes the grid offers for US employees. Once
    // any state row exists for an employee-year, SUI reads only the state
    // rows; the unscoped insurable amount keeps feeding FUTA.
    suiStates: {
      codes: [...US_STATES],
      help: 'Pre-adoption wages insurable for unemployment insurance in this state. '
        + 'Enter only wages the gaining state\u2019s transfer rule lets transfer '
        + '(most states credit same-employer wages reported to another state toward the new state\u2019s base).',
    },
  })
}

interface SaveBody {
  taxYear?: unknown
  rows?: unknown
}

/** Exact numeric(19,4) money string, empty when omitted, or 'invalid'. */
function persistMoney(value: unknown): string | '' | 'invalid' {
  if (value == null || value === '' || (typeof value === 'string' && value.trim() === '')) return ''
  const exact = canonicalDecimal(value, 4)
  if (exact === null) return 'invalid'
  try {
    return normalizeMoney(exact)
  } catch {
    return 'invalid'
  }
}

// The refusal names the offending entry, so the map carries the first bad
// key and value instead of a bare 'invalid' no message can observe.
type MoneyMap = { ok: true; map: Record<string, unknown> } | { ok: false; key: string; value: unknown }
function persistMoneyMap(raw: Record<string, unknown>): MoneyMap {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    const persisted = persistMoney(value)
    if (persisted === 'invalid') return { ok: false, key, value }
    out[key] = persisted
  }
  return { ok: true, map: out }
}

/** Component openings arrive keyed by component id (or code); values are text. */
function componentAmounts(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return raw as Record<string, unknown>
}

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('payroll.manage', 'payroll')
  if (gate instanceof NextResponse) return gate

  let body: SaveBody
  try {
    const parsedBody = await parseJsonBody(req, jsonObject);
    if (!parsedBody.ok) return parsedBody.response;
    body = (parsedBody.data) as SaveBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  if (!Array.isArray(body.rows)) {
    return NextResponse.json({ error: 'rows must be an array' }, { status: 422 })
  }

  const rows: OpeningBalanceWrite[] = []
  const saldoRows: { employeePartyId: string; regionaleSaldo: unknown; comunaleSaldo: unknown }[] = []
  for (const raw of body.rows) {
    const row = raw as {
      employeePartyId?: unknown
      amounts?: unknown
      components?: unknown
      programs?: unknown
      suiStates?: unknown
      updatedAt?: unknown
    }
    if (typeof row?.employeePartyId !== 'string' || !isUuid(row.employeePartyId)) {
      return NextResponse.json({ error: 'each row needs a valid employeePartyId' }, { status: 422 })
    }
    // The row's loader-served version for the lost-update guard. Absent
    // means the caller does not speak versions (the file importer) and the
    // row saves unguarded, as before — never a silent default.
    let updatedAt: string | null | undefined
    if (row.updatedAt === undefined || row.updatedAt === null) updatedAt = row.updatedAt
    else if (typeof row.updatedAt === 'string') updatedAt = row.updatedAt
    else {
      return NextResponse.json({ error: 'updatedAt must be the row version string or null' }, { status: 422 })
    }
    if (row.amounts != null && (typeof row.amounts !== 'object' || Array.isArray(row.amounts))) {
      return NextResponse.json({ error: 'amounts must be an object' }, { status: 422 })
    }
    if (row.components != null && (typeof row.components !== 'object' || Array.isArray(row.components))) {
      return NextResponse.json({ error: 'components must be an object' }, { status: 422 })
    }
    const amounts = persistMoneyMap((row.amounts ?? {}) as Record<string, unknown>)
    if (!amounts.ok) {
      return NextResponse.json({ error: moneyRefusal(`Opening-balance amount for "${amounts.key}"`, amounts.value) }, { status: 422 })
    }
    const rawComponents = componentAmounts(row.components)
    let components: Record<string, unknown> | undefined
    if (rawComponents !== undefined) {
      const persisted = persistMoneyMap(rawComponents)
      if (!persisted.ok) {
        return NextResponse.json({ error: moneyRefusal(`Component amount for "${persisted.key}"`, persisted.value) }, { status: 422 })
      }
      components = persisted.map
    }
    if (row.programs != null && (typeof row.programs !== 'object' || Array.isArray(row.programs))) {
      return NextResponse.json({ error: 'programs must be an object' }, { status: 422 })
    }
    let programs: Record<string, unknown> | undefined
    if (row.programs !== undefined) {
      const persisted = persistMoneyMap(row.programs as Record<string, unknown>)
      if (!persisted.ok) {
        return NextResponse.json({ error: moneyRefusal(`Program carry-in for "${persisted.key}"`, persisted.value) }, { status: 422 })
      }
      programs = persisted.map
    }
    const saldoRaw = {
      regionaleSaldo: amounts.map[IT_SALDO_KEYS[0]] ?? null,
      comunaleSaldo: amounts.map[IT_SALDO_KEYS[1]] ?? null,
    }
    delete amounts.map[IT_SALDO_KEYS[0]]
    delete amounts.map[IT_SALDO_KEYS[1]]
    // All-blank saldo is an untouched row, not a clearing: keep what is
    // stored (a conjured zero would silence the installment refusal).
    if (
      (saldoRaw.regionaleSaldo != null && String(saldoRaw.regionaleSaldo) !== '') ||
      (saldoRaw.comunaleSaldo != null && String(saldoRaw.comunaleSaldo) !== '')
    ) {
      saldoRows.push({
        employeePartyId: row.employeePartyId,
        regionaleSaldo: saldoRaw.regionaleSaldo,
        comunaleSaldo: saldoRaw.comunaleSaldo,
      })
    }
    if (row.suiStates != null && (typeof row.suiStates !== 'object' || Array.isArray(row.suiStates))) {
      return NextResponse.json({ error: 'suiStates must be an object' }, { status: 422 })
    }
    let suiStates: Record<string, unknown> | undefined
    if (row.suiStates !== undefined) {
      const persisted = persistMoneyMap(row.suiStates as Record<string, unknown>)
      if (!persisted.ok) {
        return NextResponse.json({ error: moneyRefusal(`SUI carry-in for "${persisted.key}"`, persisted.value) }, { status: 422 })
      }
      suiStates = persisted.map
    }
    rows.push({
      employeePartyId: row.employeePartyId,
      amounts: amounts.map,
      // Absent means "this client does not speak components", which the service
      // treats as "keep what is stored". Sending {} is how the grid clears them.
      components,
      // Same contract for program carry-ins: absent keeps what is stored,
      // {} clears them.
      programs,
      // Same contract for state SUI carry-ins: absent keeps what is stored,
      // {} clears them.
      suiStates,
      updatedAt,
    })
  }

  try {
    if (saldoRows.length > 0) {
      await saveItSurtaxSaldoCarryIns({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        taxYear: assertTaxYear(body.taxYear),
        rows: saldoRows,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      })
    }
    const result = await saveOpeningBalances({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      taxYear: assertTaxYear(body.taxYear),
      rows,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof ScopeNotFoundError) return NextResponse.json({ error: 'not found' }, { status: 404 })
    // A refusal is data the operator has to see per row, not a bare 4xx: a
    // whole-workforce load rejected for one transposed column must say which
    // employee, and nothing was written.
    if (error instanceof OpeningBalanceSaveError) {
      return NextResponse.json(
        { error: error.message, errors: error.result.errors, created: 0, updated: 0, deleted: 0, skipped: [] },
        { status: 409 },
      )
    }
    if (error instanceof SurtaxSaldoSaveError) {
      return NextResponse.json(
        { error: error.message, errors: error.result.errors, created: 0, updated: 0, deleted: 0, skipped: [] },
        { status: 409 },
      )
    }
    if (error instanceof PayrollError) {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    throw error
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'invalid request'
}
