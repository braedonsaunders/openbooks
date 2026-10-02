import 'server-only'

import { getTranslations } from 'next-intl/server'
import { businessToday } from '@openbooks/engine/src/platform/business-date.ts'
import {
  OPENING_BALANCE_FIELDS,
  declaredAccountOpeningBaseFields,
  declaredEmployerLevyFields,
  declaredProgramBaseFields,
  employerLevyOpeningsForYear,
  type OpeningBalanceYear,
} from '@openbooks/engine/src/payroll/opening-balances.ts'
import { US_STATES } from '@openbooks/engine/src/payroll/us/rates.ts'
import { listFilingAccounts } from '@openbooks/engine/src/payroll/filing.ts'
import type { EntitlementOpeningsResult } from '@openbooks/engine/src/payroll/entitlements-openings.ts'
import { itSurtaxSaldoCarryIns } from '@openbooks/engine/src/payroll/it/saldo-carryins.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { pickString } from '../../../../lib/list-params'
import {
  scopedEntitlementOpenings,
  scopedOpeningBalances,
} from '../../../../lib/payroll-scoped-views'
import { groupTabs } from '../../../../components/module-home/group-tabs'
import type { OpeningBalancesView } from './OpeningBalancesView'

/** The authorized loader serves three independent carry-in scopes to one workspace. */

type BalancesProps = Parameters<typeof OpeningBalancesView>[0]

/**
 * The carry-in grid's two IT-only assessed-saldo columns (migration 0393):
 * the prior-year regional/municipal assessment the year's
 * installments withhold. Shown for IT employees only via the packs filter;
 * the save routes these keys to it_addizionali_opening_balances, never to
 * the generic opening-balances save.
 */
const IT_SALDO_FIELDS = [
  {
    key: 'itRegionaleSaldo',
    label: 'Addizionale regionale a saldo (anno precedente)',
    help: "Prior-year regionale assessment the year's installments withhold (D.Lgs. 446/1997 art. 50) — from the prior provider's final report or the year N-1 CU. Enter 0.00 when the worker had no prior-year Italian employment; the installment run refuses until this is recorded.",
    packs: ['IT'],
  },
  {
    key: 'itComunaleSaldo',
    label: 'Addizionale comunale a saldo (anno precedente)',
    help: "Prior-year comunale assessment the year's installments withhold (D.Lgs. 360/1998 art. 1) — from the prior provider's final report or the year N-1 CU. Enter 0.00 when the worker had no prior-year Italian employment; the installment run refuses until this is recorded.",
    packs: ['IT'],
  },
] as const

export interface PayrollOpeningBalancesData {
  title: string
  description: string
  viewTabs: Awaited<ReturnType<typeof groupTabs>>
  balances: {
    year: BalancesProps['year']
    currentYear: BalancesProps['currentYear']
    initial: OpeningBalanceYear
    fields: BalancesProps['fields']
    programs: BalancesProps['programs']
    suiStates: BalancesProps['suiStates']
    accountPrograms: BalancesProps['accountPrograms']
    components: BalancesProps['components']
    canManage: boolean
  }
  banks: {
    initial: EntitlementOpeningsResult
    canManage: boolean
  }
  employerLevies: {
    year: number
    levies: {
      country: string
      levyKey: string
      label: string
      description: string
      scope: string
    }[]
    rows: {
      country: string
      levyKey: string
      region: string | null
      baseYtd: string
    }[]
    canManage: boolean
  }
}

