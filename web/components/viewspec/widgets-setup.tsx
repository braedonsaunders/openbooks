import { type ComponentProps } from 'react'
import { SetupSectionSlot } from './setup-section-slot'
import { NavEditor } from '../../app/(app)/admin/navigation/NavEditor'
import { FeaturesWorkspace } from '../../app/(app)/admin/setup/features/FeaturesWorkspace'
import { EmailSettingsForm } from '../../app/(app)/admin/email/EmailSettingsForm'
import { AiSettingsForm } from '../../app/(app)/admin/ai/AiSettingsForm'
import { AiGovernanceSection } from '../../app/(app)/admin/ai/AiGovernanceSection'
import { InvoicingSettingsWorkspace } from '../../app/(app)/admin/setup/invoicing/InvoicingSettingsWorkspace'
import { TemplatesList } from '../../app/(app)/admin/pdf-templates/TemplatesList'
import PdfTemplateEditor from '../../app/(app)/admin/pdf-templates/[id]/PdfTemplateEditor'
import FlowBuilder from '../../app/(app)/admin/flows/[id]/FlowBuilder'
import { SandboxManager } from '../../app/(app)/admin/sandboxes/SandboxManager'
import { ChangeSetDrawer } from '../../app/(app)/admin/sandboxes/change-sets/ChangeSetDrawer'
import { PaymentProvidersClient } from '../../app/(app)/admin/setup/payment-providers/PaymentProvidersClient'
import { ProjectTypesWorkspace } from '../../app/(app)/admin/setup/project-types/ProjectTypesWorkspace'
import { SecurityPageContent } from '../../app/(app)/settings/security/sections'
import { ApiConsole } from '../../app/(app)/api-docs/ApiConsole'
import { SetupWizard } from '../../app/(app)/admin/setup/wizard/SetupWizard'
import { BackupManager } from '../../app/(app)/admin/backups/BackupManager'
import { OverheadApplicationTabSlot, OverheadLifecycleTabSlot, OverheadModelBody, OverheadModelHeader, OverheadRatesTabSlot } from '../../app/(app)/admin/setup/overhead/sections'
import { AllocationsDriversTabSlot, AllocationsRuleDrawerSlot, AllocationsRulesTabSlot, AllocationsRunsTabSlot, AllocationsSetupHeader } from '../../app/(app)/admin/setup/allocations/sections'
import { SetupReadinessCheckCard, SetupReadinessHero } from '../../app/(app)/admin/setup/readiness/sections'
import { FlowNameCell, FlowLastRunCell, FlowRowActionsCell, NewFlowButton as NewFlowListButton } from '../../app/(app)/admin/flows/sections'
import { AutomationBuilder } from '../../app/(app)/admin/automations/[id]/AutomationBuilder'
import { AutomationLastRunCell, AutomationNameCell, AutomationApprovalSettingsSection, AutomationRowActionsCell, NewAutomationListButton } from '../../app/(app)/admin/automations/sections'
import { NewSetupButton } from '../../app/(app)/admin/setup/[entity]/SetupDrawer'
import { TaxReturnLibrary } from '../../app/(app)/admin/setup/[entity]/TaxReturnLibrary'
import { SetupBadgeLinkCell, SetupCloseSlot, SetupCodeCell, SetupCompanySlot, SetupDescription, SetupDrawerSlot, SetupFxSlot } from '../../app/(app)/admin/setup/[entity]/sections'
import { FormDesigner, NewFormButton } from '../../app/(app)/admin/customization/FormDesigner'
import { ListViewDesigner, NewViewButton as NewListViewButton } from '../../app/(app)/admin/customization/ListViewDesigner'
import { CustomizationTabs, FormDefaultCell, ViewScopeCell } from '../../app/(app)/admin/customization/sections'
import { BookOpen } from 'lucide-react'
import { FieldDrawer, NewFieldButton } from '../../app/(app)/admin/custom-fields/FieldDrawer'
import { LayoutDrawer } from '../../app/(app)/admin/page-layouts/LayoutDrawer'
import { CloseWizard } from '../../app/(app)/close/CloseWizard'
import { NewScriptButton, ScriptDrawer } from '../../app/(app)/admin/scripts/ScriptDrawer'
import { Button } from '@openbooks/ui'
import Link from 'next/link'
import { num, str, type WidgetRenderer } from './widget-props'

