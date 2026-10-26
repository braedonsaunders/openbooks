/** Trigger contracts for equity history. */
export const EQUITY_TRIGGER_CONTRACTS = [
  {
    table: "equity_share_classes",
    trigger: "equity_share_classes_immutable",
    function: "equity_record_immutable",
  },
  {
    table: "equity_class_amendments",
    trigger: "equity_class_amendments_immutable",
    function: "equity_record_immutable",
  },
  {
    table: "equity_plans",
    trigger: "equity_plans_immutable",
    function: "equity_record_immutable",
  },
  {
    table: "equity_plan_reserve_changes",
    trigger: "equity_plan_reserve_changes_immutable",
    function: "equity_record_immutable",
  },
  {
    table: "equity_financing_rounds",
    trigger: "equity_financing_rounds_immutable",
    function: "equity_record_immutable",
  },
  {
    table: "equity_securities",
    trigger: "equity_securities_immutable",
    function: "equity_record_immutable",
  },
  {
    table: "equity_security_events",
    trigger: "equity_security_events_immutable",
    function: "equity_record_immutable",
  },
  {
    table: "equity_splits",
    trigger: "equity_splits_immutable",
    function: "equity_record_immutable",
  },
  {
    table: "equity_compensation_runs",
    trigger: "equity_compensation_runs_immutable",
    function: "equity_record_immutable",
  },
  {
    table: "equity_compensation_run_lines",
    trigger: "equity_compensation_run_lines_immutable",
    function: "equity_record_immutable",
  },
  {
    table: "equity_account_policies",
    trigger: "equity_account_policies_immutable",
    function: "financial_policy_version_immutable",
  },
  {
    table: "equity_security_amendments",
    trigger: "equity_security_amendments_immutable",
    function: "equity_record_immutable",
  },
  {
    table: "equity_interest_runs",
    trigger: "equity_interest_runs_immutable",
    function: "equity_record_immutable",
  },
  {
    table: "equity_interest_run_lines",
    trigger: "equity_interest_run_lines_immutable",
    function: "equity_record_immutable",
  },
  {
    table: "equity_compensation_run_releases",
    trigger: "equity_compensation_run_releases_immutable",
    function: "equity_record_immutable",
  },
  {
    table: "equity_action_requests",
    trigger: "equity_action_requests_immutable",
    function: "equity_action_request_guard",
  },
  {
    table: "equity_position_movements",
    trigger: "equity_position_movements_immutable",
    function: "equity_record_immutable",
  },
  {
    table: "equity_round_amendments",
    trigger: "equity_round_amendments_immutable",
    function: "equity_record_immutable",
  },
  {
    table: "equity_instrument_line_attributions",
    trigger: "equity_instrument_line_attributions_immutable",
    function: "equity_record_immutable",
  },
] as const;
