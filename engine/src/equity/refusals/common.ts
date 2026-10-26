/** Refusals shared by every equity path: the feature, authority, legal entities, currencies, inputs, the ledger and periods. */
export const COMMON_REFUSALS = {
  featureOff: {
    code: "equity_feature_off",
    status: 403,
    message: "Equity & cap table is not enabled for this organization.",
    remedy: "Turn on Equity & cap table in Company Settings → Features.",
  },
  forbidden: {
    code: "equity_forbidden",
    status: 403,
    message: "This action requires the {permission} permission.",
    remedy:
      "Ask an administrator to grant {permission} (Company Settings → Roles), then try again.",
    params: { permission: "text" },
  },
  forbiddenForEntity: {
    code: "equity_forbidden",
    status: 403,
    message: "This action requires the {permission} permission for the legal entity.",
    remedy:
      "Ask an administrator to grant {permission} and access to the legal entity (Company Settings → Roles), then try again.",
    params: { permission: "text" },
  },
  entityOutsideAccess: {
    code: "equity_entity_unknown",
    status: 404,
    message: "The legal entity does not exist or is outside your access.",
    remedy: "Choose a legal entity you can access.",
  },
  entityInvalid: {
    code: "equity_entity_unknown",
    status: 404,
    message: "Choose a valid legal entity.",
    remedy: "Choose a legal entity of this organization.",
  },
  entityInactive: {
    code: "equity_entity_unknown",
    status: 404,
    message: "The legal entity does not exist or is inactive.",
    remedy: "Choose an active legal entity of this organization.",
  },
  entityCurrencyMissing: {
    code: "equity_entity_currency_missing",
    message: "Legal entity {entity} has no functional currency.",
    remedy: "Set the legal entity's base currency in Company Settings → Subsidiaries.",
    params: { entity: "text" },
  },
  currencyUnknown: {
    code: "equity_currency_unknown",
    message: "Currency {currency} has no supported precision in the currency registry.",
    remedy: "Restore {currency} in the currency registry (Company Settings → Currencies).",
    params: { currency: "text" },
  },
  currencyPrecisionUnsupported: {
    code: "equity_currency_unknown",
    message: "The currency precision is not supported.",
    remedy: "Restore the currency in Company Settings → Currencies.",
  },
  currencyCodeInvalid: {
    code: "equity_currency_unknown",
    message: "Choose the currency the record is stated in.",
    remedy: "Enter a three-letter ISO currency code.",
  },
  classUnknown: {
    code: "equity_class_unknown",
    status: 404,
    message: "The share class does not exist for this legal entity.",
    remedy: "Choose a share class of the legal entity.",
  },
  classReferenceUnknown: {
    code: "equity_class_unknown",
    status: 404,
    message: "A security references a share class that does not exist.",
    remedy: "Reload the cap table.",
  },
  planUnknown: {
    code: "equity_plan_unknown",
    status: 404,
    message: "The plan does not exist for this legal entity.",
    remedy: "Choose a plan of the legal entity.",
  },
  roundUnknown: {
    code: "equity_round_unknown",
    status: 404,
    message: "The round does not exist for this legal entity.",
    remedy: "Choose a round of the legal entity.",
  },
  securityUnknown: {
    code: "equity_security_unknown",
    status: 404,
    message: "The security does not exist.",
    remedy: "Choose a security.",
  },
  safeUnknown: {
    code: "equity_security_unknown",
    status: 404,
    message: "The SAFE does not exist.",
    remedy: "Choose a SAFE.",
  },
  holderInvalid: {
    code: "equity_holder_unknown",
    status: 404,
    message: "Choose a valid holder.",
    remedy: "Choose a person or company from the directory.",
  },
  holderInactive: {
    code: "equity_holder_unknown",
    status: 404,
    message: "The holder must be an active person or company of this organization.",
    remedy: "Choose an active person or company, or reactivate it in the directory.",
  },
  idempotencyConflict: {
    code: "equity_idempotency_conflict",
    status: 409,
    message:
      "This request key was already used for a different {subject, select, round {round change} reversal {reversal} issuance {issuance} event {event} action {equity action} election {election} other {request}}.",
    remedy: "Retry with a new request key.",
    params: { subject: "choice" },
  },
  auditUnwritten: {
    code: "equity_audit_unwritten",
    status: 409,
    message: "The audit record was not written; the change was not saved.",
    remedy: "Try the change again.",
  },
  reasonRequired: {
    code: "equity_reason_required",
    message:
      "Record a reason of {min} to {max} characters for {subject, select, classAmendment {the class amendment} split {the split} reserveChange {the reserve change} mfnElection {the MFN election} mfnReversal {the MFN election reversal} roundAmendment {the round amendment} roundVoid {the round void} accountPolicy {the account policy version} forfeit {the forfeiture} expire {the expiry} cancel {the cancellation} repurchase {the repurchase} void {the void} reverse {the reversal} withdrawal {withdrawing the action} other {the change}}.",
    remedy: "Describe why (for example, the board resolution that approved it), then submit again.",
    params: { subject: "choice", min: "count", max: "count" },
  },
  preMoneyBasisTooShort: {
    code: "equity_reason_required",
    message: "State the basis of the pre-money valuation in {min} to {max} characters.",
    remedy:
      "Describe the basis under “{field}” (for example, a pool increase or conversions counted in the valuation), or leave it blank.",
    params: { field: "term", min: "count", max: "count" },
  },
  fxRateMissing: {
    code: "equity_fx_rate_missing",
    message: "No {from} to {to} exchange rate is recorded on or before {date}.",
    remedy: "Record the {from}/{to} spot rate for {date} (Setup → Exchange Rates), then try again.",
    params: { from: "text", to: "text", date: "date" },
  },
  fxRateUnresolved: {
    code: "equity_fx_rate_missing",
    message:
      "No {from} to {to} exchange rate was resolved for {subject, select, conversion {the conversion} model {the model} other {the calculation}}.",
    remedy: "Record the {from}/{to} spot rate for {date} (Setup → Exchange Rates), then try again.",
    params: { from: "text", to: "text", date: "date", subject: "choice" },
  },
  decimalInvalid: {
    code: "equity_decimal_invalid",
    message: "“{label}” must be a plain decimal number.",
    remedy: "Enter “{label}” as digits with an optional decimal point, such as {example}.",
    params: { label: "term", example: "decimal" },
  },
  decimalPrecision: {
    code: "equity_decimal_precision",
    message:
      "“{label}” carries more than {places} decimal {placesCount, plural, one {place} other {places}}.",
    remedy:
      "Enter “{label}” with at most {places} decimal {placesCount, plural, one {place} other {places}}.",
    params: { label: "term", places: "count" },
  },
  valueMissing: {
    code: "equity_value_missing",
    message: "“{label}” is required.",
    remedy: "Record “{label}” before continuing.",
    params: { label: "term" },
  },
  sharesInvalid: {
    code: "equity_shares_invalid",
    message: "“{label}” must be a whole number of shares.",
    remedy: "Enter “{label}” as a whole number of shares.",
    params: { label: "term" },
  },
  dateInvalid: {
    code: "equity_date_invalid",
    message: "“{label}” must be a valid date.",
    remedy: "Choose a date for “{label}”.",
    params: { label: "term" },
  },
  textInvalid: {
    code: "equity_text_invalid",
    message: "“{label}” is required, in at most {max} characters.",
    remedy: "Enter “{label}”.",
    params: { label: "term", max: "count" },
  },
  accountPolicyIncomplete: {
    code: "equity_account_policy_incomplete",
    message: "The equity account policy in force from {date} does not map “{account}”.",
    remedy:
      "Add an equity account policy version that maps “{account}”, effective on or before the transaction date (Setup → Equity accounts).",
    params: { date: "date", account: "term" },
  },
  accountPolicyMissing: {
    code: "equity_account_policy_missing",
    message: "No equity account policy is in force for this legal entity on {date}.",
    remedy:
      "Add an equity account policy for the legal entity, effective on or before the transaction date (Setup → Equity accounts).",
    params: { date: "date" },
  },
  fxAccountMissing: {
    code: "equity_fx_account_missing",
    message: "The realized FX gain/loss account is not configured.",
    remedy:
      "Map the realized FX gain/loss account in Setup → Company & Accounting → Control accounts, then try again.",
  },
  considerationAccountMissing: {
    code: "equity_consideration_account_missing",
    message: "Choose the account the consideration settles through.",
    remedy: "Choose the cash or bank account that received or paid the cash under “{field}”.",
    params: { field: "term" },
  },
  considerationAccountInvalid: {
    code: "equity_consideration_account_invalid",
    message: "The consideration account must be an active cash or bank posting account.",
    remedy:
      "Choose an active cash or bank account under “{field}”; receivables, prepaid, inventory and allowance accounts cannot receive or pay the cash.",
    params: { field: "term" },
  },
  postingRefused: {
    code: "equity_posting_refused",
    message: "The ledger refused the equity entry dated {date} ({reason}).",
    remedy:
      "Resolve the ledger refusal (for example, reopen the period through Period Close or reactivate the account), then try again.",
    params: { date: "date", reason: "text" },
  },
  postingPeriodClosed: {
    code: "equity_posting_refused",
    message: "The equity entry dated {date} falls in {period}, which is closed for posting.",
    remedy:
      "Request a controlled reopen of {closing} through Period Close, or record the transaction on a date in an open period.",
    params: { date: "date", period: "period", closing: "period" },
  },
  bookMissing: {
    code: "equity_book_missing",
    message: "The organization has no active primary book that posts to the general ledger.",
    remedy: "Activate the primary accounting book in Company Settings → Accounting books.",
  },
  periodMissing: {
    code: "equity_period_missing",
    message: "No accounting period covers {date}.",
    remedy:
      "Generate the accounting periods of the fiscal year that covers {date} (Setup → Period Close → Accounting periods), then try again.",
    params: { date: "date" },
  },
  entryUnbalanced: {
    code: "equity_entry_unbalanced",
    status: 409,
    message: "The equity entry dated {date} does not balance.",
    remedy: "Review the amounts and try again.",
    params: { date: "date" },
  },
  entryUnknown: {
    code: "equity_entry_unknown",
    status: 409,
    message: "The entry to reverse is not an equity entry of this organization.",
    remedy: "Reload the record and try again.",
  },
  entryNotPosted: {
    code: "equity_entry_not_posted",
    status: 409,
    message: "Entry {entry} is not a posted entry and cannot be reversed.",
    remedy: "Reload the record; it may already be reversed.",
    params: { entry: "text" },
  },
  notSaved: {
    code: "equity_write_failed",
    status: 409,
    message:
      "{record, select, round {The round} roundAmendment {The round amendment} roundVoid {The round void} shareClass {The share class} classAmendment {The class amendment} split {The split} plan {The plan} reserveChange {The reserve change} security {The security} event {The event} election {The election} reversal {The reversal} accountPolicy {The policy version} compensationRun {The compensation run} interestRun {The interest run} request {The equity action} other {The change}} was not saved.",
    remedy: "Try again.",
    params: { record: "choice" },
  },
  notStoredCompletely: {
    code: "equity_write_failed",
    status: 409,
    message:
      "{record, select, compensationLines {The compensation run lines} releaseLines {The restricted stock releases} interestLines {The interest run lines} positions {The cap table positions} vesting {The vesting tranches} other {The records}} were not stored completely; nothing was saved.",
    remedy: "Try again.",
    params: { record: "choice" },
  },
  positionsStale: {
    code: "equity_write_failed",
    status: 409,
    message: "The cap table position ledger was not brought up to date; nothing was saved.",
    remedy: "Try again.",
  },
  issuanceEntryUnknown: {
    code: "equity_issuance_entry_unknown",
    status: 409,
    message: "The issuance entry of {security} does not identify its principal.",
    remedy:
      "Review the instrument's issuance entry in the journal; a SAFE or note settles the principal its issuance credited.",
    params: { security: "text" },
  },
  interestUnreconciled: {
    code: "equity_interest_unreconciled",
    status: 409,
    message:
      "The ledger carries {carried} in accrued interest on {security}, but {accrued} has accrued to {date}.",
    remedy:
      "Review the note's interest entries in the journal; accrued interest is posted only by interest runs and settlements.",
    params: { carried: "money", accrued: "money", security: "text", date: "date" },
  },
} as const;