export async function loadPayrollOpeningBalances(
  sp: Record<string, string | string[] | undefined>,
): Promise<PayrollOpeningBalancesData> {
  const authz = await requirePermission('payroll.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'payroll')

  const t = await getTranslations('payroll')
  const currentYear = Number((await businessToday(orgId)).slice(0, 4))
  const requested = Number(pickString(sp.year))
  const year =
    Number.isInteger(requested) && requested >= 2000 && requested <= 2100
      ? requested
      : currentYear

  const data = await scopedOpeningBalances(authz, year)
  // IT assessed-saldo carry-ins (migration 0393) ride the same grid as two
  // IT-only columns backed by their own table — the generic layer never names
  // it. Rows merge here; the save splits them back out before the generic
  // save, which would refuse the unknown keys.
  const saldoByEmployee = new Map(
    (await itSurtaxSaldoCarryIns(db, orgId, year)).map((row) => [
      row.employeePartyId,
      row,
    ]),
  )
  for (const row of data.rows) {
    const saldo = saldoByEmployee.get(row.employeePartyId)
    if (!saldo) continue
    row.amounts = {
      ...(row.amounts ?? {}),
      [IT_SALDO_FIELDS[0].key]: saldo.regionaleSaldo,
      [IT_SALDO_FIELDS[1].key]: saldo.comunaleSaldo,
    }
  }
  const accountDeclarations = await declaredAccountOpeningBaseFields()
  const filingAccounts = (await listFilingAccounts(orgId, 'US')).filter(
    (account) =>
      authz.allowedSubsidiaryIds === null ||
      account.subsidiaryId === null ||
      authz.allowedSubsidiaryIds.has(account.subsidiaryId),
  )
  // Bank carry-ins are NOT year-scoped (a bank has one lifetime balance), so
  // this load deliberately ignores `year`. See EntitlementOpeningsView.
  const banks = await scopedEntitlementOpenings(authz)
  const tabs = await groupTabs('payroll', '/payroll/opening-balances', {
    orgId,
  })
  const text = (key: string, fallback: string) =>
    t.has(key as never) ? t(key as never) : fallback

  return {
    title: text('openingBalances.title', 'Opening balances'),
    description: text(
      'openingBalances.description',
      'Everything each employee carries in from your previous payroll system: statutory year-to-date, the annual caps they have partly used, and their vacation and banked-time balances. Nothing else supplies these, so every ceiling and every bank restarts at zero without them.',
    ),
    viewTabs: tabs,
    balances: {
      year,
      currentYear,
      initial: data,
      fields: [
        ...OPENING_BALANCE_FIELDS.map((field) => ({
          key: field.key,
          label: field.label,
          help: field.help,
          packs: [...field.packs],
        })),
        ...IT_SALDO_FIELDS.map((field) => ({
          key: field.key,
          label: field.label,
          help: field.help,
          packs: [...field.packs],
        })),
      ],
      programs: (await declaredProgramBaseFields()).map((program) => ({
        key: program.programKey,
        label: program.label,
        help: program.help,
        packs: [program.country],
      })),
      // One SUI column per US state. The help is the same transfer
      // determination the API serves (keep in sync with GET
      // /api/payroll/opening-balances, suiStates.help): entering a state row
      // asserts those wages transfer under the gaining state's rule.
      suiStates: [...US_STATES].map((code) => ({
        key: code,
        label: code,
        help: 'Pre-adoption wages insurable for unemployment insurance in this state. Enter only wages the gaining state\u2019s transfer rule lets transfer (most states credit same-employer wages reported to another state toward the new state\u2019s base).',
        packs: ['US'],
      })),
      accountPrograms: accountDeclarations.flatMap((program) =>
        filingAccounts
          .filter(
            (account) =>
              account.country === program.country &&
              account.programType === program.filingProgramType,
          )
          .filter(
            (account) => !program.requiresRegion || account.stateCode !== null,
          )
          .map((account) => {
            const region = program.requiresRegion ? account.stateCode : null
            return {
              key: `${program.programKey}:${account.id}:${region ?? ''}`,
              programKey: program.programKey,
              label: `${program.label} — ${account.name}${region ? ` (${region})` : ''}`,
              help: `${program.help} Filing account: ${account.name} (${account.accountNumber}).`,
              country: program.country,
              filingAccountId: account.id,
              region,
              requiresRegion: program.requiresRegion,
            }
          }),
      ),
      components: data.components,
      canManage: can(authz, 'payroll.manage'),
    },
    banks: {
      initial: banks,
      canManage: can(authz, 'payroll.manage'),
    },
    employerLevies: {
      year,
      levies: await declaredEmployerLevyFields(year),
      rows: await employerLevyOpeningsForYear(orgId, year),
      canManage: can(authz, 'payroll.manage'),
    },
  }
}

const f = ref<PayrollOpeningBalancesData>()

export function payrollOpeningBalancesSpec(
  _data: PayrollOpeningBalancesData,
): PageSpec {
  return page({
    route: '/payroll/opening-balances',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [widget('module-home-tabs', { tabs: _data.viewTabs })],
      }),
    ],
    body: [
      widgetBlock('opening-balances-workspace', {
        balances: f('balances'),
        banks: f('banks'),
        employerLevies: f('employerLevies'),
      }),
    ],
  })
}
