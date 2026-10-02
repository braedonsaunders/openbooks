import {ConversationCreate} from '../../app/(app)/hrm/performance/conversations/ConversationCreate'
import {GoalEditor} from '../../app/(app)/hrm/performance/goals/GoalEditor'
import {ApplicationReview} from '../../app/(app)/hrm/recruiting/ApplicationReview'
import {ReviewTemplateDesigner} from '../../app/(app)/hrm/performance/ReviewTemplateDesigner'
import { WindowsManagerDrawer } from '../../app/(app)/hrm/benefits/WindowsManagerDrawer'
import { CandidatePoolCreateDrawer } from '../../app/(app)/hrm/recruiting/CandidatePoolCreateDrawer'
import type { ComponentProps } from 'react'
import {
  HrmBenefitsPanel,
  HrmLeavePanel,
  HrmPendingRequests,
  HrmRecentChanges,
  HrmRecruitingPanel,
  HrmUpcomingChanges,
  OnboardingPanel,
} from '../../app/(app)/hrm/sections'
import { PositionDrawer } from '../../app/(app)/hrm/positions/sections'
import { RecruitingDrawer } from '../../app/(app)/hrm/recruiting/sections'
import { ChangeRequestRowActions, HrmVerbChip } from '../../app/(app)/hrm/change-requests/ChangeRequestRowActions'
import { ChangeRequestDetailDialog } from '../../app/(app)/hrm/change-requests/ChangeRequestDetailDialog'
import { ProposeChangeDialog } from '../../app/(app)/hrm/change-requests/ProposeChangeDialog'
import { LeaveDialog } from '../../app/(app)/hrm/leave/LeaveDialog'
// HR-14 begin: qualification islands (verbatim adapters only).
import { QualificationDialog } from '../../app/(app)/hrm/qualifications/QualificationDialog'
import { QualificationRequirementManager, QualificationRequirementRemove } from '../../app/(app)/hrm/qualifications/RequirementManager'
// HR-14 end
// HR-13 begin: construction-compliance islands (verbatim adapters only).
import { ComplianceActions } from '../../app/(app)/hrm/compliance/ComplianceActions'
import { GenerateDialog } from '../../app/(app)/hrm/compliance/GenerateDialog'
// HR-13 end
import { WindowDialog } from '../../app/(app)/hrm/benefits/WindowDialog'
import { WindowDrawer } from '../../app/(app)/hrm/benefits/WindowDrawer'
import { AwardBuilderDrawer } from '../../app/(app)/hrm/benefits/AwardBuilderDrawer'
import { AwardDrawer } from '../../app/(app)/hrm/benefits/AwardDrawer'
import { BenefitTypeCards } from '../../app/(app)/hrm/benefits/BenefitsOverview'
import { AwardPortfolioTable, ProgramPortfolioTable } from '../../app/(app)/hrm/benefits/PortfolioTables'
import { ProgramBuilderDrawer } from '../../app/(app)/hrm/benefits/ProgramBuilderDrawer'
import { ProgramDrawer } from '../../app/(app)/hrm/benefits/ProgramDrawer'
import { HrmFacts } from '../../app/(app)/me/sections'
// HR-21 begin: the Explain drawer (verbatim adapter only).
import { ExplainDrawer } from '../../app/(app)/me/sections'
import { AiDraftDrawer } from '../../app/(app)/hrm/ai/AiDraftDrawer'
// HR-21 end
import {
  BenefitChangeDialog,
  BenefitElectDialog,
  GoalProgressDialog,
  ProfileDialog,
  ReviewAcknowledgeButton,
  StepCompleteButton,
} from '../../app/(app)/me/islands'
import { ProcessDrawer } from '../../app/(app)/hrm/processes/sections'
import { LeaveCalendar } from '../../app/(app)/hrm/leave/LeaveCalendar'
import { CycleDialog, CycleDrawer, ExitDrawer, ReviewDrawer } from '../../app/(app)/hrm/performance/sections'
import {
  CompCycleDialog,
  CompEquityDialog,
  CompLineDrawer,
  CompPlanDialog,
  PacingBar,
  PayInfoRequest,
  PlacementBar,
  PlacementSummary,
} from '../../app/(app)/hrm/compensation/sections'
import {
  CompensationSettingsForm,
  CycleMoveButtons,
  PlanLineApproveButton,
} from '../../app/(app)/hrm/compensation/islands'
import { LeaveBalances } from '../../app/(app)/hrm/my-leave/LeaveBalances'
import { num, str, type WidgetRenderer } from './widget-props'

