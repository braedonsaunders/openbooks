import { type ComponentProps } from 'react'
import { RetroWorkspace } from '../../app/(app)/payroll/retro/RetroWorkspace'
import { RemittanceApNote, RemittancesView } from '../../app/(app)/payroll/remittances/sections'
import { YearEndView } from '../../app/(app)/payroll/year-end/YearEndView'
import { SeparationsView } from '../../app/(app)/payroll/separations/SeparationsView'
import { OpeningBalancesView } from '../../app/(app)/payroll/opening-balances/OpeningBalancesView'
import { EntitlementOpeningsView } from '../../app/(app)/payroll/opening-balances/EntitlementOpeningsView'
import { ParallelRunView } from '../../app/(app)/payroll/parallel-run/ParallelRunView'
import { LaborCostingWorkspace } from '../../app/(app)/admin/setup/labor-costing/LaborCostingWorkspace'
import { LaborPricingHeading, LaborPricingView } from '../../app/(app)/admin/setup/labor-pricing/sections'
import { RunWizard } from '../../app/(app)/payroll/runs/[id]/RunWizard'
import { PayrollSetupHeader, PayrollSetupBanner, PayrollSetupTabs, PacksTabSlot, AccountsTabSlot, PaydayTabSlot, RatesTabSlot, WorkSchedulesTabSlot, DerivedPreviewTabSlot, HolidaysTabSlot, HolidayCalendarTabSlot } from '../../app/(app)/admin/setup/payroll/sections'
import { Sparkles } from 'lucide-react'
import { cn } from '@openbooks/ui'
import { PayrollChecklistBanner, PayrollPreviousRun, PayrollManageLinks, PayrollScheduleList, type PayrollPreviousRunProps, type PayrollScheduleListProps } from '../../app/(app)/payroll/sections'
import { NewRunButton } from '../../app/(app)/payroll/_ui/NewRunButton'
import { ArrowUpRight } from 'lucide-react'
import { BookOpen } from 'lucide-react'
import { Button } from '@openbooks/ui'
import Link from 'next/link'
import { str, num, type WidgetRenderer } from './widget-props'