/** Admin setup and configuration adapters. Compose native components without changing their props or boundaries. */
export const SETUP_WIDGETS = {

  'new-custom-field': () => <NewFieldButton />,
  'custom-field-drawer': (props) => (
    <FieldDrawer
      def={(props.def as ComponentProps<typeof FieldDrawer>['def']) ?? null}
      hiddenKinds={(props.hiddenKinds as string[]) ?? []}
      hiddenTables={(props.hiddenTables as string[]) ?? []}
    />
  ),
  /**
   * The period-close run wizard, placed whole.
   *
   * A leaf, not a frame: it owns six stage bodies, its own navigation and its
   * own full-height shell, and decomposing eleven hundred lines of it into
   * blocks would reimplement it rather than compose it. Its page uses
   * `layout: 'bare'` so the wizard's shell is the only one.
   */
  'close-wizard': (props) => {
    const wizard = props.wizard as ComponentProps<typeof CloseWizard> | null
    if (!wizard) return null
    return <CloseWizard {...wizard} />
  },
  'page-layout-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof LayoutDrawer>['drawer'] | null
    if (!drawer) return null
    return <LayoutDrawer drawer={drawer} />
  },
  /** The "N of M routes customized" line under the list. */
  'page-layout-summary': (props) => (
    <p className="px-1 pt-2 text-xs text-slate-500 dark:text-slate-400">{str(props, 'text') ?? ''}</p>
  ),
  'new-script': () => <NewScriptButton />,
  'script-drawer': (props) => (
    <ScriptDrawer
      script={(props.script as ComponentProps<typeof ScriptDrawer>['script']) ?? null}
      runs={(props.runs as ComponentProps<typeof ScriptDrawer>['runs']) ?? []}
      customTypes={(props.customTypes as ComponentProps<typeof ScriptDrawer>['customTypes']) ?? []}
    />
  ),

  /* --- customization designer --------------------------------------------- */
  'customization-tabs': (props) => (
    <CustomizationTabs
      formsHref={str(props, 'formsHref') ?? ''}
      viewsHref={str(props, 'viewsHref') ?? ''}
      formsLabel={str(props, 'formsLabel') ?? ''}
      viewsLabel={str(props, 'viewsLabel') ?? ''}
      formsActive={props.formsActive === true}
      showForms={props.showForms !== false}
    />
  ),
  'form-default-cell': (props) => (
    <FormDefaultCell
      showDefault={props.showDefault === true}
      defaultLabel={str(props, 'defaultLabel') ?? ''}
      rolesLabel={str(props, 'rolesLabel') ?? ''}
    />
  ),
  'view-scope-cell': (props) => (
    <ViewScopeCell
      scopeLabel={str(props, 'scopeLabel') ?? ''}
      scopeVariant={str(props, 'scopeVariant') === 'default' ? 'default' : 'secondary'}
      showDefault={props.showDefault === true}
      defaultLabel={str(props, 'defaultLabel') ?? ''}
    />
  ),
  'new-form': (props) => <NewFormButton recordType={str(props, 'recordType') ?? ''} />,
  'new-view': (props) => <NewListViewButton recordType={str(props, 'recordType') ?? ''} />,
  /** Not `link-button`: that is a solid Button with no icon; this is the
   *  outline+icon treatment the designer header actually renders. */
  'docs-link-button': (props) => {
    const href = str(props, 'href')
    if (!href) return null
    return (
      <Button asChild variant="outline" size="sm">
        <Link href={href as never}>
          <BookOpen size={14} aria-hidden />
          {str(props, 'label') ?? ''}
        </Link>
      </Button>
    )
  },
  'form-drawer': (props) => (
    <FormDesigner
      // Session remount key (F-t10-002): a duplicate opened after an edit
      // must not inherit the edit's mount-only state (notably isDefault).
      key={str(props, 'drawerKey') ?? 'form-drawer'}
      recordType={str(props, 'recordType') ?? ''}
      def={(props.def as ComponentProps<typeof FormDesigner>['def']) ?? null}
      headerDefs={(props.headerDefs as ComponentProps<typeof FormDesigner>['headerDefs']) ?? null}
      lineDefs={(props.lineDefs as ComponentProps<typeof FormDesigner>['lineDefs']) ?? null}
      duplicateFrom={(props.duplicateFrom as ComponentProps<typeof FormDesigner>['duplicateFrom']) ?? null}
      subsidiaryEnabled={props.subsidiaryEnabled === true}
    />
  ),
  'list-view-drawer': (props) => (
    <ListViewDesigner
      recordType={str(props, 'recordType') ?? ''}
      def={(props.def as ComponentProps<typeof ListViewDesigner>['def']) ?? null}
      canManageOrg={props.canManageOrg === true}
      userId={str(props, 'userId') ?? ''}
      showInListDefs={(props.showInListDefs as ComponentProps<typeof ListViewDesigner>['showInListDefs']) ?? []}
      filterOptions={(props.filterOptions as ComponentProps<typeof ListViewDesigner>['filterOptions']) ?? {}}
      inventoryEnabled={props.inventoryEnabled === true}
      crmEnabled={props.crmEnabled === true}
      hrmEnabled={props.hrmEnabled === true}
    />
  ),

  /* --- admin backups ---------------------------------------------------------- */
  /** Whole: a per-field schedule form, polling effects and fetch mutations
   *  are client state and capabilities, not spec vocabulary. */
  'backup-manager': (props) => (
    <BackupManager
      policy={(props.policy as ComponentProps<typeof BackupManager>['policy']) ?? null}
      runs={(props.runs as ComponentProps<typeof BackupManager>['runs']) ?? []}
      s3Enabled={props.s3Enabled === true}
      workerOnline={props.workerOnline === true}
    />
  ),

  /* --- admin islands ---------------------------------------------------------------- */
  /** The org nav-layout editor: unsaved client state, prompt() dialogs, a
   *  four-pin mobile limit with a toast, and a PUT save. */
  'nav-editor': (props) => (
    <NavEditor
      initial={props.initial as ComponentProps<typeof NavEditor>['initial']}
      apps={(props.apps as ComponentProps<typeof NavEditor>['apps']) ?? []}
    />
  ),
  /** THREE FLAT props, no wrapper bag — the bank-feeds division. */
  'features-workspace': (props) => (
    <FeaturesWorkspace {...(props as unknown as ComponentProps<typeof FeaturesWorkspace>)} />
  ),
  /** ONE prop. The secret ciphertext never leaves the engine module; only
   *  `hasSecret` crosses into the redacted view the loader reads. */
  'email-settings-form': (props) => (
    <EmailSettingsForm initial={props.initial as ComponentProps<typeof EmailSettingsForm>['initial']} />
  ),

  /** `selectedAgentKey` uses a typeof guard rather than `str()`, because the
   *  native page passes `null` for an unrecognized key and `undefined` would
   *  not reproduce it. */
  'ai-settings-form': (props) => (
    <AiSettingsForm
      specs={props.specs as ComponentProps<typeof AiSettingsForm>['specs']}
      initial={props.initial as ComponentProps<typeof AiSettingsForm>['initial']}
    />
  ),
  /** HR-21 governance ledger: the section null-guards without the setup grant. */
  'ai-governance-ledger': (props) => (
    <AiGovernanceSection ledger={(props.ledger as ComponentProps<typeof AiGovernanceSection>['ledger']) ?? null} />
  ),
  /** SEVEN FLAT props, no wrapper bag. The page is seven conditional PAIRS
   *  (a badge plus an optional count line; a footer CTA that swaps both href
   *  and label on one flag) — presence omits, it never chooses. */
  'invoicing-setup-workspace': (props) => (
    <InvoicingSettingsWorkspace
      {...(props as unknown as ComponentProps<typeof InvoicingSettingsWorkspace>)}
    />
  ),
  /** Whole, not a `table` block: search, the type dropdown and pagination are
   *  PagedTable CLIENT state that reads no URL params, so spec table blocks
   *  would navigate where the native page never does. */
  'pdf-templates-list': (props) => (
    <TemplatesList
      templates={(props.templates as ComponentProps<typeof TemplatesList>['templates']) ?? []}
      starters={(props.starters as ComponentProps<typeof TemplatesList>['starters']) ?? []}
      recordTypes={(props.recordTypes as ComponentProps<typeof TemplatesList>['recordTypes']) ?? []}
    />
  ),

  /* --- API console ------------------------------------------------------------------ */
  /** The schema IS server data — the same plain-data prop the native page
   *  hands the component — so it travels as a literal widget prop. Nothing
   *  here is a capability or an org id, so no slot is needed. */
  'api-console': (props) => (
    <ApiConsole schema={(props.schema as ComponentProps<typeof ApiConsole>['schema']) ?? []} />
  ),

  /* --- setup wizard ----------------------------------------------------------------- */
  /** FIVE FLAT props. Ten animated steps, each owning state, mutations and
   *  framer-motion transitions. */
  'setup-wizard': (props) => (
    <SetupWizard {...(props as unknown as ComponentProps<typeof SetupWizard>)} />
  ),

  /* --- payment providers setup ------------------------------------------------------ */
  /** No props: the island fetches its own providers, bank accounts and
   *  surcharge rules and owns every form. */
  'payment-providers-workspace': () => <PaymentProvidersClient />,

  /* --- security settings ------------------------------------------------------------ */
  /** No props. Every control is client state or a fetch to /api/auth/*. */
  'security-panel': () => <SecurityPageContent />,

  /* --- project types setup ---------------------------------------------------------- */
  /** FOUR FLAT props. `incomeAccounts` is loaded but currently unread by the
   *  workspace (it destructures it away) — passed anyway, so both renders
   *  carry identical data and a future read cannot diverge them. */
  'project-types-workspace': (props) => (
    <ProjectTypesWorkspace {...(props as unknown as ComponentProps<typeof ProjectTypesWorkspace>)} />
  ),

  /* --- sandboxes -------------------------------------------------------------------- */
  /** Whole, and the per-row mutations are the reason: create / refresh /
   *  reset / delete / setSchedule / promote are BOUND SERVER ACTIONS. A spec
   *  may not carry one, so they stay inside the component wherever it renders
   *  rather than being lifted into props. */
  /** The remount key rides along as a prop: reviewing a different change set
   *  must reset the drawer's approval state. */
  'change-set-drawer': (props) => {
    const drawer = props.drawer as
      | (ComponentProps<typeof ChangeSetDrawer> & { remountKey: string })
      | null
    if (!drawer) return null
    const { remountKey, ...rest } = drawer
    return <ChangeSetDrawer key={remountKey} {...rest} />
  },
  'sandbox-manager': (props) => (
    <SandboxManager
      sandboxes={props.sandboxes as ComponentProps<typeof SandboxManager>['sandboxes']}
      periods={props.periods as ComponentProps<typeof SandboxManager>['periods']}
    />
  ),
  /** `permissions` is PERMISSION_CATALOGUE — the static list of permission
   *  KEYS the app defines, for the gate inspector's picker. A catalogue, not a
   *  grant: nothing about it is caller-specific and it confers nothing. */
  'flow-builder': (props) => (
    <FlowBuilder
      flow={props.flow as ComponentProps<typeof FlowBuilder>['flow']}
      runs={props.runs as ComponentProps<typeof FlowBuilder>['runs']}
      profile={props.profile as ComponentProps<typeof FlowBuilder>['profile']}
      users={props.users as ComponentProps<typeof FlowBuilder>['users']}
      roles={props.roles as ComponentProps<typeof FlowBuilder>['roles']}
      permissions={props.permissions as ComponentProps<typeof FlowBuilder>['permissions']}
    />
  ),
  /** The GrapesJS canvas: its own document model, drag-and-drop, the
   *  merge-field palette and every save/preview mutation. */
  'pdf-template-editor': (props) => (
    <PdfTemplateEditor
      template={props.template as ComponentProps<typeof PdfTemplateEditor>['template']}
      mergeFields={props.mergeFields as ComponentProps<typeof PdfTemplateEditor>['mergeFields']}
      collections={props.collections as ComponentProps<typeof PdfTemplateEditor>['collections']}
    />
  ),

  /* --- overhead model --------------------------------------------------------- */
  'overhead-model-header': (props) => (
    <OverheadModelHeader {...(props as ComponentProps<typeof OverheadModelHeader>)} />
  ),
  'overhead-model-body': (props) => (
    <OverheadModelBody {...(props as ComponentProps<typeof OverheadModelBody>)} />
  ),
  'overhead-rates-tab': (props) => (
    <OverheadRatesTabSlot {...(props as ComponentProps<typeof OverheadRatesTabSlot>)} />
  ),
  'overhead-lifecycle-tab': () => <OverheadLifecycleTabSlot />,
  'overhead-application-tab': () => <OverheadApplicationTabSlot />,

  /* --- allocations setup ------------------------------------------------------ */
  'allocations-setup-header': (props) => (
    <AllocationsSetupHeader {...(props as ComponentProps<typeof AllocationsSetupHeader>)} />
  ),
  'allocations-rules-tab': (props) => (
    <AllocationsRulesTabSlot {...(props as ComponentProps<typeof AllocationsRulesTabSlot>)} />
  ),
  'allocations-drivers-tab': () => <AllocationsDriversTabSlot />,
  'allocations-rule-drawer': (props) => (
    <AllocationsRuleDrawerSlot {...(props as ComponentProps<typeof AllocationsRuleDrawerSlot>)} />
  ),
  'allocations-runs-tab': () => <AllocationsRunsTabSlot />,

  /* --- setup readiness -------------------------------------------------------- */
  //
  // NOT the existing `readiness-panel`: that one renders the compliance 1099
  // queue and shares no markup with this page. Two names, two components.
  'setup-readiness-hero': (props) => (
    <SetupReadinessHero
      kicker={str(props, 'kicker') ?? ''}
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      badgeLabel={str(props, 'badgeLabel') ?? ''}
      badgeReady={props.badgeReady === true}
      progressLabel={str(props, 'progressLabel') ?? ''}
      progressOf={str(props, 'progressOf') ?? ''}
      progressPercent={num(props, 'progressPercent') ?? 0}
      progressMin={num(props, 'progressMin') ?? 0}
      progressMax={num(props, 'progressMax') ?? 0}
      progressNow={num(props, 'progressNow') ?? 0}
    />
  ),
  /** `state` is a closed complete | review | waiting vocabulary the loader
   *  resolves; the component switches icon and tile classes on it, never the
   *  spec. */
  'setup-readiness-check-card': (props) => (
    <SetupReadinessCheckCard
      indexLabel={str(props, 'indexLabel') ?? ''}
      title={str(props, 'title') ?? ''}
      description={str(props, 'description') ?? ''}
      href={str(props, 'href') ?? ''}
      action={str(props, 'action') ?? ''}
      state={
        str(props, 'state') === 'review'
          ? 'review'
          : str(props, 'state') === 'waiting'
            ? 'waiting'
            : 'complete'
      }
      stateLabel={str(props, 'stateLabel') ?? ''}
    />
  ),

  /* --- automation flows ------------------------------------------------------- */
  // HR-16 begin: the automation recipe list/builder cells (linear recipe
  // mode beside the graph-based flows builder — no new graph components).
  'new-automation': (props) => <NewAutomationListButton label={str(props, 'label') ?? ''} />,
  'automation-name-cell': (props) => (
    <AutomationNameCell name={str(props, 'name') ?? ''} href={str(props, 'href') ?? ''} />
  ),
  'automation-last-run-cell': (props) => (
    <AutomationLastRunCell at={str(props, 'at') ?? null} fallback={str(props, 'fallback') ?? ''} />
  ),
  'automation-row-actions': (props) => (
    <AutomationRowActionsCell
      id={str(props, 'id') ?? ''}
      status={str(props, 'status') ?? ''}
      runLabel={str(props, 'runLabel') ?? ''}
      enableLabel={str(props, 'enableLabel') ?? ''}
      disableLabel={str(props, 'disableLabel') ?? ''}
      actionFailed={str(props, 'actionFailed') ?? ''}
    />
  ),
  'automation-builder': (props) => (
    <AutomationBuilder
      automation={props.automation as ComponentProps<typeof AutomationBuilder>['automation']}
      runs={props.runs as ComponentProps<typeof AutomationBuilder>['runs']}
      canSimulate={props.canSimulate === true}
      canManage={props.canManage === true}
      saveFailed={str(props, 'saveFailed') ?? ''}
      backHref={str(props, 'backHref') ?? '/admin/automations'}
      backLabel={str(props, 'backLabel') ?? ''}
    />
  ),
  'automation-approval-settings': (props) => (
    <AutomationApprovalSettingsSection
      settings={(props.settings as ComponentProps<typeof AutomationApprovalSettingsSection>['settings']) ?? []}
      saveFailed={str(props, 'saveFailed') ?? ''}
      savedLabel={str(props, 'savedLabel') ?? ''}
      saveLabel={str(props, 'saveLabel') ?? ''}
      titleLabel={str(props, 'titleLabel') ?? ''}
      helpLabel={str(props, 'helpLabel') ?? ''}
      exceptionLabel={str(props, 'exceptionLabel') ?? ''}
      thresholdsLabel={str(props, 'thresholdsLabel') ?? ''}
      autoApproveLabel={str(props, 'autoApproveLabel') ?? ''}
      delegateLabel={str(props, 'delegateLabel') ?? ''}
      excludeLabel={str(props, 'excludeLabel') ?? ''}
      yesLabel={str(props, 'yesLabel') ?? ''}
      noLabel={str(props, 'noLabel') ?? ''}
    />
  ),
  // HR-16 end
  'new-flow': () => <NewFlowListButton />,
  'flow-name-cell': (props) => (
    <FlowNameCell name={str(props, 'name') ?? ''} href={str(props, 'href') ?? ''} />
  ),
  'flow-last-run-cell': (props) => (
    <FlowLastRunCell
      status={str(props, 'status') ?? null}
      variant={
        (str(props, 'variant') ?? 'outline') as ComponentProps<typeof FlowLastRunCell>['variant']
      }
      at={str(props, 'at') ?? null}
      fallback={str(props, 'fallback') ?? ''}
    />
  ),
  'flow-row-actions': (props) => (
    <FlowRowActionsCell
      id={str(props, 'id') ?? ''}
      name={str(props, 'name') ?? ''}
      enabled={props.enabled === true}
      updatedAt={str(props, 'updatedAt') ?? ''}
    />
  ),
  /** A registry-backed configuration surface re-homed onto another module's
   *  tab. The registry entry is CODE, so the spec names it by key and the slot
   *  looks it up; org id and the manage gate are re-derived from the session. */
  'setup-section': (props) => (
    <SetupSectionSlot
      entityKey={str(props, 'entityKey') ?? ''}
      sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
      basePath={str(props, 'basePath') ?? ''}
    />
  ),

  /* --- setup workspace ------------------------------------------------------ */
  /** The inline "Learn more" link (with its significant leading space) appears
   *  only when the entity declares a doc slug — a conditional pair inside one
   *  paragraph, so a component. */
  'setup-description': (props) => (
    <SetupDescription
      description={str(props, 'description') ?? ''}
      docHref={(props.docHref as string | null) ?? null}
      learnMore={str(props, 'learnMore') ?? ''}
    />
  ),
  /** A client component that pushes `?row=new` — not a link, so `link-button`
   *  cannot stand in for it. */
  'new-setup-button': (props) => (
    <NewSetupButton entityKey={str(props, 'entityKey') ?? ''} label={str(props, 'label') ?? ''} />
  ),
  'tax-return-library': (props) => (
    <TaxReturnLibrary
      packs={(props.packs as ComponentProps<typeof TaxReturnLibrary>['packs']) ?? []}
      installedCodes={(props.installedCodes as string[]) ?? []}
      open={props.open === true}
      openHref={str(props, 'openHref') ?? ''}
      closeHref={str(props, 'closeHref') ?? ''}
    />
  ),
  'setup-code-cell': (props) => (
    <SetupCodeCell
      text={str(props, 'text') ?? ''}
      shown={props.shown === true}
      href={str(props, 'href')}
    />
  ),
  'setup-badge-link-cell': (props) => (
    <SetupBadgeLinkCell
      label={str(props, 'label') ?? ''}
      variant={(str(props, 'variant') ?? 'default') as ComponentProps<typeof SetupBadgeLinkCell>['variant']}
      href={str(props, 'href') ?? ''}
    />
  ),
  /** The drawer, its nested sub-tabs and its stacked child drawers arrive
   *  through a slot that re-derives Authz; the spec carries only the entity
   *  key and the current URL. */
  'setup-drawer': (props) => (
    <SetupDrawerSlot
      entityKey={str(props, 'entityKey') ?? ''}
      sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
    />
  ),
  'setup-company': () => <SetupCompanySlot />,
  'setup-close': (props) => (
    <SetupCloseSlot
      sp={(props.sp as Record<string, string | string[] | undefined>) ?? {}}
      canReopen={props.canReopen === true}
    />
  ),
  'setup-fx': () => <SetupFxSlot />,
} satisfies Record<string, WidgetRenderer>
