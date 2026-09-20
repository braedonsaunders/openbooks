import { NativeExtension } from '../../app/(app)/apps/[key]/NativeExtension'
import { type ComponentProps } from 'react'
import { SubsidiarySwitcher } from '../subsidiary-switcher'
import { ModuleHomeTabs, LiveDirectory } from '../module-home/ui'
import { TrendChart } from '../../app/(app)/analytics/_ui/charts'
import { ApPulse, AttentionList, CommitmentsSection, DirectorySection } from '../../app/(app)/purchasing/sections'
import { ViewNameCell, ViewActionsCell } from '../../app/(app)/knowledge/views/sections'
import { NewViewButton } from '../../app/(app)/knowledge/views/NewViewButton'
import { ViewStudio } from '../../app/(app)/knowledge/views/ViewStudio'
import { DashboardNameCell } from '../../app/(app)/insights/dashboards/sections'
import { NewDashboardButton } from '../../app/(app)/insights/dashboards/NewDashboardButton'
import { InsightsTabs } from '../../app/(app)/insights/InsightsTabs'
import { CardNameCell, VizCell } from '../../app/(app)/insights/sections'
import { NewCardButton } from '../../app/(app)/insights/NewCardButton'
import { CardStudio } from '../../app/(app)/insights/CardStudio'
import { NewTypeButton } from '../../app/(app)/records/types/NewTypeButton'
import { HrmHeadcountTable } from '../../app/(app)/hrm/sections'
import { QueryConsole } from '../../app/(app)/query/sections'
import { HealthHero } from '../../app/(app)/accounting/sections'
import { BuildHubCard } from '../../app/(app)/admin/build/sections'
import { Library } from 'lucide-react'
import { DocsHome } from '../../app/(app)/docs/sections'
import { DocArticleView } from '../../app/(app)/docs/[slug]/sections'
import { LibraryEmptyIcon, ListingCard } from '../../app/(app)/apps/library/sections'
import { DashboardHeader } from '../../app/(app)/dashboard/_dashboard-header'
import { DashboardGridSlot } from './dashboard-grid-slot'
import { DashboardEditSlot } from './dashboard-edit-slot'
import { CustomizeDashboardHeader } from '../../app/(app)/dashboard/customize/sections'
import { PlatformClient } from '../../app/(app)/sync/PlatformClient'
import { AppNotice, AppRuntimeChrome } from '../../app/(app)/apps/[key]/sections'
import { DashboardBuilder } from '../../app/(app)/insights/dashboards/[id]/DashboardBuilder'
import { PlatformNotice, PlatformTile } from '../../app/(app)/platform/sections'
import { AppLauncherCard, AppsEmptyIcon, AppsLauncherButton } from '../../app/(app)/apps/sections'
import { AppKeyCell } from '../../app/(app)/admin/apps/sections'
import { Button } from '@openbooks/ui'
import Link from 'next/link'
import { str, num, type WidgetRenderer } from './widget-props'