/** Payroll adapters. Compose native components without changing their props or boundaries. */
export const PAYROLL_WIDGETS = {

  /* --- payroll retro ---------------------------------------------------------------- */
  /** Money stays canonical: the workspace formats client-side in the
   *  browser's locale, so the loader must not pre-format it. */
  'retro-workspace': (props) => (
    <RetroWorkspace
      schedules={props.schedules as ComponentProps<typeof RetroWorkspace>['schedules']}
      canRun={props.canRun === true}
    />
  ),

  /* --- payroll remittances ---------------------------------------------------------- */
  /** The groups travel verbatim: plain serializable engine output. Money and
   *  messages resolve inside the view through useMoney/useTranslations, so
   *  the loader must not pre-format either. */
  'remittance-cockpit': (props) => (
    <RemittancesView
      groups={(props.groups as ComponentProps<typeof RemittancesView>['groups']) ?? []}
      populationRefusal={str(props, 'populationRefusal')}
      from={str(props, 'from') ?? ''}
      to={str(props, 'to') ?? ''}
      canCreate={props.canCreate === true}
    />
  ),
  'remittance-ap-note': (props) => (
    <RemittanceApNote note={str(props, 'note') ?? ''} linkLabel={str(props, 'linkLabel') ?? ''} />
  ),

  /* --- payroll year-end ------------------------------------------------------------- */
  /** Money stays canonical numeric text: the view formats client-side in the
   *  browser's locale. */
  'year-end-workspace': (props) => (
    <YearEndView
      year={num(props, 'year') ?? new Date().getFullYear()}
      years={(props.years as number[]) ?? []}
      sections={(props.sections as ComponentProps<typeof YearEndView>['sections']) ?? []}
    />
  ),

  /* --- payroll opening balances ----------------------------------------------------- */
  /** Money stays canonical text: the grid trims zeros for display over raw
   *  store strings, client-side. */
  'opening-balances-grid': (props) => (
    <OpeningBalancesView
      year={num(props, 'year') ?? new Date().getFullYear()}
      currentYear={num(props, 'currentYear') ?? new Date().getFullYear()}
      initial={props.initial as ComponentProps<typeof OpeningBalancesView>['initial']}
      fields={props.fields as ComponentProps<typeof OpeningBalancesView>['fields']}
      components={props.components as ComponentProps<typeof OpeningBalancesView>['components']}
      canManage={props.canManage === true}
    />
  ),
  /** No `year`: entitlement banks are lifetime balances by design. */
  'entitlement-openings-grid': (props) => (
    <EntitlementOpeningsView
      initial={props.initial as ComponentProps<typeof EntitlementOpeningsView>['initial']}
      canManage={props.canManage === true}
    />
  ),

  /* --- payroll separations ---------------------------------------------------------- */
  /** Money stays canonical: the view formats client-side. */
  'separations-workspace': (props) => (
    <SeparationsView
      year={num(props, 'year') ?? 0}
      years={(props.years as number[]) ?? []}
      sections={(props.sections as ComponentProps<typeof SeparationsView>['sections']) ?? []}
    />
  ),

  /* --- payroll parallel run ------------------------------------------------------ */
  /** Whole: picker state, compare/discard/tolerance mutations, a findings
   *  drawer and conditional cell pairs. Money stays canonical text because
   *  the component formats client-side. */
  'parallel-run-workspace': (props) => (
    <ParallelRunView
      registers={props.registers as ComponentProps<typeof ParallelRunView>['registers']}
      runs={props.runs as ComponentProps<typeof ParallelRunView>['runs']}
      comparisons={props.comparisons as ComponentProps<typeof ParallelRunView>['comparisons']}
      tolerances={props.tolerances as ComponentProps<typeof ParallelRunView>['tolerances']}
      slots={props.slots as ComponentProps<typeof ParallelRunView>['slots']}
      canManage={props.canManage === true}
    />
  ),

  /* --- payroll setup workspace ------------------------------------------------ */
  //
  // The tab bodies are SLOTS, not widgets with props: each re-derives the org
  // id, the registry entry and the manage gate from the session, so the spec
  // carries only which tab is open and the URL it was rendering with.
  'payroll-setup-header': (props) => (
    <PayrollSetupHeader
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      launcher={props.launcher as ComponentProps<typeof PayrollSetupHeader>['launcher']}
    />
  ),
  'payroll-setup-banner': (props) => (
    <PayrollSetupBanner
      launcher={props.launcher as ComponentProps<typeof PayrollSetupBanner>['launcher']}
    />
  ),
  /** The active-vs-plain link pair (and aria-current set vs omitted) lives in
   *  the component; every `active` flag is loader-resolved data. */
  'payroll-setup-tabs': (props) => (
    <PayrollSetupTabs
      groups={(props.groups as ComponentProps<typeof PayrollSetupTabs>['groups']) ?? []}
      activeGroup={str(props, 'activeGroup') ?? ''}
      tabsAria={str(props, 'tabsAria') ?? ''}
      subTabs={(props.subTabs as ComponentProps<typeof PayrollSetupTabs>['subTabs']) ?? []}
    />
  ),
  'payroll-packs-tab': () => <PacksTabSlot />,
  'payroll-accounts-tab': () => <AccountsTabSlot />,
  'payroll-payday-tab': () => <PaydayTabSlot />,
  'payroll-rates-tab': () => <RatesTabSlot />,
  'payroll-schedules-tab': () => <WorkSchedulesTabSlot />,
  'payroll-derived-preview-tab': (props) => (
    <DerivedPreviewTabSlot sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}} />
  ),
  'payroll-holidays-tab': (props) => (
    <HolidaysTabSlot
      sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
      basePath={str(props, 'basePath') ?? '/admin/setup/payroll'}
    />
  ),
  'payroll-holiday-calendar-tab': (props) => (
    <HolidayCalendarTabSlot sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}} />
  ),

  /* --- labor costing / pricing ------------------------------------------------ */
  /** Not `link-button`: that renders one 14px icon with no space and no
   *  `size="sm"`. This cluster is two sized buttons with spaced icons plus a
   *  teal text link carrying a literal arrow. Diffed, kept separate. */
  'labor-costing-header-actions': (props) => (
    <div className="flex flex-wrap items-center gap-2">
      <Button asChild variant="outline" size="sm">
        <Link href={(str(props, 'guideHref') ?? '') as never}>
          <Sparkles size={14} aria-hidden /> {str(props, 'guideLabel') ?? ''}
        </Link>
      </Button>
      <Button asChild variant="ghost" size="sm">
        <Link href="/docs/labor-costing">
          <BookOpen size={14} aria-hidden /> {str(props, 'docsLabel') ?? ''}
        </Link>
      </Button>
      <Link
        href="/admin/setup/overhead"
        className="px-1 text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
      >
        {str(props, 'overheadLabel') ?? ''} →
      </Link>
    </div>
  ),
  /** Not `module-home-tabs`: that is a pill strip; these are underline links
   *  with no `aria-current`. */
  'labor-costing-tabs': (props) => {
    const tabs = (props.tabs as { href: string; label: string; active: boolean }[]) ?? []
    return (
      <div className="flex gap-1 overflow-x-auto border-b border-slate-200 dark:border-slate-800">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href as never}
            className={cn(
              '-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
              tab.active
                ? 'border-teal-600 text-teal-700 dark:text-teal-300'
                : 'border-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-100',
            )}
          >
            {tab.label}
          </Link>
        ))}
      </div>
    )
  },
  /** The spec spreads the workspace's props directly, as the loader builds
   *  them — there is no nested `workspace` bag. */
  'labor-costing-workspace': (props) => (
    <LaborCostingWorkspace {...(props as unknown as ComponentProps<typeof LaborCostingWorkspace>)} />
  ),
  'labor-pricing-heading': (props) => (
    <LaborPricingHeading
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      docsHref={str(props, 'docsHref') ?? '/docs/labor-pricing'}
      docsLabel={str(props, 'docsLabel') ?? ''}
    />
  ),
  'labor-pricing-view': (props) => (
    <LaborPricingView {...(props as unknown as ComponentProps<typeof LaborPricingView>)} />
  ),

  /* --- pay run wizard --------------------------------------------------------- */
  /** Five freely-navigable steps whose every control is a fetch flow plus
   *  client state a spec cannot name — the /tax shape. */
  'pay-run-wizard': (props) => (
    <RunWizard {...(props as unknown as ComponentProps<typeof RunWizard>)} />
  ),

  /* --- payroll cockpit ------------------------------------------------------- */
  'payroll-settings-banner': (props) => (
    <PayrollChecklistBanner
      text={str(props, 'text') ?? ''}
      settings={str(props, 'settings') ?? ''}
      openSettingsLabel={str(props, 'openSettingsLabel') ?? ''}
    />
  ),
  /** Includes its own empty state: a negated conditional pair is not a spec
   *  construct, the same call the purchasing cockpit made. */
  'payroll-current-period': (props) => (
    <PayrollScheduleList
      schedules={(props.schedules as PayrollScheduleListProps['schedules']) ?? []}
      emptyText={str(props, 'emptyText') ?? ''}
      showSetupLink={props.showSetupLink === true}
      setupLabel={str(props, 'setupLabel') ?? ''}
      labels={
        (props.labels as PayrollScheduleListProps['labels']) ?? {
          frequency: {},
          period: '',
          payDate: '',
          employees: '',
          net: '',
        }
      }
    />
  ),
  'payroll-previous-run': (props) => (
    <PayrollPreviousRun
      run={(props.run as PayrollPreviousRunProps['run']) ?? null}
      periodLabel={str(props, 'periodLabel') ?? ''}
      payDateLabel={str(props, 'payDateLabel') ?? ''}
      netLabel={str(props, 'netLabel') ?? ''}
      employeesLabel={str(props, 'employeesLabel') ?? ''}
      noneText={str(props, 'noneText') ?? ''}
    />
  ),
  'payroll-manage-links': (props) => (
    <PayrollManageLinks
      paySchedulesLabel={str(props, 'paySchedulesLabel') ?? ''}
      payComponentsLabel={str(props, 'payComponentsLabel') ?? ''}
    />
  ),

  /* --- pay runs ------------------------------------------------------------- */
  'new-pay-run': (props) => (
    <NewRunButton
      schedules={(props.schedules as ComponentProps<typeof NewRunButton>['schedules']) ?? []}
      finalPayCandidates={
        (props.finalPayCandidates as ComponentProps<typeof NewRunButton>['finalPayCandidates']) ?? []
      }
      today={str(props, 'today') ?? ''}
    />
  ),
  /** A pay run opens a full wizard page, not a drawer, so its row action is a
   *  plain link built from the row id. */
  'pay-run-row-actions': (props) => (
    <Link
      href={`/payroll/runs/${String(props.id ?? '')}` as never}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-teal-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-teal-300"
      aria-label={str(props, 'label') ?? ''}
      title={str(props, 'label') ?? ''}
    >
      <ArrowUpRight size={15} />
    </Link>
  ),
} satisfies Record<string, WidgetRenderer>
