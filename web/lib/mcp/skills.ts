/**
 * The MCP skill pack: operating playbooks shipped on the surface itself as
 * readable resources (openbooks://skills/<slug>), so any agent — Claude
 * Desktop, a custom client, a scheduled job — learns the rules of this system
 * from the system, not from client-side folklore.
 *
 * Authoring rules: every step must name real tools that exist in the
 * catalogs; a playbook that references a capability this surface does not
 * have is a defect. Plain markdown, no code fences.
 */
export interface McpSkill {
  slug: string;
  title: string;
  description: string;
  body: string;
}

export const MCP_SKILLS: readonly McpSkill[] = [
  {
    slug: "ground-rules",
    title: "Ground rules for working in OpenBooks",
    description:
      "Read this first: the operating doctrine every playbook assumes.",
    body: [
      "# Ground rules",
      "",
      "OpenBooks is an accounting system of record. You act as the authenticated user; every tool call passes the same permissions, workflows, period locks, and accounting controls the UI enforces. Nothing here lets you do what that user could not do on screen.",
      "",
      "1. Read before you write. Fetch the records you are about to change (get_record, get_document, list_open_items) and confirm state before mutating it. Never assume a draft is still a draft. Document reads return an exact persisted updatedAt revision; for every draft update or correction, copy it verbatim to expectedUpdatedAt and never generate, parse, or reformat it.",
      "2. Never invent identifiers or amounts. Resolve accounts with find_accounts, parties with find_parties, documents with find_documents, open items with list_open_items, record types and their fields with list_record_types. Use the stable UUIDs those tools return. If you cannot resolve a reference, stop and say so — do not guess.",
      "3. Report the tool's own numbers. When you state a balance, total, or aging figure, it must come from a tool result in this conversation, quoted exactly. If a number is unavailable, say it is unavailable and why; never substitute an estimate for a reading.",
      "4. Draft first; advancing is deliberate. Creating or editing a draft is routine work. Submitting, posting, voiding, correcting, deciding an approval, or closing a period changes the books — treat each as its own deliberate step, and expect workflows to intercept it (a post may return pending approval; that is success, not an error).",
      "5. Idempotency keys are yours to mint. Every mutation takes a caller-generated idempotencyKey. Generate a fresh unique key per logical operation and reuse the same key only when retrying that exact operation.",
      "6. Respect refusals. A forbidden, period-locked, or validation failure is the system working. Surface it to the user; do not route around a control by another path.",
      "7. If something you need is not a tool here, say so. Do not fabricate a capability or shell out around the surface.",
    ].join("\n"),
  },
  {
    slug: "draft-and-post-a-document",
    title: "Draft and post a transaction document",
    description:
      "Invoice, bill, or journal: resolve references, create the draft, verify it, then advance it deliberately.",
    body: [
      "# Draft and post a transaction document",
      "",
      "1. Discover the shape. Call list_record_types and find the document type you need (for example a customer invoice or vendor bill type). Its field list is live and tenant-specific — custom fields included. The record-type schema resource (openbooks://schema/record-types) carries the same data.",
      "2. Resolve every reference first. Party via find_parties, accounts via find_accounts, an existing document to mirror via find_documents + get_document. Line amounts are exact decimal strings; monetary fields never carry floats.",
      "3. Create the draft with create_record (typeKey, body, idempotencyKey). The body goes through the same domain writer and validation the UI uses; an invalid_input error names the failing fields — fix and retry with a new idempotency key only if the input actually changed.",
      "4. Verify what was created. get_record or get_document the returned id and check totals, dates, party, and lines against what the user asked for. Quote the created document number back.",
      "5. Advance deliberately, one step at a time. submit_document moves the draft into its approval workflow; post_document posts an approved document through the accounting kernel. Either may return pending approval — report that as the outcome and stop; a human decides approvals unless the user directing you holds that permission and has explicitly asked.",
      "6. Fixing mistakes: a draft can be edited with update_record by copying the exact updatedAt from the preceding read into expectedUpdatedAt. A posted document is never edited — use correct_document (correcting replacement draft plus controlled void, one transaction) with that same exact revision, or void_document with a reason. Both are controlled, audited operations.",
    ].join("\n"),
  },
  {
    slug: "record-and-apply-a-payment",
    title: "Record and apply a payment or receipt",
    description:
      "Vendor payment or customer receipt: resolve open items, allocate exactly, post once.",
    body: [
      "# Record and apply a payment or receipt",
      "",
      "1. Find what is owed. aging gives the per-party picture; list_open_items (side ar or ap, optionally partyId) gives the allocation-grade detail — each row carries openLineId, the source document, due date, and the exact remaining amount. Allocations are built only from these openLineIds; never from document ids and never from memory.",
      "2. Create the draft with create_payment: kind vendor_payment or customer_payment, party, bank account (resolve via find_accounts), date, and currency context. This is a draft; nothing has moved.",
      "3. Build allocations from the open items. Each allocation names an openLineId and exact decimal amounts. Same-currency settlements use settlementRate 1 with settlementRateSource same_currency; a cross-currency settlement must state its rate, its source, and a reference — never infer a rate.",
      "4. The amounts must reconcile. The sum of allocation amounts, any discountAmount, and any feeAmount must explain the payment total exactly — this is double-entry, not a suggestion. If the cash received does not match the open items, ask the user how to treat the difference (discount, fee, partial application); do not force it.",
      "5. Apply and post: update_payment to attach allocations to the draft, then post_payment to submit and post atomically. A pending-approval return is success — report it and stop.",
      "6. Verify: get_document on the payment, and list_open_items again to confirm the applied items' remaining amounts moved exactly as intended. Quote the before and after.",
    ].join("\n"),
  },
  {
    slug: "analyze-the-business",
    title: "Analyze the business: reports, dashboards, and operational reads",
    description:
      "The read surface: run any saved report, read the analytics dashboards and cash cockpits, and inspect banking, payroll, files, and configuration.",
    body: [
      "# Analyze the business",
      "",
      "1. Orient with whoami — permissions decide which of these tools you can even see. Every read tool returns the same numbers as its screen and carries an href deep link; quote it so the user can open the page behind the figure.",
      "2. Statements and trends: profit_and_loss, balance_sheet, financial_trends for period-over-period movement, budget_vs_actual for variance against a scenario from list_budget_scenarios. For anything saved in the report catalog — built-in statements or custom studio reports — resolve it with list_report_definitions and execute it with run_report; that is the same execution basis the export route and the scheduler use, so the numbers cannot disagree with a delivered PDF.",
      "3. Detail reads when a total needs proving: general_ledger for per-account lines with running balances, aging_detail for one row per open document, partner_statement for a single customer or vendor, cash_flow_indirect for the indirect-method statement. Results are capped; when a truncated flag is set, say so — never present a capped list as complete.",
      "4. Dashboards: analytics_financial_health, analytics_customer_intelligence, analytics_vendor_performance, analytics_cashflow, analytics_true_cost, analytics_utilization, and analytics_spend_velocity mirror the Analytics hub. analytics_sentinel runs the ledger-forensics detectors (digit-distribution, duplicates, sequential invoice runs, ghost vendors, off-hours postings) — its findings are leads to investigate with general_ledger and get_document, not verdicts to repeat as fact.",
      "5. Working-capital cockpits: ap_position (payables with a capacity-scheduled pay-run recommendation), ar_position (collections worklist), cash_position (weekly cash timeline and runway). They share one engine with aging and list_open_items, so the figures tie to the penny across tools.",
      "6. Operational reads: list_bank_reconciliations and get_bank_reconciliation for reconciliation state and totals, list_unmatched_bank_lines for what still needs matching. Payroll where enabled: list_pay_runs, get_pay_run, payroll_year_end, payroll_entitlements, payroll_remittances — employee government identifiers and withholding elections are never returned. File Cabinet: list_files, get_file, list_folders honor per-folder access grants. Configuration: list_setup_entities, list_setup_records, list_features.",
      "7. Everything in this playbook is read-only; nothing here changes the books. When analysis reveals work to do — an accrual to post, a payment to apply — switch to the drafting playbooks and their deliberate write steps.",
    ].join("\n"),
  },
  {
    slug: "run-a-period-close",
    title: "Run a period close",
    description:
      "The controlled close lifecycle: start, refresh, approve, attest, close, publish — and the only way back in.",
    body: [
      "# Run a period close",
      "",
      "1. Orient first. list_close_runs shows what is in flight; get_close_run shows one run's checklist state. Never start a second run for a scope that already has one in progress — resume it.",
      "2. start_close_run opens (or resumes) the authoritative checklist for an explicit period, book, and subsidiary scope. The checklist is the system's, not yours: your job is to drive its items to done, not to re-derive what closing means.",
      "3. refresh_close_run re-evaluates automated checks after you fix findings. Work the loop: read the run, resolve a finding through the normal tools (a missing accrual is a draft-and-post job; an unreconciled account is a human conversation), refresh, repeat.",
      "4. Owner-managed close uses attest_close_run, then close_period. request_close_approval and publish_close_package exist only when Advanced close controls are on; if those tools are absent or refuse, do not invent a substitute. Each step is gated by its own permission and may await other humans. Report where the run stands; never present a step you skipped as done.",
      "5. close_period is the consequential one — it locks the books for the scope. Treat a refusal (open findings, missing attestation) as the control working.",
      "6. Reopening is not an edit. If posted history must change in a closed period, request_period_reopen files an independently approved, time-bounded request for explicit modules, and decide_period_reopen is decided by someone with that authority. State the reason honestly; reopens are audited.",
    ].join("\n"),
  },
];
