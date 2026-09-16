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
    slug: "build-an-app", title: "Build and revise an app",
    description: "Author a package, preview an unpublished draft, and activate its reviewed fingerprint.",
    body: [
      "# Build an app",
      "1. Read describe_app_vocabulary. Prefer native shared screens and governed records. Clarify missing business requirements; do not ask the user to write JSON or choose an internal renderer.",
      "2. For an upgrade, read get_app_package and preserve its owned definitions and files. Give the revision a new version label.",
      "3. Call draft_app with the complete bundle and an honest reason. This creates an author-owned unpublished proposal; it does not create live objects or execute backend code.",
      "4. Present the returned review and preview links. Use get_app_draft when revising. A revision is a new draft. Preview has no live record access or backend writes; rehearse stateful behavior in an organization sandbox.",
      "5. After the user reviews and approves the exact draft, call activate_app_draft with its draftId and contentHash. Never bypass a stale-base refusal with a direct install. Re-read the installed package and prepare a new draft instead.",
      "6. Report the activated version and openUrl. Native and sandboxed frontends are two renderers of one app, not separate installations.",
      "7. An app may declare its own assistant tools: each manifest tools entry names a handler endpoint, a bounded object input schema, and the permissions it needs. Installed tools appear as app_<app-key>_<tool-key> beside the built-in tools for actors holding those permissions; read tools run governed, mutating tools propose a review card the user confirms.",
    ].join("\n"),
  },
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
      "1. Orient with whoami and describe_capabilities — permissions decide which of these tools you can even see. describe_capabilities lists the live catalog for this user with one-line blurbs and the features currently off, so never claim a capability it does not list. Every read tool returns the same numbers as its screen and carries an href deep link; quote it so the user can open the page behind the figure.",
      "2. Statements and trends: profit_and_loss, balance_sheet, financial_trends for period-over-period movement, budget_vs_actual for variance against a scenario from list_budget_scenarios. For anything saved in the report catalog — built-in statements or custom studio reports — resolve it with list_report_definitions and execute it with run_report; that is the same execution basis the export route and the scheduler use, so the numbers cannot disagree with a delivered PDF.",
      "3. Detail reads when a total needs proving: general_ledger for per-account lines with running balances, aging_detail for one row per open document, partner_statement for a single customer or vendor, cash_flow_indirect for the indirect-method statement. Results are capped; when a truncated flag is set, say so — never present a capped list as complete.",
      "4. Dashboards: analytics_financial_health, analytics_customer_intelligence, analytics_vendor_performance, analytics_cashflow, analytics_true_cost, analytics_utilization, and analytics_spend_velocity mirror the Analytics hub. analytics_sentinel runs the ledger-forensics detectors (digit-distribution, duplicates, sequential invoice runs, ghost vendors, off-hours postings) — its findings are leads to investigate with general_ledger and get_document, not verdicts to repeat as fact.",
      "5. Working-capital cockpits: ap_position (payables with a capacity-scheduled pay-run recommendation), ar_position (collections worklist), cash_position (weekly cash timeline and runway, 1–26 weeks). They share one engine with aging and list_open_items, so the figures tie to the penny across tools. Jobs: rank_projects for the whole portfolio (total count, margin/budget/committed per job, paging) and project_profitability for one job's detail; retainage_balances for holdback held or owed. Indirect tax: list_tax_return_forms, then tax_return for the filing-screen boxes of a period, and documents_missing_tax_code for the pre-filing review list.",
      "6. Operational reads: list_bank_reconciliations and get_bank_reconciliation for reconciliation state and totals, list_unmatched_bank_lines for what still needs matching. Payroll where enabled: list_pay_runs, get_pay_run, payroll_year_end, payroll_entitlements, payroll_remittances — employee government identifiers and withholding elections are never returned. File Cabinet: list_files, get_file, list_folders honor per-folder access grants. Configuration: list_setup_entities, list_setup_records, list_features. Items and stock where enabled: search_items and get_item for the item master, inventory_levels for on-hand by item and location, inventory_movements for the posted movement history, inventory_writedowns for lower-of-cost-or-market adjustments. Quotes and orders where enabled: search_orders for backlog with per-order fulfilment and billing state, get_order for one order's lines with remaining quantities and its links to fulfilments, receipts, and invoices. Fixed assets where enabled: search_assets for the register with cost and net book value, get_asset for one asset's accounts, books, and depreciation schedule page, asset_tax_pools for the computed pool results of a tax year. Equipment where enabled: search_equipment for the register with recovery and billable totals, get_equipment for one unit's utilization metrics.",
      "7. Everything in this playbook is read-only; nothing here changes the books. When analysis reveals work to do — an accrual to post, a payment to apply — switch to the drafting playbooks and their deliberate write steps.",
    ].join("\n"),
  },
  {
    slug: "reconcile-a-bank-account",
    title: "Reconcile a bank account",
    description:
      "Open a session, match every statement line, and sign off at zero difference.",
    body: [
      "# Reconcile a bank account",
      "",
      "1. Orient first. list_bank_reconciliations shows the sessions for an account and get_bank_reconciliation shows one session's running totals (statement balance, cleared balance, difference, matched and unmatched counts) — the same numbers the workspace badge and sign-off gate use. list_unmatched_bank_lines shows what still needs matching.",
      "2. Open the session with start_reconciliation: the bank account (resolve via find_accounts), an explicit through-date, and the exact statement balance. One open session per account — resume the open one rather than starting a second.",
      "3. Match deliberately, one line at a time. match_bank_line pairs one unmatched statement line with the posted journal lines that explain it (inspect candidates with get_journal_entry); the journal total must equal the statement line exactly. When no posted line explains the bank line, match_bank_line_with_journal books a categorizing journal (bank leg on the line's account, remainder to the offset account) and matches it. unmatch_bank_line returns a line to the unmatched queue.",
      "4. Sign off only at zero. sign_off_reconciliation refuses a nonzero difference or missing statement evidence — treat that refusal as the control working, resolve the break with step 3, and retry. A signed-off session is permanent; it stamps every matched journal line reconciled.",
      "5. Every step takes a caller-generated idempotencyKey: fresh per logical operation, reused only when retrying that exact operation. Each mutation returns a confirmation card and makes no change until the user clicks Apply.",
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
      "1. Orient first. list_close_runs shows what is in flight; get_close_run_status reports one run's cockpit detail (tasks by status, open exceptions, sign-offs, locks). list_period_locks shows lock state by scope and list_period_reopen_requests shows reopen workflow state. Never start a second run for a scope that already has one in progress — resume it.",
      "2. start_close_run opens (or resumes) the authoritative checklist for an explicit period, book, and subsidiary scope. The checklist is the system's, not yours: your job is to drive its items to done, not to re-derive what closing means.",
      "3. refresh_close_run re-evaluates automated checks after you fix findings. Work the loop: read the run, resolve a finding through the normal tools (a missing accrual is a draft-and-post job; an unreconciled account is a human conversation), refresh, repeat.",
      "4. Owner-managed close uses attest_close_run, then close_period. request_close_approval and publish_close_package exist only when Advanced close controls are on; if those tools are absent or refuse, do not invent a substitute. Each step is gated by its own permission and may await other humans. Report where the run stands; never present a step you skipped as done.",
      "5. close_period is the consequential one — it locks the books for the scope. Treat a refusal (open findings, missing attestation) as the control working.",
      "6. Reopening is not an edit. If posted history must change in a closed period, request_period_reopen files an independently approved, time-bounded request for explicit modules, and decide_period_reopen is decided by someone with that authority. State the reason honestly; reopens are audited.",
    ].join("\n"),
  },
];