/** HR workspace adapters; lifecycle permissions remain owned by the rendered components. */
export const HRM_WIDGETS = {
  'hrm-conversation-create':(props)=><ConversationCreate employees={props.employees as ComponentProps<typeof ConversationCreate>['employees']} closeHref={str(props,'closeHref')??'/hrm/performance/conversations'}/>,
  'hrm-goal-editor':(props)=><GoalEditor initial={props.initial as ComponentProps<typeof GoalEditor>['initial']} employees={props.employees as ComponentProps<typeof GoalEditor>['employees']} canWrite={props.canWrite===true} closeHref={str(props,'closeHref')??'/hrm/performance/goals'}/>,
  'hrm-application-review': (props) => <ApplicationReview selection={props.selection as ComponentProps<typeof ApplicationReview>['selection']} queue={props.queue as ComponentProps<typeof ApplicationReview>['queue']} closeHref={str(props,'closeHref')??'/hrm/recruiting'} canManage={props.canManage===true}/>,
  'hrm-pool-create': (props) => {
    const create = props.create as ComponentProps<typeof CandidatePoolCreateDrawer>['create']
    return create ? <CandidatePoolCreateDrawer create={create} /> : null
  },

  /** One row's lifecycle actions inside the shared queue table: the existing
   *  ChangeRequestActions island over loader-resolved ids, refreshing the
   *  list after every transition. Terminal rows render nothing. */
  'hrm-change-request-actions': (props) => (
    <ChangeRequestRowActions
      requestId={str(props, 'requestId') ?? ''}
      requestStatus={str(props, 'requestStatus') ?? ''}
      employmentId={str(props, 'employmentId') ?? ''}
      appliedChangeId={str(props, 'appliedChangeId') ?? null}
      departmentOptions={(props.departmentOptions as ComponentProps<typeof ChangeRequestRowActions>['departmentOptions']) ?? []}
      canManage={props.canManage === true}
      canVerb={props.canVerb === true}
    />
  ),
  /** OM-12: the request-detail drawer (?request=<id>), closing by
   *  navigating the param away. The loader-resolved subject names the
   *  request while the drawer's live fetch resolves; department options
   *  feed the embedded lifecycle actions and department display labels. */
  'hrm-change-request-dialog': (props) => (
    <ChangeRequestDetailDialog
      requestId={str(props, 'requestId') ?? null}
      closeHref={str(props, 'closeHref') ?? '/hrm/change-requests'}
      subject={(props.subject as ComponentProps<typeof ChangeRequestDetailDialog>['subject']) ?? null}
      departmentOptions={(props.departmentOptions as ComponentProps<typeof ChangeRequestDetailDialog>['departmentOptions']) ?? []}
      canManage={props.canManage === true}
      canVerb={props.canVerb === true}
    />
  ),
  /** HR-16 begin: the applied event's verb chip (0227) — renders only when
   *  the loader resolved a non-apply verb; null rows render nothing. */
  'hrm-verb-chip': (props) => <HrmVerbChip label={str(props, 'label')} />,
  // HR-16 end
  /** The propose-change dialog, opened from the page header through the
   *  `propose` search param; closing navigates the param away. */
  'hrm-propose-change-dialog': (props) => (
    <ProposeChangeDialog
      departmentOptions={(props.departmentOptions as ComponentProps<typeof ProposeChangeDialog>['departmentOptions']) ?? []}
      employmentLabel={str(props, 'employmentLabel') ?? ''}
      employmentPlaceholder={str(props, 'employmentPlaceholder') ?? ''}
      emptyLabel={str(props, 'emptyLabel') ?? ''}
      requestFailed={str(props, 'requestFailed') ?? ''}
      closeHref={str(props, 'closeHref') ?? '/hrm/change-requests'}
    />
  ),
  'hrm-pending-requests': (props) => (
    <HrmPendingRequests
      items={(props.items as ComponentProps<typeof HrmPendingRequests>['items']) ?? []}
      empty={str(props, 'empty') ?? ''}
      viewAllHref={str(props, 'viewAllHref') ?? ''}
      viewAllLabel={str(props, 'viewAllLabel') ?? ''}
      refusal={str(props, 'refusal') ?? null}
      notAvailable={str(props, 'notAvailable') ?? ''}
    />
  ),
  'hrm-recent-changes': (props) => (
    <HrmRecentChanges
      items={(props.items as ComponentProps<typeof HrmRecentChanges>['items']) ?? []}
      empty={str(props, 'empty') ?? ''}
      notAvailable={str(props, 'notAvailable') ?? ''}
    />
  ),
  'hrm-upcoming-changes': (props) => (
    <HrmUpcomingChanges
      starts={(props.starts as ComponentProps<typeof HrmUpcomingChanges>['starts']) ?? []}
      ends={(props.ends as ComponentProps<typeof HrmUpcomingChanges>['ends']) ?? []}
      startsTitle={str(props, 'startsTitle') ?? ''}
      startsEmpty={str(props, 'startsEmpty') ?? ''}
      endsTitle={str(props, 'endsTitle') ?? ''}
      endsEmpty={str(props, 'endsEmpty') ?? ''}
      notAvailable={str(props, 'notAvailable') ?? ''}
      truncated={props.truncated === true}
      truncatedNote={str(props, 'truncatedNote') ?? ''}
    />
  ),
  /** The position flyout: a URL drawer around the shared PositionDrawerBody
   *  that closes by navigation. Null payload renders nothing — the spec's
   *  `when` gate already omits it, so this is the second half of the same
   *  guard. */
  'hrm-position-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof PositionDrawer>['drawer']
    if (!drawer) return null
    return <PositionDrawer drawer={drawer} />
  },
  /** The recruiting flyout: requisition, candidate, and offer drawers plus
   *  the create form, all closing by navigation. Null payload renders
   *  nothing — the spec's `when` gate already omits it, so this is the
   *  second half of the same guard. */
  'hrm-recruiting-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof RecruitingDrawer>['drawer']
    if (!drawer) return null
    return <RecruitingDrawer drawer={drawer} />
  },
  /* --- HR-4 processes and HR-5 leave (rehomed verbatim from widgets.tsx) --- */
  /** The onboarding rail panel: loader-resolved open counts plus the overdue
   *  and upcoming steps with loader-resolved strings — the same widget-not-
   *  slot division as the headcount hero above. */
  'hrm-onboarding-panel': (props) => (
    <OnboardingPanel
      openCount={num(props, 'openCount') ?? 0}
      overdue={(props.overdue as ComponentProps<typeof OnboardingPanel>['overdue']) ?? []}
      upcoming={(props.upcoming as ComponentProps<typeof OnboardingPanel>['upcoming']) ?? []}
      openLabel={str(props, 'openLabel') ?? ''}
      overdueLabel={str(props, 'overdueLabel') ?? ''}
      upcomingLabel={str(props, 'upcomingLabel') ?? ''}
      empty={str(props, 'empty') ?? ''}
      noDueSoon={str(props, 'noDueSoon') ?? ''}
      viewAll={str(props, 'viewAll') ?? ''}
      viewAllHref={str(props, 'viewAllHref') ?? '/hrm/processes'}
    />
  ),
  /** The checklist flyout: a URL drawer around the shared client checklist
   *  body that closes by navigation. Null payload renders nothing — the
   *  spec's `when` gate already omits it, so this is the second half of the
   *  same guard. */
  'hrm-process-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof ProcessDrawer>['drawer']
    if (!drawer) return null
    return <ProcessDrawer drawer={drawer} />
  },
  /** The review-cycle flyout: the loader-resolved cycle with its reviews
   *  table and calibration island, closing by navigation. */
  'hrm-review-template-designer': props => <ReviewTemplateDesigner initial={props.initial as ComponentProps<typeof ReviewTemplateDesigner>['initial']} closeHref={String(props.closeHref)} canEdit={!!props.canEdit} competencies={(props.competencies as ComponentProps<typeof ReviewTemplateDesigner>['competencies'])??[]}/>,
  'hrm-cycle-drawer': (props) => (
    <CycleDrawer
      detail={(props.detail as ComponentProps<typeof CycleDrawer>['detail']) ?? null}
      fallbackTitle={str(props,'fallbackTitle')??''}
      missingDetail={str(props, 'missingDetail') ?? null}
      loadError={(props.loadError as ComponentProps<typeof CycleDrawer>['loadError']) ?? null}
    />
  ),
  /** The review flyout: the snapshot answers with the answer form, the
   *  goals section, and the lifecycle actions, closing by navigation. */
  'hrm-review-drawer': (props) => (
    <ReviewDrawer
      review={(props.review as ComponentProps<typeof ReviewDrawer>['review']) ?? null}
      fallbackTitle={str(props,'fallbackTitle')??''}
      missingReview={str(props, 'missingReview') ?? null}
      loadError={(props.loadError as ComponentProps<typeof ReviewDrawer>['loadError']) ?? null}
    />
  ),
  /** The cycle create dialog, opened from the page header through
   *  `?cycle=new`; closing navigates the param away. */
  'hrm-cycle-dialog': (props) => <CycleDialog create={(props.create as ComponentProps<typeof CycleDialog>['create']) ?? null} />,
  /** The Retention panel: trailing-twelve-months turnover, regrettable
   *  leavers, and the exit-record gaps, all loader-resolved. */
  /** The exit drawer (?exit=<employmentId>): HR managers record and
   *  correct through the form; retention readers see the record read-only.
   *  Null payload renders nothing — the spec's `when` gate already omits
   *  it, so this is the second half of the same guard. */
  'hrm-exit-drawer': (props) => (
    <ExitDrawer
      exit={(props.exit as ComponentProps<typeof ExitDrawer>['exit']) ?? null}
      missingExit={str(props, 'missingExit') ?? null}
      loadError={(props.loadError as ComponentProps<typeof ExitDrawer>['loadError']) ?? null}
    />
  ),
  /** Leave filing and detail entry point: the existing LeaveDrawer over a
   *  request id (detail) or null (filing), closing by navigating the search
   *  params away. */
  'hrm-leave-dialog': (props) => (
    <LeaveDialog
      requestId={str(props, 'requestId') ?? null}
      closeHref={str(props, 'closeHref') ?? '/hrm/leave'}
      canWithdrawCancel={props.canWithdrawCancel === true}
      recordOpen={props.recordOpen === true}
    />
  ),
  // HR-14 begin: qualification record/detail entry point over a
  // qualification id (detail) or the record flag (blank form), closing
  // by navigating the search params away.
  'hrm-qualification-dialog': (props) => (
    <QualificationDialog
      qualificationId={str(props, 'qualificationId') ?? null}
      recordOpen={props.recordOpen === true}
      closeHref={str(props, 'closeHref') ?? '/hrm/qualifications'}
      canManage={props.canManage === true}
    />
  ),
  'hrm-qualification-requirement-manager': (props) => (
    <QualificationRequirementManager
      today={str(props, 'today') ?? ''}
      types={(props.types as ComponentProps<typeof QualificationRequirementManager>['types']) ?? []}
      labels={(props.labels as ComponentProps<typeof QualificationRequirementManager>['labels'])}
    />
  ),
  'hrm-qualification-requirement-remove': (props) => (
    <QualificationRequirementRemove
      id={str(props, 'id') ?? ''}
      label={str(props, 'label') ?? ''}
      confirmLabel={str(props, 'confirmLabel') ?? ''}
      failedLabel={str(props, 'failedLabel') ?? ''}
      canManage={props.canManage === true}
    />
  ),
  // HR-14 end
  /** Label/value facts behind the Me profile and overview panels — the
   *  loader-resolved rows, never ids. Empty sets render the loader's empty
   *  line (a missing address is legitimate) rather than a blank panel. */
  'hrm-facts': (props) => <HrmFacts facts={(props.facts as ComponentProps<typeof HrmFacts>['facts']) ?? []} empty={str(props, 'empty')} />,
  /** The Explain drawer (?explain=<stubId>): the deterministic payslip
   *  trace as a table with diff chips. Renders nothing without one. */
  'hrm-explain-drawer': (props) => {
    const explain = (props.explain as ComponentProps<typeof ExplainDrawer>['explain']) ?? null
    if (!explain) return null
    return <ExplainDrawer explain={explain} />
  },
  /** The evidence-draft drawer (?draft=<kind>:<id>): draft text, cited
   *  sources, bias flags, Insert/Discard. Renders nothing without one. */
  'hrm-ai-draft-drawer': (props) => {
    const draft = props.draft as ComponentProps<typeof AiDraftDrawer> | null
    if (!draft?.draftParam) return null
    return <AiDraftDrawer {...draft} />
  },
  /** One checklist step's complete action inside the shared table: posts
   *  to the existing step endpoint and refreshes on success, rendering
   *  the service refusal inline. The only row-action island the Me
   *  checklists table needs. */
  'hrm-step-complete': (props) => (
    <StepCompleteButton
      stepId={str(props, 'stepId') ?? ''}
      label={str(props, 'label') ?? ''}
      failedLabel={str(props, 'failedLabel') ?? ''}
    />
  ),
  /** The profile edit drawer, opened from the page header through the
   *  `edit` search param; submit files the profile_change request. */
  'hrm-profile-dialog': (props) => (
    <ProfileDialog
      dialog={(props.dialog as ComponentProps<typeof ProfileDialog>['dialog']) ?? null}
      closeHref={str(props, 'closeHref') ?? '/me/profile'}
    />
  ),
  /** One shared review's acknowledge action inside the Me reviews table:
   *  posts to the Me acknowledge route, rendering the service refusal
   *  inline. Rows that cannot acknowledge render nothing. */
  'hrm-review-acknowledge': (props) => (
    <ReviewAcknowledgeButton
      reviewId={str(props, 'reviewId') ?? ''}
      label={str(props, 'label') ?? ''}
      canAcknowledge={props.canAcknowledge === true}
      failedLabel={str(props, 'failedLabel') ?? ''}
    />
  ),
  /** Goal progress dialog, opened from the goals table through the
   *  `goal` search param; submit posts progress with a note. */
  'hrm-goal-dialog': (props) => (
    <GoalProgressDialog
      dialog={(props.dialog as ComponentProps<typeof GoalProgressDialog>['dialog']) ?? null}
      closeHref={str(props, 'closeHref') ?? '/me/reviews'}
    />
  ),
  /** Elect-coverage dialog, opened from the benefits header through the
   *  `elect` search param; submit elects inside an open window. */
  'hrm-benefit-dialog': (props) => (
    <BenefitElectDialog
      dialog={(props.dialog as ComponentProps<typeof BenefitElectDialog>['dialog']) ?? null}
      mode={props.mode === 'manage' ? 'manage' : 'self'}
      closeHref={str(props, 'closeHref') ?? '/me/benefits'}
    />
  ),
  /** Change-coverage dialog, opened from an active election row through
   *  the `change` search param; submit changes inside an open window. */
  'hrm-benefit-change-dialog': (props) => (
    <BenefitChangeDialog
      dialog={(props.dialog as ComponentProps<typeof BenefitChangeDialog>['dialog']) ?? null}
      closeHref={str(props, 'closeHref') ?? '/me/benefits'}
    />
  ),
  /** Leave calendar: loader-resolved days with an optional department filter. */
  'hrm-leave-calendar': (props) => (
    <LeaveCalendar
      days={(props.days as ComponentProps<typeof LeaveCalendar>['days']) ?? []}
      empty={str(props, 'empty') ?? ''}
      from={str(props, 'from') ?? ''}
      to={str(props, 'to') ?? ''}
      today={str(props, 'today') ?? ''}
      scopeLabel={str(props, 'scopeLabel') ?? ''}
    />
  ),
  /** Self-service balances: TIME per leave type and VALUE per payroll
   *  bank, each labelled with its unit. Loader-resolved rows. */
  'hrm-leave-balances': (props) => (
    <LeaveBalances
      balances={(props.balances as ComponentProps<typeof LeaveBalances>['balances']) ?? []}
      timeKindLabel={str(props, 'timeKindLabel') ?? ''}
      valueKindLabel={str(props, 'valueKindLabel') ?? ''}
      unlimitedLabel={str(props, 'unlimitedLabel') ?? ''}
      empty={str(props, 'empty') ?? ''}
    />
  ),
  /** Leave panel: on leave today plus the pending-approval count beside
   *  the queue link. */
  'hrm-leave-panel': (props) => (
    <HrmLeavePanel
      items={(props.items as ComponentProps<typeof HrmLeavePanel>['items']) ?? []}
      empty={str(props, 'empty') ?? ''}
      pendingCount={typeof props.pendingCount === 'number' ? props.pendingCount : 0}
      pendingLabel={str(props, 'pendingLabel') ?? ''}
      queueHref={str(props, 'queueHref') ?? '/hrm/leave'}
      viewAllLabel={str(props, 'viewAllLabel') ?? ''}
    />
  ),
  /* --- HR-8 benefits (window dialog, drawer, and the approve island) --- */
  /** New-window dialog, opened from the page header through the
   *  `window=new` search param; closing navigates the param away. */
  'hrm-windows-manager': (props) => (
    <WindowsManagerDrawer
      rows={(props.rows as ComponentProps<typeof WindowsManagerDrawer>['rows']) ?? []}
      closeHref={str(props, 'closeHref') ?? '/hrm/benefits?view=enrolments'}
      newHref={str(props, 'newHref') ?? '/hrm/benefits?view=enrolments&window=new'}
      canManage={props.canManage === true}
    />
  ),
  'hrm-window-dialog': (props) => (
    <WindowDialog
      closeHref={str(props, 'closeHref') ?? '/hrm/benefits'}
      subsidiaryOptions={(props.subsidiaryOptions as ComponentProps<typeof WindowDialog>['subsidiaryOptions']) ?? []}
      departmentOptions={(props.departmentOptions as ComponentProps<typeof WindowDialog>['departmentOptions']) ?? []}
    />
  ),
  /** The window flyout: loader-resolved progress plus the window's
   *  enrolments. Null payload renders nothing — the spec's `when` gate
   *  already omits it, so this is the second half of the same guard. */
  'hrm-window-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof WindowDrawer>['drawer']
    if (!drawer) return null
    return (
      <WindowDrawer
        drawer={drawer}
        closeHref={str(props, 'closeHref') ?? '/hrm/benefits'}
        canManage={props.canManage === true}
      />
    )
  },
  /** Program-type cards as one panel body: insured plans resolve to the
   *  rehomed Setup drawers, employer-defined families to the builder. */
  'hrm-benefit-type-cards': (props) => (
    <BenefitTypeCards cards={(props.cards as ComponentProps<typeof BenefitTypeCards>['cards']) ?? []} closeHref={str(props, 'closeHref')} title={str(props, 'title')} />
  ),
  /** Program operational list over the prepared hrm_benefit_programs
   *  source: shared PagedTable composition with the true population in
   *  the footer. */
  'hrm-program-table': (props) => (
    <ProgramPortfolioTable
      rows={(props.rows as ComponentProps<typeof ProgramPortfolioTable>['rows']) ?? []}
      text={(props.text as ComponentProps<typeof ProgramPortfolioTable>['text']) ?? null}
      typeFilter={props.typeFilter as ComponentProps<typeof ProgramPortfolioTable>['typeFilter']}
      total={typeof props.total === 'number' ? props.total : 0}
      truncated={props.truncated === true}
    />
  ),
  /** Award operational list over the prepared hrm_benefit_awards source:
   *  shared PagedTable composition with the true population and the
   *  truncation notice in the footer. */
  'hrm-award-table': (props) => (
    <AwardPortfolioTable
      rows={(props.rows as ComponentProps<typeof AwardPortfolioTable>['rows']) ?? []}
      text={(props.text as ComponentProps<typeof AwardPortfolioTable>['text']) ?? null}
      total={typeof props.total === 'number' ? props.total : 0}
      truncated={props.truncated === true}
    />
  ),
  /** New-program builder, opened from the page header through
   *  `program=new` (cards preselect `family=`); closing navigates the
   *  params away. */
  'hrm-program-builder': (props) => (
    <ProgramBuilderDrawer
      closeHref={str(props, 'closeHref') ?? '/hrm/benefits'}
      initialFamily={
        props.initialFamily === 'allowance' || props.initialFamily === 'incentive' || props.initialFamily === 'custom'
          ? props.initialFamily
          : 'reward'
      }
      familyLocked={props.familyLocked === true}
      currencyOptions={(props.currencyOptions as ComponentProps<typeof ProgramBuilderDrawer>['currencyOptions']) ?? []}
      canConfigureApprovalPolicies={props.canConfigureApprovalPolicies === true}
      subsidiaryOptions={(props.subsidiaryOptions as ComponentProps<typeof ProgramBuilderDrawer>['subsidiaryOptions']) ?? []}
      departmentOptions={(props.departmentOptions as ComponentProps<typeof ProgramBuilderDrawer>['departmentOptions']) ?? []}
      projectOptions={(props.projectOptions as ComponentProps<typeof ProgramBuilderDrawer>['projectOptions']) ?? []}
      payComponentOptions={(props.payComponentOptions as ComponentProps<typeof ProgramBuilderDrawer>['payComponentOptions']) ?? []}
      accountOptions={(props.accountOptions as ComponentProps<typeof ProgramBuilderDrawer>['accountOptions']) ?? []}
      employmentsTruncated={props.employmentsTruncated === true}
    />
  ),
  /** Draft-program editor, opened from a program drawer through
   *  `program=<id>&edit=1`. The seed resolves from the authoritative
   *  drawer row; saving patches the program with the required reason. */
  'hrm-program-builder-edit': (props) => {
    const seed = props.editSeed as ComponentProps<typeof ProgramBuilderDrawer>['editSeed']
    if (!seed || typeof props.programId !== 'string' || props.programId === '') return null
    return (
      <ProgramBuilderDrawer
        mode="edit"
        programId={props.programId}
        editSeed={seed}
        closeHref={str(props, 'closeHref') ?? '/hrm/benefits'}
        initialFamily={seed.family}
        familyLocked
        currencyOptions={(props.currencyOptions as ComponentProps<typeof ProgramBuilderDrawer>['currencyOptions']) ?? []}
        canConfigureApprovalPolicies={props.canConfigureApprovalPolicies === true}
        subsidiaryOptions={(props.subsidiaryOptions as ComponentProps<typeof ProgramBuilderDrawer>['subsidiaryOptions']) ?? []}
        departmentOptions={(props.departmentOptions as ComponentProps<typeof ProgramBuilderDrawer>['departmentOptions']) ?? []}
        projectOptions={(props.projectOptions as ComponentProps<typeof ProgramBuilderDrawer>['projectOptions']) ?? []}
        payComponentOptions={(props.payComponentOptions as ComponentProps<typeof ProgramBuilderDrawer>['payComponentOptions']) ?? []}
        accountOptions={(props.accountOptions as ComponentProps<typeof ProgramBuilderDrawer>['accountOptions']) ?? []}
        employmentsTruncated={props.employmentsTruncated === true}
      />
    )
  },
  /** The program flyout: loader-resolved policy, memberships, and
   *  incentive source accounts. Null payload renders nothing — the spec's
   *  `when` gate already omits it, so this is the second half of the same
   *  guard. */
  'hrm-program-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof ProgramDrawer>['drawer']
    if (!drawer) return null
    return (
      <ProgramDrawer
        drawer={drawer}
        closeHref={str(props, 'closeHref') ?? '/hrm/benefits'}
        canManage={props.canManage === true}
        employmentOptions={(props.employmentOptions as ComponentProps<typeof ProgramDrawer>['employmentOptions']) ?? []}
      />
    )
  },
  /** New-award builder, opened through `award=new`; submit records one
   *  award with its reason and record reference, then opens the detail. */
  'hrm-award-builder': (props) => (
    <AwardBuilderDrawer
      closeHref={str(props, 'closeHref') ?? '/hrm/benefits'}
      programOptions={(props.programOptions as ComponentProps<typeof AwardBuilderDrawer>['programOptions']) ?? []}
      employmentOptions={(props.employmentOptions as ComponentProps<typeof AwardBuilderDrawer>['employmentOptions']) ?? []}
      defaultCurrency={str(props, 'defaultCurrency') ?? ''}
    />
  ),
  /** The award flyout: stored figures with the lifecycle moves the
   *  viewer's grants allow. Null payload renders nothing. */
  'hrm-award-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof AwardDrawer>['drawer']
    if (!drawer) return null
    return (
      <AwardDrawer
        drawer={drawer}
        closeHref={str(props, 'closeHref') ?? '/hrm/benefits'}
        canManage={props.canManage === true}
        canQueue={props.canQueue === true}
      />
    )
  },
  // HR-13 begin: construction-compliance islands. One row-action island
  // per table (findings, per-diem entries, certified runs) driven by the
  // row's own status, and the certified-generate dialog driven by the
  // `generate` search param — @openbooks/ui primitives only.
  'hrm-compliance-actions': (props) => (
    <ComplianceActions
      actionKind={(str(props, 'actionKind') as 'finding' | 'entry' | 'run') ?? 'finding'}
      rowId={str(props, 'rowId') ?? ''}
      rowStatus={str(props, 'rowStatus') ?? ''}
      entryKind={str(props, 'entryKind') ?? 'per_diem'}
      canManage={props.canManage === true}
      acknowledgeLabel={str(props, 'acknowledgeLabel') ?? ''}
      resolveLabel={str(props, 'resolveLabel') ?? ''}
      approveLabel={str(props, 'approveLabel') ?? ''}
      voidLabel={str(props, 'voidLabel') ?? ''}
      submitLabel={str(props, 'submitLabel') ?? ''}
      failedLabel={str(props, 'failedLabel') ?? ''}
    />
  ),
  'hrm-compliance-generate': (props) => (
    <GenerateDialog
      projects={(props.projects as ComponentProps<typeof GenerateDialog>['projects']) ?? []}
      formats={(props.formats as ComponentProps<typeof GenerateDialog>['formats']) ?? []}
      formatsEmpty={props.formatsEmpty === true}
      emptyMessage={str(props, 'emptyMessage') ?? ''}
      title={str(props, 'title') ?? ''}
      projectLabel={str(props, 'projectLabel') ?? ''}
      weekLabel={str(props, 'weekLabel') ?? ''}
      formatLabel={str(props, 'formatLabel') ?? ''}
      generateLabel={str(props, 'generateLabel') ?? ''}
      cancelLabel={str(props, 'cancelLabel') ?? ''}
      closeHref={str(props, 'closeHref') ?? '/hrm/compliance'}
    />
  ),
  // HR-13 end

  /** Recruiting funnel figures beside the queue link: open requisitions,
   *  offers awaiting response, interviews this week — loader-resolved.
   */
  'hrm-recruiting-panel': (props) => (
    <HrmRecruitingPanel
      figures={(props.figures as ComponentProps<typeof HrmRecruitingPanel>['figures']) ?? []}
      empty={str(props, 'empty') ?? ''}
      viewAll={str(props, 'viewAll') ?? ''}
      viewAllHref={str(props, 'viewAllHref') ?? '/hrm/recruiting'}
    />
  ),
  /** Benefits panel: open windows plus pending-approval and missing-input
   *  counts beside the queue link. */
  'hrm-benefits-panel': (props) => (
    <HrmBenefitsPanel
      openWindows={(props.openWindows as ComponentProps<typeof HrmBenefitsPanel>['openWindows']) ?? []}
      openLabel={str(props, 'openLabel') ?? ''}
      openEmpty={str(props, 'openEmpty') ?? ''}
      pendingCount={typeof props.pendingCount === 'number' ? props.pendingCount : 0}
      pendingLabel={str(props, 'pendingLabel') ?? ''}
      missingCount={typeof props.missingCount === 'number' ? props.missingCount : 0}
      missingLabel={str(props, 'missingLabel') ?? ''}
      queueHref={str(props, 'queueHref') ?? '/hrm/benefits'}
      viewAllLabel={str(props, 'viewAllLabel') ?? ''}
    />
  ),
  /* --- HR-12 compensation --- */
  /** Band placement bar: min/target/max with the payroll-side rate
   *  marker, loader-resolved edges — 'no band' renders the label. */
  'hrm-placement-bar': (props) => (
    <PlacementBar
      min={str(props, 'min') ?? null}
      target={str(props, 'target') ?? null}
      max={str(props, 'max') ?? null}
      rate={str(props, 'rate') ?? null}
      label={str(props, 'label') ?? ''}
    />
  ),
  /** Cycle budget pacing bar: computed percent with the over-budget
   *  tone, loader-resolved. */
  'hrm-pacing-bar': (props) => <PacingBar pct={num(props, 'pct') ?? null} note={str(props, 'note') ?? ''} />,
  /** The cycle line drawer: propose form, decide buttons, and the
   *  append-only event history, opened from the line's `line` param. */
  'hrm-comp-line-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof CompLineDrawer>['drawer']
    if (!drawer) return null
    return <CompLineDrawer drawer={drawer} />
  },
  /** The new-cycle dialog, opened from the page header through the
   *  `cycle` search param; closing navigates the param away. */
  'hrm-comp-cycle-dialog': (props) => {
    const dialog = props.dialog as ComponentProps<typeof CompCycleDialog>['dialog']
    if (!dialog) return null
    return <CompCycleDialog dialog={dialog} />
  },
  /** The new-plan dialog, opened from the page header through the
   *  `plan` search param. */
  'hrm-comp-plan-dialog': (props) => {
    const dialog = props.dialog as ComponentProps<typeof CompPlanDialog>['dialog']
    if (!dialog) return null
    return <CompPlanDialog dialog={dialog} />
  },
  /** The snapshot-generate dialog on the equity surface. */
  'hrm-comp-equity-dialog': (props) => {
    const dialog = props.dialog as ComponentProps<typeof CompEquityDialog>['dialog']
    if (!dialog) return null
    return <CompEquityDialog dialog={dialog} />
  },
  /** Placement summary on the Me surface: loader-resolved strings. */
  'hrm-placement-summary': (props) => (
    <PlacementSummary
      placement={str(props, 'placement') ?? ''}
      compaRatio={str(props, 'compaRatio') ?? null}
      bandRange={str(props, 'bandRange') ?? null}
    />
  ),
  /** Pay-information request action with the open request's status. */
  'hrm-pay-info-request': (props) => (
    <PayInfoRequest
      employmentId={str(props, 'employmentId') ?? ''}
      requestLabel={str(props, 'requestLabel') ?? ''}
      requestStatus={str(props, 'requestStatus') ?? null}
      failed={str(props, 'failed') ?? ''}
      submit={str(props, 'submit') ?? ''}
      cancel={str(props, 'cancel') ?? ''}
    />
  ),
  /** The merit cycle lifecycle block: open/submit/push/close/cancel over
   *  loader-resolved labels, rendered only while the loader arms it (null
   *  for readers — the POST endpoint requires hrm.compensation.manage). */
  'hrm-comp-cycle-move': (props) => {
    const move = props.move as {
      openLabel: string
      submitLabel: string
      pushLabel: string
      closeLabel: string
      cancelLabel: string
      cancelReasonLabel: string
      cancelReasonRequired: string
      failed: string
      submit: string
      cancel: string
    } | null
    const cycleId = str(props, 'cycleId')
    if (!move || !cycleId) return null
    return (
      <CycleMoveButtons
        cycleId={cycleId}
        labels={{ failed: move.failed, submit: move.submit, cancel: move.cancel }}
        openLabel={move.openLabel}
        submitLabel={move.submitLabel}
        pushLabel={move.pushLabel}
        closeLabel={move.closeLabel}
        cancelLabel={move.cancelLabel}
        cancelReasonLabel={move.cancelReasonLabel}
        cancelReasonRequired={move.cancelReasonRequired}
      />
    )
  },
  /** One headcount plan line's approve button: the island itself renders
   *  nothing unless the line is proposed; null labels (readers) render
   *  nothing. The approve endpoint owns the grant and the transition. */
  'hrm-plan-line-approve': (props) => {
    const approve = props.approve as ComponentProps<typeof PlanLineApproveButton>['labels'] & { approve: string } | null
    if (!approve) return null
    return (
      <PlanLineApproveButton
        planId={str(props, 'planId') ?? ''}
        lineId={str(props, 'lineId') ?? ''}
        lineStatus={str(props, 'lineStatus') ?? ''}
        labels={{ failed: approve.failed, submit: approve.submit, cancel: approve.cancel }}
        approveLabel={approve.approve}
      />
    )
  },
  /** The compensation settings form (gap threshold, burden rate, FTE
   *  rounding): rendered only while the loader arms it (null unless an
   *  unrestricted compensation manager). The PUT endpoint owns the grant. */
  'hrm-comp-settings': (props) => {
    const settings = props.settings as {
      initial: ComponentProps<typeof CompensationSettingsForm>['initial']
      attributeLabel: string
      thresholdLabel: string
      responseDaysLabel: string
      roundingLabel: string
      roundingOptions: ComponentProps<typeof CompensationSettingsForm>['roundingOptions']
      burdenLabel: string
      failed: string
      submit: string
      cancel: string
    } | null
    if (!settings) return null
    return (
      <CompensationSettingsForm
        labels={{ failed: settings.failed, submit: settings.submit, cancel: settings.cancel }}
        initial={settings.initial}
        attributeLabel={settings.attributeLabel}
        thresholdLabel={settings.thresholdLabel}
        responseDaysLabel={settings.responseDaysLabel}
        roundingLabel={settings.roundingLabel}
        roundingOptions={settings.roundingOptions}
        burdenLabel={settings.burdenLabel}
      />
    )
  },
} satisfies Record<string, WidgetRenderer>
