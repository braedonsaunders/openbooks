export const BENEFIT_ENROLLMENT_SUBJECT_KIND = 'hrm_benefit_enrollment' as const;
export const HRM_ENROLLMENT_STATUSES = [
  "elected",
  "waived",
  "pending_approval",
  "active",
  "ended",
  "cancelled",
] as const;

/** Native recurring Benefits configuration vocabulary; decimal values cross boundaries as text. */
export const BENEFIT_CONTRIBUTION_KINDS = ['employee_deduction', 'employer_contribution', 'taxable_non_cash', 'cash_earning'] as const;
export const BENEFIT_CONTRIBUTION_BASES = ['per_hour', 'per_period', 'per_month', 'per_year', 'percent_of_eligible_pay'] as const;
export const BENEFIT_CONTRIBUTION_RATE_FORMULAS = ['elected_rate', 'hourly_wage_percent', 'matching_election'] as const;
export const BENEFIT_CONTRIBUTION_ELECTION_MODES = ['fixed', 'follows_policy'] as const;
