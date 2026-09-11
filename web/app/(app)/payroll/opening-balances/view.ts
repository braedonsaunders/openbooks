import 'server-only'

import { getTranslations } from 'next-intl/server'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import {
  OPENING_BALANCE_FIELDS,
  type OpeningBalanceYear,
} from '@openbooks/engine/src/payroll-opening-balances.ts'
import type { EntitlementOpeningsResult } from '@openbooks/engine/src/payroll-entitlements-openings.ts'
import { grid, page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { can, requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { pickString } from '../../../../lib/list-params'
import {
  scopedEntitlementOpenings,
  scopedOpeningBalances,
} from '../../../../lib/payroll-scoped-views'
import { groupTabs } from '../../../../components/module-home/group-tabs'
import type { OpeningBalancesView } from './OpeningBalancesView'
import type { EntitlementOpeningsView } from './EntitlementOpeningsView'

/**
 * Mid-year adoption: the statutory year-to-date each employee brings in from
 * the employer's previous payroll system.
 *
 * Two fully client-interactive grids, not server-rendered tables. Each grid
 * owns draft state (statutory + component drafts on the year grid, plan
 * drafts plus the adoption-date input on the banks grid), save POSTs with
 * toast feedback, error/warning callouts, client-side row filtering
 * (only-missing) and the legacy-prefill action. Decomposing either into
 * `table` blocks would split one component's state across two render paths
 * and reimplement its conditional pairs (locked badge vs none marker,
 * per-pack em-dash vs input, per-row error list, legacy banner, blocked
 * hint) as spec constructs that do not exist.
 *
 * So the spec places both grids whole through two widgets, the same call the
 * retro and parallel-run pages made: the views move nowhere and are shared
 * by the page and the widget registry. The loader below copies page.tsx verbatim — the
 * `payroll.read` gate, the `payroll` feature gate (404 when disabled), the
 * business-day tax year with its clamped `?year=` override, the scoped
 * statutory read, the deliberately year-agnostic bank read, the module tabs,
 * and the `payroll.manage` flag. Money stays canonical numeric text because
 * the components format client-side (trimZeros display, raw-string drafts).
 *
 * No sections.tsx: nothing is moved or duplicated — both views stay where
 * they are and one set of components is imported.
 */

type BalancesProps = Parameters<typeof OpeningBalancesView>[0]
type BanksProps = Parameters<typeof EntitlementOpeningsView>[0]

export interface PayrollOpeningBalancesData {
  title: string
  description: string
  viewTabs: Awaited<ReturnType<typeof groupTabs>>
  balances: {
    year: BalancesProps['year']
    currentYear: BalancesProps['currentYear']
    initial: OpeningBalanceYear
    fields: BalancesProps['fields']
    components: BalancesProps['components']
    canManage: boolean
  }
  banks: {
    initial: EntitlementOpeningsResult
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
    Number.isInteger(requested) && requested >= 2000 && requested <= 2100 ? requested : currentYear

  const data = await scopedOpeningBalances(authz, year)
  // Bank carry-ins are NOT year-scoped (a bank has one lifetime balance), so
  // this load deliberately ignores `year`. See EntitlementOpeningsView.
  const banks = await scopedEntitlementOpenings(authz)
  const tabs = await groupTabs('payroll', '/payroll/opening-balances', { orgId })
  const text = (key: string, fallback: string) => (t.has(key as never) ? t(key as never) : fallback)

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
      fields: OPENING_BALANCE_FIELDS.map((field) => ({
        key: field.key,
        label: field.label,
        help: field.help,
        packs: [...field.packs],
      })),
      components: data.components,
      canManage: can(authz, 'payroll.manage'),
    },
    banks: {
      initial: banks,
      canManage: can(authz, 'payroll.manage'),
    },
  }
}

const f = ref<PayrollOpeningBalancesData>()

export function payrollOpeningBalancesSpec(_data: PayrollOpeningBalancesData): PageSpec {
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
      // The native `<div className="space-y-8">` around the two sections is
      // a plain grid here: both widgets render their own outer
      // `<div className="space-y-4">` / `<section className="space-y-4">`,
      // exactly as the native page nests them inside that div.
      grid('space-y-8', [
        // The adoption grid — year picker, only-missing toggle,
        // import/export links, the carried-in counter, the Save action, the
        // error callout and the statutory + component columns. The component
        // owns draft state, the save POST and every conditional pair; the
        // spec only names where it lives.
        widgetBlock('opening-balances-grid', {
          year: f('balances.year'),
          currentYear: f('balances.currentYear'),
          initial: f('balances.initial'),
          fields: f('balances.fields'),
          components: f('balances.components'),
          canManage: f('balances.canManage'),
        }),
        // The bank carry-ins section — adoption-date input, import/export
        // links, the counter, the Save action, the legacy banner, the
        // error/warning callouts and the per-plan columns. Same whole-widget
        // reasoning as above. Year-agnostic by design: a bank has one
        // lifetime balance, so this widget never receives `year`.
        widgetBlock('entitlement-openings-grid', {
          initial: f('banks.initial'),
          canManage: f('banks.canManage'),
        }),
      ]),
    ],
  })
}
