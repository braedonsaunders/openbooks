/** Refusals of governed equity actions, their approval in Flows, and equity account policy versions. */
export const GOVERNANCE_REFUSALS = {
  actionRejected: {
    code: "equity_action_rejected",
    status: 409,
    message: "This action was rejected by its approver.",
    remedy:
      "Review the approver's reason, then record the action again with a new request key if it still applies.",
  },
  actionWithdrawn: {
    code: "equity_action_withdrawn",
    status: 409,
    message: "This action was withdrawn by its requester.",
    remedy: "Record the action again with a new request key if it still applies.",
  },
  actionPending: {
    code: "equity_action_pending",
    status: 409,
    message:
      "{action, select, void {A void} reverse {A reversal} repurchase {A repurchase} repay {A repayment} cancel_convertible {A cancellation} class_amendment {A class amendment} split {A split} reserve_change {A reserve change} mfn_election {An MFN election} mfn_reversal {An MFN election reversal} compensation_run {A stock compensation run} interest_run {A note interest run} account_policy {An account policy version} round_amendment {A round amendment} round_void {A round void} other {An equity action}} of {subject} is already awaiting approval.",
    remedy:
      "Wait for the approver's decision, or withdraw the pending request from Inbox → Submitted by me, before recording another.",
    params: { action: "choice", subject: "text" },
  },
  actionRoutingFailed: {
    code: "equity_action_routing_failed",
    status: 409,
    message: "The equity action could not be routed for approval: {reason}.",
    remedy:
      "Correct the Equity action Flow in Flows (or disable it), then record the action again.",
    params: { reason: "text" },
  },
  actionChangedWhileApplied: {
    code: "equity_action_changed",
    status: 409,
    message: "The equity action changed while it was being applied.",
    remedy: "Reload and try again.",
  },
  actionChangedWhileWithdrawn: {
    code: "equity_action_changed",
    status: 409,
    message: "The equity action changed while it was being withdrawn.",
    remedy: "Reload the Inbox to see its outcome.",
  },
  actionChangedWhileDecided: {
    code: "equity_action_changed",
    status: 409,
    message: "The equity action changed while it was being decided.",
    remedy: "Reload the Inbox and decide it again if it is still pending.",
  },
  withdrawalReasonRequired: {
    code: "equity_reason_required",
    message: "Give a reason of {min} to {max} characters for withdrawing the action.",
    remedy: "Explain why the action no longer applies, then withdraw it again.",
    params: { min: "count", max: "count" },
  },
  actionUnknown: {
    code: "equity_action_unknown",
    status: 404,
    message: "The equity action does not exist.",
    remedy: "Reload the Inbox.",
  },
  withdrawForbidden: {
    code: "equity_withdraw_forbidden",
    status: 403,
    message: "Only the requester can withdraw an equity action.",
    remedy:
      "Ask the requester to withdraw it, or reject it from the Inbox if you are an approver named on its Flow.",
  },
  actionDecidedNoWithdrawal: {
    code: "equity_action_decided",
    status: 409,
    message:
      "The equity action is {status, select, pending_approval {awaiting approval} applied {applied} rejected {rejected} withdrawn {withdrawn} other {decided}}, not awaiting approval, so it cannot be withdrawn.",
    remedy: "Reload the Inbox to see its outcome.",
    params: { status: "choice" },
  },
  actionDecided: {
    code: "equity_action_decided",
    status: 409,
    message:
      "The equity action is {status, select, pending_approval {awaiting approval} applied {applied} rejected {rejected} withdrawn {withdrawn} other {decided}}, not awaiting approval.",
    remedy: "Reload the Inbox to see its outcome.",
    params: { status: "choice" },
  },
  approvalSignInRequired: {
    code: "equity_forbidden",
    status: 403,
    message: "An equity approval must be decided by a signed-in user.",
    remedy: "Sign in and decide the approval from the Inbox.",
  },
  selfApproval: {
    code: "equity_self_approval",
    status: 403,
    message: "The requester of an equity action cannot decide its approval.",
    remedy: "Ask another approver named on the Flow's gate to decide it.",
  },
  rejectionReasonRequired: {
    code: "equity_reason_required",
    message: "Record the reason for rejecting the equity action.",
    remedy: "Add a comment explaining the rejection, then reject again.",
  },
  accountPolicyEntityMissing: {
    code: "equity_account_policy_invalid",
    message: "Choose the legal entity the policy applies to.",
    remedy: "Choose the legal entity, then save the policy version again.",
  },
  accountPolicyEffectiveDateInvalid: {
    code: "equity_account_policy_invalid",
    message: "Enter the date the policy takes effect.",
    remedy: "Choose a valid date under “{field}”, then save the policy version again.",
    params: { field: "term" },
  },
  accountPolicyAccountMissing: {
    code: "equity_account_policy_invalid",
    message: "Choose the account for “{account}”.",
    remedy: "Choose an account under “{account}”, then save the policy version again.",
    params: { account: "term" },
  },
  accountPolicyAccountType: {
    code: "equity_account_policy_invalid",
    message:
      "“{account}” must be {kind, select, equity {an active equity posting account} expense {an active expense posting account} liabilityOrEquity {an active liability or equity posting account} liability {an active other current or long-term liability posting account} other {an active posting account of an accepted type}} of the organization.",
    remedy:
      "Choose {kind, select, equity {an active equity posting account} expense {an active expense posting account} liabilityOrEquity {an active liability or equity posting account} liability {an active other current or long-term liability posting account} other {an active posting account of an accepted type}} under “{account}”, then save the policy version again.",
    params: { account: "term", kind: "choice" },
  },
  accountPolicyBeforeLatestPosting: {
    code: "equity_account_policy_invalid",
    message:
      "Equity entries are posted through {date}; a new policy version must take effect after that date so posted history keeps its accounts.",
    remedy:
      "Record a new policy version effective after {date}, so it satisfies the current ledger.",
    params: { date: "date" },
  },
} as const;
