import { createHash } from "node:crypto";

const PUBLISHED_PARTIAL_HEADER = Object.freeze({
  filename: "generated/0572_optional_custom_dimension_assignments.sql",
  sha256: "de1ddc2b3f2bf8f2ac106eedeb1d328095823fc67bcd59612032f303e8fd7f78",
  settings: Object.freeze([
    Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
    Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
    Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
    Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
  ]),
});

const PUBLISHED_RUNNER_LOCK_HEADER = Object.freeze({
  filename: "generated/0580_clone_preserves_recorded_document_balances.sql",
  sha256: "1ee33f04b4c0cfe6c1725d19d08cc613e593bbc2c63a499ae9e58b0b419ca59b",
  settings: Object.freeze([]),
  runnerOwnsLockTimeout: true,
});

/**
 * Published files (already applied to deployed databases, so their bytes are
 * immutable) whose authored session header is incomplete or pins an
 * unbounded lock_timeout. The runner supplies each one's missing standard
 * settings ahead of the exact bytes and owns its lock bound; the ledger
 * digest still identifies the original file. New migrations must carry the
 * full header instead of joining this list.
 */
const PUBLISHED_HEADER_POLICIES = Object.freeze([
  Object.freeze({
    filename: "generated/0588_journal_line_statement_aggregates.sql",
    sha256: "18073e5309a5ff1534e9efe2cde1bc765d09dd273b43ccf3ddbfc699dca8bc33",
    settings: Object.freeze([]),
    runnerOwnsLockTimeout: true,
  }),
  Object.freeze({
    filename: "generated/0590_journal_statement_balance_totals.sql",
    sha256: "f53203ea6104c16cf7a95748ac3b03278a41451f2025c82d58cdc6cbbcc029b5",
    settings: Object.freeze([]),
    runnerOwnsLockTimeout: true,
  }),
  Object.freeze({
    filename: "generated/0600_benefit_unused_coverage_withdrawal.sql",
    sha256: "b0bf28c5f147a50bad87d4ed69b8209b7ce4c43f1fab095eace618a3f148babe",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0601_benefit_withdrawal_context_fail_closed.sql",
    sha256: "bec104c112b66d31b1c8896ad1cad7a445cfef91085b04007e3f32c943d0b1d9",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0602_benefit_cancelled_election_replacement.sql",
    sha256: "76afec449b8789f666f2aadafc44080a4b114a4ac2ce02209c24bd69bcbc592a",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0603_benefit_withdrawal_legacy_history.sql",
    sha256: "0122ad8ea01588ef4a1e708196662cfc3c9674a9153f48c32e12b02696dcacfb",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0604_benefit_termination_legacy_history.sql",
    sha256: "57a9f52437b3818aa18c874d83f05f88dee3fac43219ff4756ccd58d8868eb67",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0605_payroll_adjudicated_holiday_obligations.sql",
    sha256: "9ff4c24b2bb9d2227d2985cde027e6c31c389cbb9ba276f3a85bb71a8c069928",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0606_payroll_holiday_settlement_allocations.sql",
    sha256: "2b42e7cfeb91fc467e9c591b50c24c95fc7ab88c26745af83cebb7f835df2e65",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0607_payroll_holiday_historical_clone.sql",
    sha256: "16381e35477af81df7a7202a78c7f086cd3e04d1c531e4fee6b31e35ededc0bd",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0608_holiday_clone_identity_projection.sql",
    sha256: "869cdd57fcefcbc984fa41660b2667ad4d1ea85d6d149320a870d995390721e9",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0609_payroll_service_configuration_historical_clone.sql",
    sha256: "6fb0d2167c3fa8e86cb83c296dff362cf83439e99ff0c15c035269007ce0af6b",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0610_financial_change_configured_self_approval.sql",
    sha256: "3b7b98cd2edbb9afa32d35c909aa44ebc2b9bf27ea3da269a6cff4199cc88ccb",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0611_payroll_derived_quantity_evidence.sql",
    sha256: "b87c21745125c2f0e4d508be51bcba83d052b5c4c64a824af3534a4e349571cb",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0612_payroll_assignment_run_applicability.sql",
    sha256: "84c0bf8178c7a3ef4360a58fd34da5e2397ec9a0e2aed16ec07a9699a982c6bc",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0613_compensation_configured_flow_approval.sql",
    sha256: "844f9f6d4fe81ce64f8ed8eee97f474ee9f3b643bce5e7abd6ea29067e080390",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0617_benefit_ended_unused_coverage_withdrawal.sql",
    sha256: "f86066ba761d5cef0c7315ceaf30cb624393f1b1844f423c3c88abb71bb23e18",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0619_operating_profiles_production_extensions.sql",
    sha256: "42daad13839b4303794f5c7ede20d0c3a02387c789ae4db41316ea6c2a2728fa",
    settings: Object.freeze([
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0622_query_console_catalog_privileges.sql",
    sha256: "40b2a2f129e20507e8d8143f8a6cdfb9f964f5e4248c5a07cce77fdd5735070b",
    settings: Object.freeze([
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0623_reconciliation_match_clone_authority.sql",
    sha256: "4052996e444a1de24b569872bbb0c987e0408482087f48d7289bd5c6a6041bff",
    settings: Object.freeze([
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0624_payroll_adjustment_earned_dates.sql",
    sha256: "64c3d41501f4cd88c053dda5504534028a978ec0048a09641e644fc1b587cd85",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0625_quota_sandbox_wipe_authority.sql",
    sha256: "46277ea64b6ff551d9756106a7b96588ec6e8c8134efdf944b4e6f62c2dd2245",
    settings: Object.freeze([
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0626_tenant_retirement.sql",
    sha256: "4da9e2c44bff6ed85de4fa5eebf94075070e86f0308f65e243bb5c3a22352988",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0627_compensation_ungated_submission.sql",
    sha256: "35e82bdfbbc52f9241c448f91de4cd64f000a2815f0bb228be583b6ce3502dbe",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0628_production_retirement_contracts.sql",
    sha256: "1d68ab208b84f1ab23b98fd239530af8c1b9a361e6c827b1e31a5d4018e6dc0a",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0629_employee_component_periodic_and_final.sql",
    sha256: "86c5c575c80cf0d5dcf8b1ad4ca0c1d303fe06a33c98debfde1cea5d56926997",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0630_warehouse_masked_clone.sql",
    sha256: "a8d7574eb0e8c5741357e9a80db51fb75a0fb1f5163a340192a9821c5a241b51",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0631_routing_activation_candidate_comparison.sql",
    sha256: "fce319ddf5a8c557aa5e9e82764a232e5cc6cce03f12fb62f7523e016a146557",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0632_serial_manufacturing_lifecycle.sql",
    sha256: "0e8e06304b84df177b84acca5c45e08fcff9c691aac211d9865f15011a470af5",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0633_compensation_unconfigured_flow_submission.sql",
    sha256: "5e11234cb8e50c5753497bf2e74c4c700668fd291a61708e4cd7d18d6993d632",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0642_warehouse_defaults.sql",
    sha256: "73ff8cad294e16b54f4d455e3f5dd004f68bbf948f632fae87111c068bf3cbc4",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0646_time_approval_policies.sql",
    sha256: "1de5dced12690fe48760c440069e102509c3f8e4f42e39644bfb42667a591092",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0651_benefit_program_customer_scope.sql",
    sha256: "2d6d0bbda01f6360fabc9d5be3237c5008d932a0a4c7d696402559f766a9dc5e",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0652_routing_no_flow_activation.sql",
    sha256: "1ad714c25f58fc6280ca0dd10cf11227aa8ba24b5b793580ecf2dfd4f818991d",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0653_transaction_incentive_document_roles.sql",
    sha256: "5c017a74c9887815616a6786b16fb43681ec29c7b1bfc00fd46cf51765a1a129",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0654_project_margin_incentives.sql",
    sha256: "f77504dd50c562c30e0aaa33b90e7553fe78ce75eecb1f7da770dfa5f9bf2eb3",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0656_project_margin_program_shape.sql",
    sha256: "83c71d4c0964185180477c0b13bb85c3639b3858dc5d0e8051108ada6711243d",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0657_purchase_over_receipt_tolerances.sql",
    sha256: "85dd12d6738b67b6d7034dfb5202ecc5c4de34d8baffea2324011755dfabf713",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0660_benefit_program_hour_classifications.sql",
    sha256: "dfda534679b8dae3cee2206deacb8904306f858ca4016b663b50ec54a9885bfe",
    settings: Object.freeze([
      Object.freeze({ name: "statement_timeout", sql: "SET statement_timeout = 0;" }),
      Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
      Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
      Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
      Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
    ]),
  }),
  Object.freeze({
    filename: "generated/0664_reconcile_stale_reopen_windows.sql",
    sha256: "2871f5825fc17831f0eb4b13d540632bdf157a3361cee1721cf374f1b2283f9e",
    settings: Object.freeze([]),
    runnerOwnsLockTimeout: true,
  }),
  Object.freeze({
    filename: "generated/0666_document_close_module_kind_backfill.sql",
    sha256: "33c8b09318e208248733b0e3f8327f081456c4acf1540da7e398fb052cfe8ad2",
    settings: Object.freeze([]),
    runnerOwnsLockTimeout: true,
  }),
  Object.freeze({
    filename: "generated/0667_benefit_program_revisions.sql",
    sha256: "9d0cd0c8bc1902af60496c66362d929afbd02e767a1cd6e8aeeb9c08d4021fe1",
    settings: Object.freeze([
      Object.freeze({"name": "statement_timeout", "sql": "SET statement_timeout = 0;"}),
      Object.freeze({"name": "idle_in_transaction_session_timeout", "sql": "SET idle_in_transaction_session_timeout = 0;"}),
      Object.freeze({"name": "client_encoding", "sql": "SET client_encoding = 'UTF8';"}),
      Object.freeze({"name": "standard_conforming_strings", "sql": "SET standard_conforming_strings = on;"}),
      Object.freeze({"name": "client_min_messages", "sql": "SET client_min_messages = warning;"}),
    ]),
  }),
  Object.freeze({
    filename: "generated/0668_benefit_program_eligibility.sql",
    sha256: "d60af95fa8e92d892b907b8d7e51802057f720308c07b097478e81ff7bcfd453",
    settings: Object.freeze([
      Object.freeze({"name": "statement_timeout", "sql": "SET statement_timeout = 0;"}),
      Object.freeze({"name": "idle_in_transaction_session_timeout", "sql": "SET idle_in_transaction_session_timeout = 0;"}),
      Object.freeze({"name": "client_encoding", "sql": "SET client_encoding = 'UTF8';"}),
      Object.freeze({"name": "standard_conforming_strings", "sql": "SET standard_conforming_strings = on;"}),
      Object.freeze({"name": "client_min_messages", "sql": "SET client_min_messages = warning;"}),
    ]),
  }),
  Object.freeze({
    filename: "generated/0669_reconciliation_signoff_withdrawal.sql",
    sha256: "1a6a9765f61c5072f5a720a670041e9a9bbeb687ff39b3345407fa052b26dbd6",
    settings: Object.freeze([]),
    runnerOwnsLockTimeout: true,
  }),
  Object.freeze({
    filename: "generated/0670_benefit_program_member_exclusions.sql",
    sha256: "897c2ee5a26f3d785bf43fcd8168e0067b4a0ffbd5f076aeea00513e8dc401fb",
    settings: Object.freeze([
      Object.freeze({"name": "statement_timeout", "sql": "SET statement_timeout = 0;"}),
      Object.freeze({"name": "idle_in_transaction_session_timeout", "sql": "SET idle_in_transaction_session_timeout = 0;"}),
      Object.freeze({"name": "client_encoding", "sql": "SET client_encoding = 'UTF8';"}),
      Object.freeze({"name": "standard_conforming_strings", "sql": "SET standard_conforming_strings = on;"}),
      Object.freeze({"name": "client_min_messages", "sql": "SET client_min_messages = warning;"}),
    ]),
  }),
  Object.freeze({
    filename: "generated/0692_journal_instruction_modes.sql",
    sha256: "e31bcb469f0082873620ec3cdca678a6f55ab043843da9f8147b6dc1aa7e7000",
    settings: Object.freeze([
      Object.freeze({"name": "client_min_messages", "sql": "SET client_min_messages = warning;"}),
    ]),
  }),
  Object.freeze({
    filename: "generated/0693_balancing_segment_policy_versions.sql",
    sha256: "fb9ab6abeff4120e80bc146fd32dab8a5e94459ded8796a0b4b61cdb57038ec6",
    settings: Object.freeze([
      Object.freeze({"name": "client_min_messages", "sql": "SET client_min_messages = warning;"}),
    ]),
  }),
  Object.freeze({
    filename: "generated/0694_period_entity_gl_audit_numbering.sql",
    sha256: "293ad0866b39810833bb5f1537fe7dbc079f89fecbc6da03b8efc44e53ff5fd8",
    settings: Object.freeze([
      Object.freeze({"name": "client_min_messages", "sql": "SET client_min_messages = warning;"}),
    ]),
  }),
  Object.freeze({
    filename: "generated/0695_revenue_recognition_fair_value_delivery.sql",
    sha256: "77d7a1ecd78d543a3f8924d9c4959bcdda61b22362607e2b1b4e680cc056a0aa",
    settings: Object.freeze([
      Object.freeze({"name": "statement_timeout", "sql": "SET statement_timeout = 0;"}),
      Object.freeze({"name": "idle_in_transaction_session_timeout", "sql": "SET idle_in_transaction_session_timeout = 0;"}),
      Object.freeze({"name": "client_encoding", "sql": "SET client_encoding = 'UTF8';"}),
      Object.freeze({"name": "standard_conforming_strings", "sql": "SET standard_conforming_strings = on;"}),
      Object.freeze({"name": "client_min_messages", "sql": "SET client_min_messages = warning;"}),
    ]),
  }),
  Object.freeze({
    filename: "generated/0696_renewal_policy_documents.sql",
    sha256: "4113a95e03e8959313b923b367e85b152fb965f6f4509e9ad41b69766c92e54f",
    settings: Object.freeze([
      Object.freeze({"name": "statement_timeout", "sql": "SET statement_timeout = 0;"}),
      Object.freeze({"name": "idle_in_transaction_session_timeout", "sql": "SET idle_in_transaction_session_timeout = 0;"}),
      Object.freeze({"name": "client_encoding", "sql": "SET client_encoding = 'UTF8';"}),
      Object.freeze({"name": "standard_conforming_strings", "sql": "SET standard_conforming_strings = on;"}),
      Object.freeze({"name": "client_min_messages", "sql": "SET client_min_messages = warning;"}),
    ]),
  }),
  Object.freeze({
    filename: "generated/0697_rebate_policy_settlements.sql",
    sha256: "ad7464233f3b0846d85220e91b48801283f0dd80043be4de6b129c9d03ca51af",
    settings: Object.freeze([
      Object.freeze({"name": "statement_timeout", "sql": "SET statement_timeout = 0;"}),
      Object.freeze({"name": "idle_in_transaction_session_timeout", "sql": "SET idle_in_transaction_session_timeout = 0;"}),
      Object.freeze({"name": "client_encoding", "sql": "SET client_encoding = 'UTF8';"}),
      Object.freeze({"name": "standard_conforming_strings", "sql": "SET standard_conforming_strings = on;"}),
      Object.freeze({"name": "client_min_messages", "sql": "SET client_min_messages = warning;"}),
    ]),
  }),
  Object.freeze({
    filename: "generated/0698_rbc_std152_bank_files.sql",
    sha256: "b305c8da41216d8a1b06ee569dc20bc1cc087dc605adfb63881e526de13bdbea",
    settings: Object.freeze([
      Object.freeze({"name": "statement_timeout", "sql": "SET statement_timeout = 0;"}),
      Object.freeze({"name": "idle_in_transaction_session_timeout", "sql": "SET idle_in_transaction_session_timeout = 0;"}),
      Object.freeze({"name": "client_encoding", "sql": "SET client_encoding = 'UTF8';"}),
      Object.freeze({"name": "standard_conforming_strings", "sql": "SET standard_conforming_strings = on;"}),
      Object.freeze({"name": "client_min_messages", "sql": "SET client_min_messages = warning;"}),
    ]),
  }),
  Object.freeze({
    filename: "generated/0699_financial_history_native_clone_guards.sql",
    sha256: "eb192fe9113093021a6b6998c18fb08f671e9a1a22182e4265bd2132fad67e5a",
    settings: Object.freeze([
      Object.freeze({"name": "client_min_messages", "sql": "SET client_min_messages = warning;"}),
    ]),
  }),
  Object.freeze({
    filename: "generated/0701_merged_account_reference_guards.sql",
    sha256: "99f9758828e1906421264c6cf2d81ee94a47c7c0db9ee056e92093dd0a6c298c",
    settings: Object.freeze([
      Object.freeze({"name": "client_min_messages", "sql": "SET client_min_messages = warning;"}),
    ]),
  }),
  Object.freeze({
    filename: "generated/0702_journal_instruction_currency_binding.sql",
    sha256: "3b7ebba6fe31c5a9e8e8925a0fd894b35db029648737b2b5d28dc306d1274334",
    settings: Object.freeze([
      Object.freeze({"name": "client_min_messages", "sql": "SET client_min_messages = warning;"}),
    ]),
  }),
  Object.freeze({
    filename: "generated/0703_journal_measurement_and_instruction_guards.sql",
    sha256: "3a60b33ec04dd05de7bd219c4d2852439ac7c43a9ea1984a48f1bd895dbabae1",
    settings: Object.freeze([
      Object.freeze({"name": "client_min_messages", "sql": "SET client_min_messages = warning;"}),
    ]),
  }),
  Object.freeze({
    filename: "generated/0704_bank_rule_validator_catalog_references.sql",
    sha256: "639da3812f7516193790fb2898fea8a3079410e27860d17de512bea2eb5bd561",
    settings: Object.freeze([
      Object.freeze({"name": "statement_timeout", "sql": "SET statement_timeout = 0;"}),
      Object.freeze({"name": "idle_in_transaction_session_timeout", "sql": "SET idle_in_transaction_session_timeout = 0;"}),
      Object.freeze({"name": "client_encoding", "sql": "SET client_encoding = 'UTF8';"}),
      Object.freeze({"name": "standard_conforming_strings", "sql": "SET standard_conforming_strings = on;"}),
      Object.freeze({"name": "client_min_messages", "sql": "SET client_min_messages = warning;"}),
    ]),
  }),
  Object.freeze({
    filename: "generated/0705_rbc_std152_existing_organization_format.sql",
    sha256: "525633b7278b9113fe402a23d58f23417857d8a1c5ee272811d8b6134982c97a",
    settings: Object.freeze([
      Object.freeze({"name": "statement_timeout", "sql": "SET statement_timeout = 0;"}),
      Object.freeze({"name": "idle_in_transaction_session_timeout", "sql": "SET idle_in_transaction_session_timeout = 0;"}),
      Object.freeze({"name": "client_encoding", "sql": "SET client_encoding = 'UTF8';"}),
      Object.freeze({"name": "standard_conforming_strings", "sql": "SET standard_conforming_strings = on;"}),
      Object.freeze({"name": "client_min_messages", "sql": "SET client_min_messages = warning;"}),
    ]),
  }),
]);

function publishedSessionPolicy(filename, content) {
  const policy = [PUBLISHED_PARTIAL_HEADER, PUBLISHED_RUNNER_LOCK_HEADER, ...PUBLISHED_HEADER_POLICIES]
    .find((entry) => entry.filename === filename);
  if (!policy) return null;
  if (createHash("sha256").update(content).digest("hex") !== policy.sha256) {
    throw new Error(`${filename} differs from its published digest — use the published bytes and make schema corrections through a new forward migration.`);
  }
  return policy;
}

/** Supply a published file's incomplete session header without changing its ledger identity. */
export function publishedMigrationSessionSettings(filename, content) {
  return publishedSessionPolicy(filename, content)?.settings ?? [];
}

/** Admit only reviewed immutable bytes whose file-level timeout the runner strips. */
export function publishedMigrationUsesRunnerLockTimeout(filename, content) {
  return publishedSessionPolicy(filename, content)?.runnerOwnsLockTimeout === true;
}

export function publishedMigrationSessionPrelude(filename, content) {
  const settings = publishedMigrationSessionSettings(filename, content);
  return settings.length ? settings.map(({ sql }) => sql).join("\n") + "\n" : "";
}
