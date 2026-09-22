import { type ComponentProps } from 'react'
import { DepreciationSetupHeader } from '../../app/(app)/admin/setup/depreciation/sections'
import { TaxSetupGuideSlot, TaxSetupHeader } from '../../app/(app)/admin/setup/tax-setup/sections'
import { EquipmentHeaderLinks } from '../../app/(app)/assets/equipment/sections'
import { ProvisionRunsTable } from '../../app/(app)/tax/provisions/sections'
import { ProvisionComputeButton } from '../../app/(app)/tax/provisions/ProvisionComputeButton'
import { NewEquipmentButton } from '../../app/(app)/assets/equipment/NewEquipmentButton'
import { EquipmentDrawer } from '../../app/(app)/assets/equipment/EquipmentDrawer'
import { KpiStrip } from '../kpi-strip'
import { TaxDepreciationHeader, TaxDepreciationOverviewSlot } from '../../app/(app)/admin/setup/tax-depreciation/sections'
import { ProvisionDifferencesSection, ProvisionFrameworkBadge, ProvisionPostButton, ProvisionReconSection, ProvisionStatusBadge } from '../../app/(app)/tax/provisions/[id]/sections'
import { TaxFilingDrawer, TaxHistoryTable, TaxPageHeader, TaxPageShell, TaxPreparePanel, TaxTabPanels, TaxTabs } from '../../app/(app)/tax/sections'
import { AssetsTabs, AssetsDocLink, AssetsEquipmentLink } from '../../app/(app)/assets/sections'
import { NewAssetButton } from '../../app/(app)/assets/NewAssetButton'
import { NewAssetRedirect } from '../../app/(app)/assets/NewAssetRedirect'
import { RunDepreciationButton } from '../../app/(app)/assets/RunDepreciationButton'
import { AssetDrawer } from '../../app/(app)/assets/AssetDrawer'
import { TaxPoolsView } from '../../app/(app)/assets/tax-pools/TaxPoolsView'
import { str, type WidgetRenderer } from './widget-props'

