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
import { ChangeRequestRowActions } from '../../app/(app)/hrm/change-requests/ChangeRequestRowActions'
import { ProposeChangeDialog } from '../../app/(app)/hrm/change-requests/ProposeChangeDialog'
import { LeaveDialog } from '../../app/(app)/hrm/leave/LeaveDialog'
import { EnrollmentRowActions } from '../../app/(app)/hrm/benefits/EnrollmentRowActions'
import { WindowDialog } from '../../app/(app)/hrm/benefits/WindowDialog'
import { WindowDrawer } from '../../app/(app)/hrm/benefits/WindowDrawer'
import { HrmFacts } from '../../app/(app)/me/sections'
import { BenefitChangeDialog, BenefitElectDialog, GoalProgressDialog, ProfileDialog, ReviewAcknowledgeButton, StepCompleteButton } from '../../app/(app)/me/islands'
import { ProcessDrawer } from '../../app/(app)/hrm/processes/sections'
import { LeaveCalendar } from '../../app/(app)/hrm/leave/LeaveCalendar'
import {
  CycleDialog,
  CycleDrawer,
  ExitDrawer,
  RetentionPanel,
  ReviewDrawer,
} from '../../app/(app)/hrm/performance/sections'
import { LeaveBalances } from '../../app/(app)/hrm/my-leave/LeaveBalances'
import { num, str, type WidgetRenderer } from './widget-props'

/** HR workspace adapters; lifecycle permissions remain owned by the rendered components. */
export const HRM_WIDGETS = {
  /** One row's lifecycle actions inside the shared queue table: the existing
   *  ChangeRequestActions island over loader-resolved ids, refreshing the
   *  list after every transition. Terminal rows render nothing. */
  'hrm-change-request-actions': (props) => (
    <ChangeRequestRowActions
      requestId={str(props, 'requestId') ?? ''}
      requestStatus={str(props, 'requestStatus') ?? ''}
      employmentId={str(props, 'employmentId') ?? ''}
      departmentOptions={(props.departmentOptions as ComponentProps<typeof ChangeRequestRowActions>['departmentOptions']) ?? []}
    />
  ),
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
  'hrm-cycle-drawer': (props) => (
    <CycleDrawer
      detail={(props.detail as ComponentProps<typeof CycleDrawer>['detail']) ?? null}
      missingDetail={str(props, 'missingDetail') ?? null}
    />
  ),
  /** The review flyout: the snapshot answers with the answer form, the
   *  goals section, and the lifecycle actions, closing by navigation. */
  'hrm-review-drawer': (props) => (
    <ReviewDrawer
      review={(props.review as ComponentProps<typeof ReviewDrawer>['review']) ?? null}
      missingReview={str(props, 'missingReview') ?? null}
    />
  ),
  /** The cycle create dialog, opened from the page header through
   *  `?cycle=new`; closing navigates the param away. */
  'hrm-cycle-dialog': (props) => (
    <CycleDialog create={(props.create as ComponentProps<typeof CycleDialog>['create']) ?? null} />
  ),
  /** The Retention panel: trailing-twelve-months turnover, regrettable
   *  leavers, and the exit-record gaps, all loader-resolved. */
  'hrm-retention-panel': (props) => (
    <RetentionPanel retention={(props.retention as ComponentProps<typeof RetentionPanel>['retention']) ?? null} />
  ),
  /** The exit drawer (?exit=<employmentId>): HR managers record and
   *  correct through the form; retention readers see the record read-only.
   *  Null payload renders nothing — the spec's `when` gate already omits
   *  it, so this is the second half of the same guard. */
  'hrm-exit-drawer': (props) => (
    <ExitDrawer
      exit={(props.exit as ComponentProps<typeof ExitDrawer>['exit']) ?? null}
      missingExit={str(props, 'missingExit') ?? null}
    />
  ),
  /** Leave filing and detail entry point: the existing LeaveDrawer over a
   *  request id (detail) or null (filing), closing by navigating the search
   *  params away. */
  'hrm-leave-dialog': (props) => (
    <LeaveDialog
      requestId={str(props, 'requestId') ?? null}
      closeHref={str(props, 'closeHref') ?? '/hrm/leave'}
    />
  ),
  /** Label/value facts behind the Me profile and overview panels — the
   *  loader-resolved rows, never ids. Empty sets render the loader's empty
   *  line (a missing address is legitimate) rather than a blank panel. */
  'hrm-facts': (props) => (
    <HrmFacts
      facts={(props.facts as ComponentProps<typeof HrmFacts>['facts']) ?? []}
      empty={str(props, 'empty')}
    />
  ),
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
  /** Department leave calendar: loader-resolved absence days grouped by
   *  date over the department/from/to search params. */
  'hrm-leave-calendar': (props) => (
    <LeaveCalendar
      basePath={str(props, 'basePath') ?? '/hrm/leave'}
      currentParams={(props.currentParams as ComponentProps<typeof LeaveCalendar>['currentParams']) ?? {}}
      departmentOptions={(props.departmentOptions as ComponentProps<typeof LeaveCalendar>['departmentOptions']) ?? []}
      departmentLabel={str(props, 'departmentLabel') ?? ''}
      fromLabel={str(props, 'fromLabel') ?? ''}
      toLabel={str(props, 'toLabel') ?? ''}
      showLabel={str(props, 'showLabel') ?? ''}
      days={(props.days as ComponentProps<typeof LeaveCalendar>['days']) ?? []}
      empty={str(props, 'empty') ?? ''}
      notAvailable={str(props, 'notAvailable') ?? ''}
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
    return <WindowDrawer drawer={drawer} closeHref={str(props, 'closeHref') ?? '/hrm/benefits'} />
  },
  /** One row's approve island inside the shared enrolments table:
   *  pending rows carry it for managers; every other status renders
   *  nothing, refreshing the list after the transition. */
  'hrm-enrollment-actions': (props) => (
    <EnrollmentRowActions
      enrollmentId={str(props, 'enrollmentId') ?? ''}
      enrollmentStatus={str(props, 'enrollmentStatus') ?? ''}
      approveLabel={str(props, 'approveLabel') ?? ''}
      canManage={props.canManage === true}
    />
  ),

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
} satisfies Record<string, WidgetRenderer>