/** Home, discovery and presentation adapters: module home, hubs, dashboards, apps and docs. Compose native components without changing their props or boundaries. */
export const HOME_WIDGETS = {

  'subsidiary-switcher': (props) => (
    <SubsidiarySwitcher
      picker={props.picker as ComponentProps<typeof SubsidiarySwitcher>['picker']}
      value={str(props, 'value') ?? ''}
      label={str(props, 'label') ?? ''}
    />
  ),

  'module-home-tabs': (props) => (
    <ModuleHomeTabs tabs={props.tabs as ComponentProps<typeof ModuleHomeTabs>['tabs']} />
  ),

  'commitments-section': (props) => (
    <CommitmentsSection
      rows={props.rows as ComponentProps<typeof CommitmentsSection>['rows']}
      showPurchaseOrders={props.showPurchaseOrders === true}
      empty={str(props, 'empty') ?? ''}
    />
  ),

  'ap-pulse': (props) => (
    <ApPulse
      outstanding={str(props, 'outstanding') ?? ''}
      overdue={str(props, 'overdue') ?? ''}
      dueNext7={str(props, 'dueNext7') ?? ''}
      overdueIsNegative={props.overdueIsNegative === true}
      labels={props.labels as ComponentProps<typeof ApPulse>['labels']}
      href={str(props, 'href') ?? ''}
    />
  ),

  'trend-chart': (props) => (
    <TrendChart
      labels={props.labels as ComponentProps<typeof TrendChart>['labels']}
      series={props.series as ComponentProps<typeof TrendChart>['series']}
      height={typeof props.height === 'number' ? props.height : undefined}
      area={props.area === true}
      maxTicks={typeof props.maxTicks === 'number' ? props.maxTicks : undefined}
    />
  ),

  'directory-section': (props) => (
    <DirectorySection
      items={props.items as ComponentProps<typeof DirectorySection>['items']}
      title={str(props, 'title') ?? ''}
    />
  ),

  'attention-list': (props) => (
    <AttentionList
      items={props.items as ComponentProps<typeof AttentionList>['items']}
      allClear={str(props, 'allClear') ?? ''}
    />
  ),

  'live-directory': (props) => (
    <LiveDirectory items={props.items as ComponentProps<typeof LiveDirectory>['items']} />
  ),

  'insights-tabs': (props) => (
    <InsightsTabs active={(str(props, 'active') ?? '') as ComponentProps<typeof InsightsTabs>['active']} />
  ),
  /** A pill that renders nothing when the label is empty. The table's
   *  `badge` cell always emits its wrapper, so optional flags bind through
   *  here instead of leaving an empty pill behind. */

  'new-dashboard': () => <NewDashboardButton />,

  'new-card': () => <NewCardButton />,

  'new-record-type': () => <NewTypeButton />,

  'query-console': () => <QueryConsole />,

  /* --- accounting cockpit ---------------------------------------------------- */

  'health-hero': (props) => (
    <HealthHero
      gaugeValue={typeof props.gaugeValue === 'number' ? props.gaugeValue : 0}
      gaugeLabel={str(props, 'gaugeLabel') ?? ''}
      categories={props.categories as ComponentProps<typeof HealthHero>['categories']}
      ratios={props.ratios as ComponentProps<typeof HealthHero>['ratios']}
      ratioLabels={props.ratioLabels as ComponentProps<typeof HealthHero>['ratioLabels']}
      fullAnalysisLabel={str(props, 'fullAnalysisLabel') ?? ''}
    />
  ),
  /** A widget, not a slot: the loader already resolved headcount through the
   *  canonical read service and passes rows plus loader-resolved strings as
   *  data, so no org id, user id or Authz crosses the spec. */

  'hrm-headcount-table': (props) => (
    <HrmHeadcountTable
      groups={(props.groups as ComponentProps<typeof HrmHeadcountTable>['groups']) ?? []}
      total={num(props, 'total') ?? 0}
      employerColumn={str(props, 'employerColumn') ?? ''}
      departmentColumn={str(props, 'departmentColumn') ?? ''}
      headcountColumn={str(props, 'headcountColumn') ?? ''}
      unassigned={str(props, 'unassigned') ?? ''}
      empty={str(props, 'empty') ?? ''}
      totalLabel={str(props, 'totalLabel') ?? ''}
    />
  ),

  /** The build hub's card. NOT `admin-hub-card`: the shells match but the icon
   *  maps are disjoint and the fallbacks differ, so each hub keeps its own. */

  'build-hub-card': (props) => (
    <BuildHubCard
      href={str(props, 'href') ?? '#'}
      iconKey={str(props, 'iconKey') ?? ''}
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      accent={
        (['teal', 'violet', 'amber', 'sky'] as const).find((a) => a === str(props, 'accent')) ??
        'teal'
      }
    />
  ),

  'app-launcher-card': (props) => (
    <AppLauncherCard
      href={str(props, 'href') ?? ''}
      ariaLabel={str(props, 'ariaLabel') ?? ''}
      iconKey={str(props, 'iconKey') ?? ''}
      name={str(props, 'name') ?? ''}
      versionLine={str(props, 'versionLine') ?? ''}
      description={str(props, 'description') ?? ''}
      openLabel={str(props, 'openLabel') ?? ''}
    />
  ),

  'apps-empty-icon': () => <AppsEmptyIcon />,
  /** One parametric entry for three button shapes this page renders; none of
   *  the existing link buttons match any of them. */

  'apps-launcher-button': (props) => (
    <AppsLauncherButton
      href={str(props, 'href') ?? ''}
      label={str(props, 'label') ?? ''}
      icon={str(props, 'icon') === 'book' ? 'book' : 'library'}
      variant={str(props, 'variant') === 'outline' ? 'outline' : undefined}
      size={str(props, 'size') === 'sm' ? 'sm' : undefined}
      className={str(props, 'className')}
    />
  ),

  'platform-notice': () => <PlatformNotice />,
  /** Flat props, every value a string — not a single `tile` object. The icon
   *  is an `iconKey` lookup resolved here so the spec carries only data. */

  'platform-tile': (props) => (
    <PlatformTile
      href={str(props, 'href') ?? '#'}
      iconKey={
        (['building-2', 'users', 'key-round', 'mail'] as const).find(
          (k) => k === str(props, 'iconKey'),
        ) ?? 'building-2'
      }
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      stat={str(props, 'stat') ?? ''}
      detail={str(props, 'detail') ?? ''}
    />
  ),

  /* --- docs article ----------------------------------------------------------- */
  /** Conditional pairs throughout (category span, related block, prev/next
   *  with a bare-span placeholder) plus a client Markdown renderer. */

  'doc-article': (props) => (
    <DocArticleView content={props.content as ComponentProps<typeof DocArticleView>['content']} />
  ),

  'sync-console': () => <PlatformClient />,

  'app-notice': (props) => (
    <AppNotice
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      backHref={str(props, 'backHref') ?? '/apps'}
      backLabel={str(props, 'backLabel') ?? ''}
    />
  ),
  /** `context` is plain data — app id/key/name plus the caller's id, name and
   *  role KEYS — not an `Authz`. The sandbox that consumes it lives inside
   *  `AppFrame`. */

  'native-extension': props => <NativeExtension appKey={str(props, 'appKey') ?? ''} searchParams={(props.sp as Record<string, string | string[] | undefined>) ?? {}} />,

  'app-runtime-chrome': (props) => (
    <AppRuntimeChrome
      appKey={str(props, 'appKey') ?? ''}
      appName={str(props, 'appName') ?? ''}
      appsHref={str(props, 'appsHref') ?? '/apps'}
      appsLabel={str(props, 'appsLabel') ?? ''}
      context={props.context as ComponentProps<typeof AppRuntimeChrome>['context']}
    />
  ),

  'insights-dashboard-builder': (props) => (
    <DashboardBuilder
      dashboard={props.dashboard as ComponentProps<typeof DashboardBuilder>['dashboard']}
      cards={props.cards as ComponentProps<typeof DashboardBuilder>['cards']}
      availableCards={props.availableCards as ComponentProps<typeof DashboardBuilder>['availableCards']}
      pinned={props.pinned === true}
      canCreate={props.canCreate === true}
      canPublish={props.canPublish === true}
    />
  ),

  /* --- API console ------------------------------------------------------------------ */
  /** The schema IS server data — the same plain-data prop the native page
   *  hands the component — so it travels as a literal widget prop. Nothing
   *  here is a capability or an org id, so no slot is needed. */

  'dashboard-header': (props) => <DashboardHeader greeting={str(props, 'greeting') ?? ''} name={str(props, 'name') ?? null} />,
  /** A SLOT, not a props widget. `DashboardGrid` needs rendered tile nodes
   *  and a bound `saveQuickActions` server action — component references and
   *  a capability, neither of which a spec may carry. The slot re-derives
   *  both from the session; the spec names the block and nothing else. */

  'dashboard-grid': () => <DashboardGridSlot />,
  /** Not `pageHeader({ back })`: that slot renders UiBackLink, and this page's
   *  back link is a 12px lucide ArrowLeft with different classes again. */

  'dashboard-customize-header': (props) => (
    <CustomizeDashboardHeader
      backHref={str(props, 'backHref') ?? '/dashboard'}
      backLabel={str(props, 'backLabel') ?? ''}
      title={str(props, 'title') ?? ''}
      roleLabel={str(props, 'roleLabel') ?? ''}
    />
  ),
  /** The edit canvas, also a SLOT — and more emphatically than the view one:
   *  besides the tile nodes and the bound save action it needs
   *  `allowedWidgetIds`, a per-caller PERMISSION decision. That must not be
   *  reachable from a spec. */

  'dashboard-edit': () => <DashboardEditSlot />,

  /* --- assistant -------------------------------------------------------------------- */
  /** Whole: sidebar, streaming thread, composer and every fetch. Serves both
   *  /assistant and /assistant/[id]: `activeId` and `initialMessages` default
   *  to the new-conversation values the launcher route passes natively, and
   *  the deep-link route binds real ones. Hardcoding them here would have made
   *  this entry a single route's assumption wearing a general name. */

  'listing-card': (props) => (
    <ListingCard
      listingId={str(props, 'listingId') ?? ''}
      listingKey={str(props, 'listingKey') ?? ''}
      name={str(props, 'name') ?? ''}
      versionLine={str(props, 'versionLine') ?? ''}
      description={str(props, 'description') ?? ''}
      installed={props.installed === true}
      current={props.current === true}
      canInstall={props.canInstall === undefined || Boolean(props.canInstall)}
    />
  ),
  /** NOT `apps-empty-icon` — that one renders Boxes; this renders Library. */

  'library-empty-icon': () => <LibraryEmptyIcon />,

  'docs-home': (props) => (
    <DocsHome content={props.content as ComponentProps<typeof DocsHome>['content']} />
  ),

  'apps-library-button': (props) => {
    const href = str(props, 'href')
    if (!href) return null
    return (
      <Button asChild variant="outline">
        <Link href={href as never}>
          <Library size={15} /> {str(props, 'label') ?? ''}
        </Link>
      </Button>
    )
  },

  'app-key-cell': (props) => <AppKeyCell appKey={str(props, 'appKey') ?? ''} />,
  /** The whole app flyout stays one widget: its body is three tabs of per-row
   *  client state (dirty flags, selected file, open dirs) — a workspace, not a
   *  spec. */


  /* --- AP capture ------------------------------------------------------------ */
  /** Diffed against `plain-link-button` (Link outside Button, no icon) and
   *  `docs-link-button` (small, 14px icon, no space): neither renders this
   *  shape, so it keeps its own entry. */

  'card-name-cell': (props) => (
    <CardNameCell
      name={str(props, 'name') ?? ''}
      href={str(props, 'href') ?? ''}
      description={(props.description as string | null) ?? null}
    />
  ),

  'viz-cell': (props) => (
    <VizCell vizType={str(props, 'vizType') ?? ''} label={str(props, 'label') ?? ''} />
  ),

  'card-studio': (props) => {
    const studio = props.studio as ComponentProps<typeof CardStudio> | null
    if (!studio) return null
    return <CardStudio {...studio} />
  },

  'dashboard-name-cell': (props) => (
    <DashboardNameCell
      name={str(props, 'name') ?? ''}
      href={str(props, 'href') ?? ''}
      description={(props.description as string | null) ?? null}
    />
  ),

  'new-saved-view': () => <NewViewButton />,

  'view-name-cell': (props) => (
    <ViewNameCell
      name={str(props, 'name') ?? ''}
      href={str(props, 'href') ?? ''}
      description={(props.description as string | null) ?? null}
    />
  ),

  'view-actions-cell': (props) => (
    <ViewActionsCell
      runHref={str(props, 'runHref') ?? ''}
      runLabel={str(props, 'runLabel') ?? ''}
      editHref={str(props, 'editHref') ?? ''}
      editLabel={str(props, 'editLabel') ?? ''}
      canEdit={props.canEdit === true}
    />
  ),

  'view-studio': (props) => {
    const studio = props.studio as ComponentProps<typeof ViewStudio> | null
    if (!studio) return null
    return <ViewStudio {...studio} />
  },
} satisfies Record<string, WidgetRenderer>