/** Assets, depreciation and tax adapters. Compose native components without changing their props or boundaries. */
export const ASSETS_TAX_WIDGETS = {

  /* --- tax provision list ----------------------------------------------------------- */
  /** The empty state lives INSIDE the component: the native empty path keeps
   *  the card and header-row chrome and renders a `colSpan={6}` note, which a
   *  spec-level empty block would drop. */
  'provision-runs-table': (props) => (
    <ProvisionRunsTable
      columns={props.columns as ComponentProps<typeof ProvisionRunsTable>['columns']}
      emptyText={str(props, 'emptyText') ?? ''}
      rows={(props.rows as ComponentProps<typeof ProvisionRunsTable>['rows']) ?? []}
    />
  ),
  'provision-compute-button': () => <ProvisionComputeButton />,

  /* --- equipment -------------------------------------------------------------------- */
  // Kept for tenant PageSpecs saved before the shared ModuleHomeTabs
  // conversion; the built-in equipment page no longer emits this widget.
  'equipment-header-links': (props) => (
    <EquipmentHeaderLinks
      fixedAssetsLabel={str(props, 'fixedAssetsLabel') ?? ''}
      taxDepreciationLabel={str(props, 'taxDepreciationLabel') ?? ''}
      documentationLabel={str(props, 'documentationLabel') ?? ''}
      showFixedAssetsLinks={props.showFixedAssetsLinks === true}
    />
  ),
  /** Loader-formatted `Kpi[]` straight through: the KPI strip's markup is not
   *  the stat-tile block's. */
  'equipment-kpi-strip': (props) => (
    <KpiStrip items={(props.items as ComponentProps<typeof KpiStrip>['items']) ?? []} />
  ),
  'new-equipment': (props) => (
    <NewEquipmentButton
      currentParams={(props.currentParams as Record<string, string | string[] | undefined>) ?? {}}
    />
  ),
  /** The remount key rides along as a prop: switching units must reset the
   *  drawer's client state, and a widget at a fixed spec position would
   *  otherwise be reused across units. */
  'equipment-drawer': (props) => {
    const drawer = props.drawer as
      | (ComponentProps<typeof EquipmentDrawer> & { remountKey: string })
      | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <EquipmentDrawer key={remountKey} {...rest} />
  },
  /* createMode rides the existing equipment-drawer widget on an in-memory unit. */

  /* --- tax setup -------------------------------------------------------------------- */
  /** The native page owns a plain `<header>`, not the PageHeader component. */
  'tax-setup-header': (props) => (
    <TaxSetupHeader title={str(props, 'title') ?? ''} subtitle={str(props, 'subtitle') ?? ''} />
  ),
  /** ONE object prop. Country display names stay CLIENT-side (browser
   *  locale), so the loader passes raw country codes and formats nothing. */
  'tax-setup-guide': (props) => (
    <TaxSetupGuideSlot guide={props.guide as ComponentProps<typeof TaxSetupGuideSlot>['guide']} />
  ),

  /* --- book depreciation setup ------------------------------------------------------ */
  /** Deliberately NOT the tax-depreciation header: two tabs fit, so the
   *  native strip omits `overflow-x-auto` and `shrink-0`. Two components,
   *  because the markup genuinely differs. */
  'depreciation-setup-header': (props) => (
    <DepreciationSetupHeader
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      tabs={(props.tabs as ComponentProps<typeof DepreciationSetupHeader>['tabs']) ?? []}
      tabsAria={str(props, 'tabsAria') ?? ''}
    />
  ),

  /* --- tax depreciation setup ---------------------------------------------------- */
  /** `descriptionClassName` is loader-resolved verbatim: `max-w-3xl` appears
   *  on the overview branch only. */
  'tax-depreciation-header': (props) => (
    <TaxDepreciationHeader
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      descriptionClassName={str(props, 'descriptionClassName') ?? ''}
      tabs={(props.tabs as ComponentProps<typeof TaxDepreciationHeader>['tabs']) ?? []}
      tabsAria={str(props, 'tabsAria') ?? ''}
    />
  ),
  /** Country names and pack sorting stay CLIENT-side (browser locale), so
   *  the loader passes raw country codes and formats nothing. */
  'tax-depreciation-overview': (props) => (
    <TaxDepreciationOverviewSlot
      overview={props.overview as ComponentProps<typeof TaxDepreciationOverviewSlot>['overview']}
    />
  ),

  /* --- tax provision detail ------------------------------------------------------ */
  //
  // Both sections are widgets (the admin-users precedent): the native page
  // hand-rolls two plain <table>s with their own classes.
  'provision-recon-section': (props) => (
    <ProvisionReconSection
      title={str(props, 'title') ?? ''}
      pretaxLabel={str(props, 'pretaxLabel') ?? ''}
      pretaxAmount={str(props, 'pretaxAmount') ?? ''}
      enactedRateText={str(props, 'enactedRateText') ?? ''}
      amountLabel={str(props, 'amountLabel') ?? ''}
      percentLabel={str(props, 'percentLabel') ?? ''}
      steps={(props.steps as ComponentProps<typeof ProvisionReconSection>['steps']) ?? []}
      summaries={(props.summaries as ComponentProps<typeof ProvisionReconSection>['summaries']) ?? []}
    />
  ),
  /** The empty note lives INSIDE the component, not as a spec-level empty
   *  state: the native empty path keeps the section chrome and puts an
   *  italic note inside it. */
  'provision-differences-section': (props) => (
    <ProvisionDifferencesSection
      title={str(props, 'title') ?? ''}
      emptyNote={str(props, 'emptyNote') ?? ''}
      columns={
        (props.columns as ComponentProps<typeof ProvisionDifferencesSection>['columns']) ?? {
          item: '',
          bookBasis: '',
          taxBasis: '',
          difference: '',
          effect: '',
        }
      }
      differences={
        (props.differences as ComponentProps<typeof ProvisionDifferencesSection>['differences']) ?? []
      }
    />
  ),
  'provision-status-badge': (props) => (
    <ProvisionStatusBadge
      label={str(props, 'label') ?? ''}
      variant={(str(props, 'variant') ?? 'secondary') as 'success' | 'secondary' | 'outline'}
    />
  ),
  'provision-framework-badge': (props) => (
    <ProvisionFrameworkBadge label={str(props, 'label') ?? ''} />
  ),
  'provision-post-button': (props) => <ProvisionPostButton runId={str(props, 'runId') ?? ''} />,

  /* --- tax ------------------------------------------------------------------- */
  /**
   * The whole tax page through one widget, and coarse by necessity: the native
   * page sits inside `PageContainer`, whose motion wrappers carry
   * `data-page-motion` attributes and post-animation inline styles a spec grid
   * (a plain div) cannot reproduce. Every unit below is a shared component the
   * page has always rendered; this only binds loader data to props. The tab
   * flags are loader-computed and applied inside `TaxTabPanels`, because a
   * `when` cannot cross a widget boundary.
   */
  'tax-page': (props) => (
    <TaxPageShell>
      <TaxPageHeader
        title={str(props, 'title') ?? ''}
        description={str(props, 'description') ?? ''}
        setupHref={str(props, 'setupHref') ?? '/admin/setup/tax-return-forms'}
        setupLabel={str(props, 'setupLabel') ?? ''}
        canManageSetup={props.canManageSetup === true}
      />
      <TaxTabs tabs={(props.tabs as ComponentProps<typeof TaxTabs>['tabs']) ?? []} />
      <TaxTabPanels
        tabKey={str(props, 'tabKey') ?? 'prepare'}
        onPrepare={props.onPrepare === true}
        onHistory={props.onHistory === true}
        prepare={
          <TaxPreparePanel
            forms={(props.forms as ComponentProps<typeof TaxPreparePanel>['forms']) ?? []}
            canSave={props.canSave === true}
            canManageSetup={props.canManageSetup === true}
          />
        }
        history={<TaxHistoryTable {...(props.history as ComponentProps<typeof TaxHistoryTable>)} />}
      />
    </TaxPageShell>
  ),
  'tax-filing-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof TaxFilingDrawer>['drawer']
    if (!drawer) return null
    return <TaxFilingDrawer drawer={drawer} />
  },

  /* --- fixed assets --------------------------------------------------------- */
  // The local tabs/equipment-link widgets are compatibility adapters for
  // stored PageSpecs; current built-ins emit ModuleHomeTabs instead.
  'assets-tabs': (props) => (
    <AssetsTabs tabs={(props.tabs as ComponentProps<typeof AssetsTabs>['tabs']) ?? []} />
  ),
  'assets-doc-link': (props) => <AssetsDocLink label={str(props, 'label') ?? ''} />,
  'assets-equipment-link': (props) => <AssetsEquipmentLink label={str(props, 'label') ?? ''} />,
  'new-asset': (props) => (
    <NewAssetButton
      currentParams={(props.currentParams as Record<string, string | string[] | undefined>) ?? {}}
    />
  ),
  'new-asset-redirect': () => <NewAssetRedirect />,
  /* createMode rides the asset-drawer widget on an in-memory payload. */
  'run-depreciation': (props) => (
    <RunDepreciationButton
      books={(props.books as ComponentProps<typeof RunDepreciationButton>['books']) ?? []}
      candidates={(props.candidates as ComponentProps<typeof RunDepreciationButton>['candidates']) ?? []}
      periods={(props.periods as ComponentProps<typeof RunDepreciationButton>['periods']) ?? []}
    />
  ),
  'asset-drawer': (props) => {
    const drawer = props.drawer as (ComponentProps<typeof AssetDrawer> & { remountKey: string }) | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <AssetDrawer key={remountKey} {...rest} />
  },
  'tax-pools': (props) => (
    <TaxPoolsView
      canRun={props.canRun === true}
      canConfigure={props.canConfigure === true}
      regimes={(props.regimes as ComponentProps<typeof TaxPoolsView>['regimes']) ?? []}
      defaultTaxYear={typeof props.defaultTaxYear === 'number' ? props.defaultTaxYear : 0}
    />
  ),
} satisfies Record<string, WidgetRenderer>
