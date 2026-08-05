type FeatureState = Record<string, boolean>

export const TEAM_SIZES = ['solo', 'small', 'medium', 'large'] as const
export type TeamSize = (typeof TEAM_SIZES)[number]

export const COMPLEXITY_LEVELS = ['essentials', 'growing', 'advanced'] as const
export type ComplexityLevel = (typeof COMPLEXITY_LEVELS)[number]

export const BOOK_STARTS = ['fresh', 'migrate'] as const
export type BookStart = (typeof BOOK_STARTS)[number]

export const TAX_POSITIONS = ['registered', 'not_registered', 'unsure'] as const
export type TaxPosition = (typeof TAX_POSITIONS)[number]

export const MONTHLY_ACTIVITY_LEVELS = ['light', 'steady', 'high'] as const
export type MonthlyActivityLevel = (typeof MONTHLY_ACTIVITY_LEVELS)[number]

export const CLOSE_CADENCES = ['monthly', 'quarterly', 'annual'] as const
export type CloseCadence = (typeof CLOSE_CADENCES)[number]

export interface WorkspaceProfile {
  teamSize: TeamSize
  complexity: ComplexityLevel
  bookStart: BookStart
  taxPosition: TaxPosition
  monthlyActivity: MonthlyActivityLevel
  closeCadence: CloseCadence
}

const CORE_FEATURES = ['banking', 'expenses', 'apps'] as const
const ESSENTIAL_OPERATION_FEATURES = [
  'projects',
  'timeTracking',
  'inventory',
  'equipment',
  'subscriptionBilling',
] as const

/**
 * Turn an onboarding profile into an explicit, reviewable starting point.
 * This is recommendation logic only: the resulting booleans are persisted
 * through the authoritative Company Settings → Features model, where every
 * choice remains individually adjustable.
 */
export function recommendWorkspaceFeatures(args: {
  featureKeys: string[]
  industryFeatures?: Record<string, boolean>
  profile: WorkspaceProfile
}): FeatureState {
  const state: FeatureState = Object.fromEntries(args.featureKeys.map((key) => [key, false]))
  for (const key of CORE_FEATURES) state[key] = true

  const industry = args.industryFeatures ?? {}
  for (const key of ESSENTIAL_OPERATION_FEATURES) {
    if (typeof industry[key] === 'boolean') state[key] = industry[key]
  }

  if (args.profile.complexity !== 'essentials') {
    for (const [key, enabled] of Object.entries(industry)) {
      if (key in state) state[key] = enabled
    }
    state.budgets = true
    state.fixedAssets = industry.fixedAssets ?? false
    state.flows = args.profile.teamSize !== 'solo'
    state.crm = industry.crm ?? false
    state.orders = industry.orders ?? false
    state.revenueRecognition = industry.revenueRecognition ?? false
  }

  if (args.profile.complexity === 'advanced') {
    state.budgets = true
    state.continuousClose = true
    state.flows = true
    state.advancedClose = args.profile.teamSize !== 'solo'
  }

  // Activity and close rhythm are observable operating facts. They tune the
  // automation layer without pretending that transaction volume is itself an
  // accounting-sophistication score. The user still reviews and can override
  // both switches later in this walkthrough or on the Features switchboard.
  if (args.profile.monthlyActivity === 'high') state.bankFeeds = true
  if (
    args.profile.closeCadence === 'monthly'
    && (args.profile.monthlyActivity !== 'light' || args.profile.complexity === 'advanced')
  ) {
    state.continuousClose = true
  }

  // Entity and currency complexity must be an explicit operational answer;
  // never infer either merely because a company is larger.
  state.multiSubsidiary = false
  state.multiCurrency = false

  if (!state.projects) {
    state.fieldTickets = false
    state.projectScheduling = false
    state.timeTracking = false
    state.subcontracts = false
    state.wipBilling = false
  }
  if (!state.subscriptionBilling) state.advancedSubscriptions = false
  if (!state.flows) state.advancedClose = false
  return state
}

export function isTeamSize(value: unknown): value is TeamSize {
  return typeof value === 'string' && TEAM_SIZES.includes(value as TeamSize)
}

export function isComplexityLevel(value: unknown): value is ComplexityLevel {
  return typeof value === 'string' && COMPLEXITY_LEVELS.includes(value as ComplexityLevel)
}

export function isBookStart(value: unknown): value is BookStart {
  return typeof value === 'string' && BOOK_STARTS.includes(value as BookStart)
}

export function isTaxPosition(value: unknown): value is TaxPosition {
  return typeof value === 'string' && TAX_POSITIONS.includes(value as TaxPosition)
}

export function isMonthlyActivityLevel(value: unknown): value is MonthlyActivityLevel {
  return typeof value === 'string' && MONTHLY_ACTIVITY_LEVELS.includes(value as MonthlyActivityLevel)
}

export function isCloseCadence(value: unknown): value is CloseCadence {
  return typeof value === 'string' && CLOSE_CADENCES.includes(value as CloseCadence)
}
