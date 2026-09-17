# Changelog

OpenBooks follows [Semantic Versioning](https://semver.org/) while its public
API and deployment format stabilize. Alpha releases may contain breaking
changes; each release documents required operator action.

## [Unreleased]

## [0.1.0-alpha.15] - 2026-09-17

Fleet-7 defect wave on top of alpha.14. No new migration.

### Payroll, parties, and close

- Backdated wage rates persist, capped before their successor.
- Parallel-run net is attributed against stated gross; pay-run funding
  reads ledger balances including reversals.
- Party PATCH accepts stored customer/vendor/employee kinds.
- Close reporting-package slugs resolve to names and links.

### Gates, documents, and send

- Disabled features and refused permissions explain themselves instead
  of silent 404s and bounces; Scripts and REST API docs name the
  Features-switch prerequisite.
- Unset subsidiary stays unset; save and convert refusals pin as
  record alerts. Incomplete email config is a typed refusal; failed
  sends stay visible in the composer.
- Inventory Post refusals pin on the record; line-less budget submits
  refuse with a typed message.

### Inventory, fulfilment, assets, and approvals

- Standalone invoices refuse to post when stock-relief issue effects
  fail, so revenue cannot land without its matching COGS.
- Fulfilment is a sales-order conversion target; an approved order is
  no longer a dead end.
- Depreciation runs that post nothing name the next due line.
  Equipment activation names the missing charge item.
- Directly submitted budgets reach the approvals inbox.

### Banking, retainage, and CAM

- A first bank reconciliation counts the proven statement opening toward
  cleared, so it can reach zero and be signed off.
- Retainage Receivable has a Company Settings home; pay-application
  invoices are no longer blocked by an invisible control-account
  requirement.
- CAM finalize refusals pin on the pool card instead of vanishing with
  a toast.

## [0.1.0-alpha.14] - 2026-09-17

Fleet-7 batches 1–2 on top of alpha.13. Requires migration 0170.

### Locale remediation

- Admin and analytics catalogs are fully translated in fr, es, de, ja,
  zh, and pt-BR, each namespace pinned so English cannot be pasted back.
- Payroll catalogs land in all six non-English locales (848 keys each).

### CRM, banking, drawers, and PDF

- Lead stage changes persist; new prospects start at the right stage.
- Forecast snapshots file at the displayed scope, including the whole
  organization (0170 relaxes the target CHECK).
- Banking overview uses one reconcilable-account reader even when
  consolidated rates are underived.
- Dirty document drawers keep a header Save and confirm before close.
- PDF template duplication no longer collides on default names; a taken
  name is a typed 409.
- Currency-mismatched postings refuse with a typed message, never raw
  SQL. Unapplied credits net against party open balance. AR customer
  search gives an honest empty state. Close review tasks offer start,
  evidence, and complete. Customer status facets count without group-by
  when CRM is off. Catalog placeholder-parity pins no longer match a
  literal backslash-brace.

## [0.1.0-alpha.13] - 2026-09-17

Fleet-6 closeout on top of alpha.12. No new migration.

### i18n, shell, and allocations

- `ar.collections` and `agents` catalogs backfill de, ja, zh, and pt-BR
  (F-x6-002).
- The platform workspace switcher lives in the account menu.
- Allocation-rule wizard destination menus stay above the modal and
  match on any dimension, with codes in the option labels.
- Pre-flow vendor bank accounts can be submitted into the current
  approval flow; party payloads publish the canonical OCC token so
  Edit-then-Save no longer 409s.
- French and Spanish property type/status labels agree with the
  masculine building noun.

## [0.1.0-alpha.12] - 2026-09-16

Fleet-6 batches 9–44: setup, banking, assistant, payroll, CRM, reports,
dashboard, documents, allocations, construction/AR, rates, assets,
payroll, i18n, drawers/search/mobile, expenses, compliance, invites,
agents/AI, and a11y UX on top of alpha.11. Requires migration 0169.

### Setup and shell

- Typed validation and duplicate conflicts with user-language messages;
  required fields persist errors and reset busy on transport failure;
  blank `keepDefault` fields are legal; time-classification option labels
  resolve under `options`.
- Shell empty-state no longer repeats the boundary copy in the body.

### Banking, approvals, CRM

- Account KPI reads posted+reversed lines; the 7-day work-queue badge
  counts only posted documents.
- Approvals render an empty state instead of a blank surface.
- Lead/prospect first save sends the party revision token; the lead
  owner picker uses the translated unassigned label.

### Payroll, assistant, allocations

- Stub register buckets and the overview setup checklist come from pack
  declarations; FICA carry-in splits into W-2 boxes 4 and 6.
- Assistant runs persist on the server across navigation and stick to
  the bottom with jump-to-latest.
- Period-sweep preview runs inline on the rule Test tab; empty
  dimension options guide the user and bad values speak user language.
- Deleted assistant threads stay deleted across chat switches; local
  blue/green rebuilds can override `NEXT_DIST_DIR`.
- Posted pay-run journal entries are visible on the journal; FX test
  warns when no currencies exist; an already-running agent scan explains
  the 409.
- Schedule editor mutations surface the server error; a blocked account
  save stays on a form-level alert; standalone checks require payee and
  funding bank.
- AR/AP dashboard tiles use the shared open-item reader; remittance
  pickers list org-wide vendors; lease add-charge is satisfiable;
  ownership create refuses a full-method write with a typed error.
- Data-io re-imports exported party kinds; PDF responses keep a strict
  CSP; pack-driven stubs re-resolve the open stub against live rows.
- Approvals center tabs read the same union worklist as the dashboard
  tile; API-key fingerprints stay stable across revoke; users accept
  last_sign_in sort; agent finding hrefs resolve through the nav
  registry; period lists show locked modules and book; journal Origin=All
  includes migration entries; document drawer post fails closed.

### Construction, AR, rates, and consolidation (batches 23–29)

- Rates-blocked banner on aging, registers, GL, journal, and workspaces;
  aging export uses the same as-of rule as the screen; consolidation
  refusals carry typed reason codes.
- AR never renders a sync source handle as the document number; CRM
  lead/prospect first save completes the draft; owner picker resolves
  the nested unassigned label.
- Allocations uncovered kinds answer empty instead of 404; new-rule
  setup is a guided wizard.

### Assets, payroll, i18n, drawers, search, expenses

- Depreciation extends a stale schedule before posting and surfaces run
  problems instead of failing silent; payroll posts one labeled burden
  debit per employer component and lists org-wide vendors.
- Inventory locations, BOM tabs, run funding, and the property workspace
  translate in every locale.
- Document title row wraps so the status pill never clips; AR-pulse
  hero amounts wrap on narrow screens; mobile search sits in the topbar;
  exact numbers bypass the search candidate cap and journal entries are
  indexed.
- Expense reports are editable via recall and correct; the vendor
  drawer Compliance tab assigns the class; funding-bank override
  persists on save.
- Approvals center binds assignee ids as a PostgreSQL array literal so a
  single user-assigned gate no longer 500s the page.

### Invites, close, agents, AI, and a11y (batches 30–35)

- Users can be invited with a set-password link and a pending state;
  the period drawer shows pending reopen requests.
- Agent tiles and status filters no longer depend on the current query;
  the shortcut legend documents a/d; team roles and banner dates
  translate; evidence kinds are labeled in en/fr/es.
- AI Test connection verifies the typed key; load-models errors stay
  structured. Saved list views and bank-feed disconnects confirm first;
  discard-draft on an app always confirms (F-t10-007).
- Open-aging built-ins count application-aware open lines; statement
  tables stay readable on a phone; cash cockpit, bank feeds, project
  billing, setup sidebar, and report filter presets translate.
- Drawer banners wrap at 390px instead of squeezing.

### Invites, remittance, banking, and tax (batches 36–39)

- Pending invites expose a one-time set-password link and resend;
  reset-request failures no longer claim the link is on its way; a blank
  company display name pins an inline required error.
- Remittance vendor listbox reads parties+vendor_roles; card-liability
  is offered when no card instruments exist; reconcile never swallows
  an unreadable error; KPI titles wrap and trend ticks stay thin.
- Failed flow runs can be retried; mark-as-filed refusals are typed in
  the filing drawer; delete-payment confirm resolves through the drawer
  scope.

### Invites, i18n, and cockpit (batches 40–41)

- CSRF treats localhost / 127.0.0.1 / [::1] as one origin so invite
  activation works across the fleet's loopback pair.
- Feature-toggle 409s map to localized copy; recent-entry status and
  line counts translate; opportunity status cells and filters use the
  drawer catalog; mobile tabs prefer short AR/AP labels.
- Stat tiles wrap instead of truncating; a retried flow parks the
  subject in pending_approval so the engine-enforced release can land.

### Budgets, reports, drawers, and search (batches 42–44)

- Draft budgets can be submitted, approved, and rejected with
  revision-guarded provenance so Pending approval / Approved are reachable.
- Report-schedule DELETE accepts a bodiless request; add-journal refusals
  stay as a dialog alert; the related-party overlay receives Compliance
  tab inputs.
- Exact journal-entry numbers resolve outside list origin/link scope;
  recurring cadence options translate in fr/es; setup wizard, go-live
  guide, api-keys, and the property buildings table copy backfill.

## [0.1.0-alpha.11] - 2026-09-16

UI and session-gate fixes on top of the self-deploy release. The
per-process database pool size is now configurable.

### UI

- Open receivables read the as-of book; the AR overdue subtitle takes a
  bare percent; recent journal widgets link through the posted-entry route.
- Approvals show loading/pending/empty states; document lines derive amount
  from quantity × unit price; project create activates the placeholder on
  a completing save.
- Customization form edits PATCH the member route, remount per session,
  confirm before deleting the org-default form, and expose visibility
  toggle pressed state.
- Banking fails closed at the root route error boundary; Business Central
  invoice numbers land as `documentNumber`; US state/local income-tax
  statutory slots are labeled.

### Platform

- The session gate fails closed per request with a request id.
- The per-process connection pool size is configurable.

## [0.1.0-alpha.10] - 2026-09-16

Integrity fixes on top of the allocations release, and production now
deploys itself from a version tag.

### Production release

- Pushing a `v*` tag publishes the attested image, then
  `deploy-production.yml` runs on the LAN runner: it executes
  `deploy/swarm-release.sh` over a dedicated forced-options ssh key
  (migrate first, then swap both service pins) and stays red until
  `/api/v1/health` reports the tag. Manual edge publishes never deploy.

### Integrity

- Period allocation runs refuse to post after the rule is deactivated or
  its published version is retired.
- Report-backed allocation drivers resolve features through the canonical
  feature path.
- A bank return supersedes a pending manual payment void and keeps its own
  evidence.
- Sync identity writes qualify the stored row on party-role conflicts, and
  evidence refresh matches lines by the stored `sourceLineRef`.
- Statement-format arithmetic goes through the engine money helpers;
  boolean custom-field list values extract as real booleans; workspace
  package edges that were imported undeclared are now declared.
- Posted journal lines cannot be re-homed onto another entry (0165).
- Optimistic-concurrency tokens advance a `revision_seq` counter on every
  update, independent of the editable `updated_at` display timestamp (0167).
- Retainage draws and releases settle in whole currency minor units and
  refuse a release that would invert draw/reversal posting order.
- Overhead published rates and preview share one exact decimal contract.

### Operator action

- Two additive forward migrations: `0165_jl_guard_original_parent_immutability`
  (replaces `jl_guard()`; no data rewrite) and
  `0167_document_revision_counter` (`revision_seq` column and bump trigger
  on revisioned tables; existing rows backfill 0). No other data changes.

## [0.1.0-alpha.9] - 2026-09-16

Setup polish for the allocations release, from testing alpha.8 in production.

### Allocations setup workspace

- Rules, Drivers, and Runs tabs now use the same composition as every other
  setup list: description plus one primary New/Preview action, the shared
  search toolbar with the show-inactive pill, and a table with a single
  "Nothing here yet." row when empty. The New rule and New driver actions are
  visible on an empty tenant.
- Drawers carry their primary action in the header like the shared setup
  drawer. The driver drawer gets its own Description field, per-source
  configuration (account scope, unit, measure, report), and the manual
  values grid inside the drawer after the driver is saved; loading states
  use the house skeleton.
- Rule drawer dimension filters render a proper none-state when a dimension
  has no values; all copy resolves from the catalog.

### Features page

- Sub-features nest under their parent (indented, secondary type, no icon)
  and stay hidden until the parent is on, with a quiet "N options once
  enabled" hint; category counts cover visible rows only. Applies to
  Projects, Flows, and Allocations children.

### Operator action

- No migrations. No data changes.

## [0.1.0-alpha.8] - 2026-09-16

Allocations release. One allocation kernel replaces three requests that used
to be separate products elsewhere (allocation schedules, distribution keys at
transaction entry, and a posting-time GL plug-in): a versioned, effective-dated
rule model bound at three moments, a driver registry, one exact apportionment
engine, and a lineage table that traces every allocated cent to its source
line, rule version, and driver value.

### Allocation kernel

- Rules are versioned and effective-dated; a published version is frozen and
  hashed, and every run and lineage row carries that hash. Applicability is
  per GL account (or account group) and per department, location, class,
  project, subsidiary, party, item, or custom segment, including untagged
  pools. Bases are fixed percentages, stepped tiers, or a driver; targets are
  explicit or dynamic (every active dimension value with weight). Impacts are
  reclass, net-zero pair (never changes an account total), or report-only.
- Drivers resolve from statistical journals (`journal_lines.quantity`), GL
  activity or balance, seven native measures (headcount, labor hours, billed
  hours, labor cost, revenue, direct cost, rentable area), effective-dated
  manual tables, or any saved report definition, run under the actor's own
  permissions; unavailable measures fail loudly instead of returning zeros.
- Entry mode: a bill, expense, or journal line that matches an automatic
  rule explodes on save into a stamped group of real lines (amounts exact,
  quantities proportional, tax recomputed per child); suggest rules offer a
  chip; a split dialog, group headers, un-split, and lock live in the line
  grid; imports and the records API accept `distributionKey`.
- Post mode: contributions land on the transaction's own journal entry,
  stamped with their contributor (`journal_lines.contributor_kind/ref`),
  balanced per contributor and per subsidiary, mirrored on void, written to
  secondary posting books as their own entries, and grouped in the GL impact
  drawer. A `custom_gl_lines` user-script trigger contributes lines the same
  way, with the kernel lines frozen.
- Period mode: preview, post, reverse, and re-run per rule, period, and book
  with one posted run per occurrence, an explain payload (sources, driver
  vector, shares, residual), re-run idempotency by fingerprint, scheduled
  occurrences through the durable outbox, a close automation action
  (`run_allocation`), and approval flows that hold a run pending until the
  flow approves.
- The overhead net-zero-pair writer is now a system-owned kernel rule derived
  from the overhead settings and rate card, proven byte-identical to the
  previous journal lines, with per-time-entry lineage.
- Setup → Allocations workspace (Rules, Drivers, Runs tabs with a
  four-tab rule drawer, driver values grid, run detail with lineage drill),
  Allocation summary and Allocation lineage reports, an in-app help article,
  six locale catalogs, seven read-only assistant/MCP tools, and an
  internal-controls evidence set (seven cases) published beside the trust
  corpus.

### Assistant, agents, and setup

- Chat threads appear in the sidebar instantly, page long histories, get short
  generated titles, and forward finding handoffs; page headers wrap actions
  under the title on phones.
- Agents overview, library, policy pages, activity, inbox, proposals, and
  briefings are rebuilt on the shared setup and table components.
- Analytics sentences are localizable; source-evidenced bank sign-offs count
  as reconciled for close readiness; JPY/KWD are pinned end to end.

### Operator action

- Five additive migrations (0160–0164) run automatically before the new code
  serves. No posted history is reinterpreted; the dormant planning-era
  allocation tables are replaced only if empty (they are, on every install).
- Re-run `engine/src/seed-roles.ts` after upgrading: built-in roles gain the
  `allocations.read/manage/run/approve` grants (roles are snapshots).
- The `allocations` feature defaults off. Enable it, and the entry and
  posting sub-features, under Company Settings → Features.
- Posting a document under a rule whose driver is a saved report requires the
  posting actor to hold `reports.read` (fail-closed by design).

## [0.1.0-alpha.7] - 2026-09-16

Assistant and agents release. A live benchmark of the in-app assistant on a
real ledger (three models, graded against tool output) showed nearly every
lost point was a tool-surface gap; two agent fleets closed those gaps, made
the model's context proportional to the question, generalised the
background-agent runtime, and gave agent work a home in the product.
Everything the assistant and MCP clients can do reuses the same services,
permission gates, subsidiary scoping, and feature switches as the screens.

### Assistant and MCP

- One capability catalog for chat and `/mcp`: read tools across ledger,
  reporting, banking, payroll, tax, projects (portfolio ranking), inventory,
  orders, fixed assets, equipment, subcontracts and WIP, CRM, subscriptions,
  property, time, expenses, close and periods, FX, budgets, files, data-io,
  sync, environments, PDF templates, reporting deliveries, and admin reads
  (secrets never leave the server). Governed commands with a review card and
  idempotency key: settings, feature switches, setup records, journal post,
  bank reconciliation actions, FX revaluation, budget cells, file upload.
- Tools of disabled modules are hidden from the model, MCP, and the close
  agents; the system prompt states the org's module switchboard; every tool
  declares its feature key, and parity tests pin feature, permission,
  subsidiary scoping, and chat/MCP visibility.
- Context proportional to the question: a 24-tool core is always on,
  `find_tools` activates a module's tools mid-turn, a pre-router pre-activates
  modules from the message, tool results are compacted for the model (full
  results still stream and persist), older turns become summaries, a rolling
  conversation summary with resolved entities persists per conversation
  (migration 0152), pronouns resolve from pinned entities, and step budgets
  adapt. A typical turn now sends roughly 6k–13k tokens of tool definitions
  instead of 45k.
- Turns can no longer end silently: the last permitted step must answer, and
  a turn that produced no prose gets a visible fallback. Engine domain errors
  reach the model as actionable messages instead of `tool_failed`.
- Strict provider compatibility: every tool schema is linted for RE2-safe
  patterns, described properties, and bounded sizes (an unescaped bracket
  had made one provider reject the whole catalog); a contract harness runs
  every read tool against a scratch org under a size budget.
- App packages declare their own assistant/MCP tools (`tools[]` in the
  manifest with validated JSON-schema inputs and install-time contract
  checks); they run through the app runtime with governance evidence and use
  the same confirmation path as built-in mutations.
- `describe_capabilities` answers "what can you do" from the live catalog.

### Agents

- The continuous-close runtime is a registry of agent packs: accounting,
  finance, collections, payables, reconciliation, data hygiene, forensics,
  tax readiness, payroll compliance, project margin, and cash alerts
  (migrations 0151 and 0155 widen the agent-key constraints). Packs read and
  propose; nothing runs a write without a confirmed review card.
- Agents are a first-party Setup category: overview with enable switches and
  run-now, a library, per-pack policy pages with detector controls and
  notification routing (migration 0154), and an activity log. `/admin/ai`
  is provider configuration only.
- Agent Workbench at `/agents`: a ranked inbox with keyboard and bulk triage,
  a proposals lane rendering the same review cards as chat, a cached morning
  briefing with email send, ask-about-this handoff into chat, assignment with
  due dates and notes (migration 0153), and a dashboard tile.

### Connectors, banking, assets, currencies

- Connectors mirror cleared markers and party merges/holds and carry source
  reconciliation evidence on every mirror run; a source-evidenced sign-off
  engine can close reconciliations from that evidence (migration 0158).
- Fixed assets and lessee schedules continue from opening balances
  (migration 0156); the fixed-asset register import carries openings in.
- The currency registry is the full active ISO 4217 list, backfilled for
  existing tenants (migration 0157), with localized picker labels.
- Analytics sentences, sentinel forensics, ratio definitions, and health
  findings are localizable; sentinel duplicate groups and per-currency stats
  corrected; close readiness ignores non-posting order kinds.

### Operator action

- Eight additive migrations (0151–0158) run automatically before the new
  code serves. No data is reinterpreted.
- Agent packs beyond accounting and finance are off until enabled under
  Setup → Agents; the `continuousClose` feature still gates the runtime.
- The MCP endpoint requires the `apiAccess` and `mcpAccess` features and an
  API key; provider model lists are cached for ten minutes.

## [0.1.0-alpha.6] - 2026-09-15

Defect-remediation release: ~300 atomic fixes from a third audit fleet
(persona attacks, real-data replay, mutation survivors, standards
conformance, boundary sweeps), each with a red-then-green regression test
and an independent review. Highlights below; every commit carries its own
defect / root cause / fix / verification record.

### Integrations

- Chargebee settlement imports now receipt what was actually collected.
  `amount_paid` is the booked receipt, `amount_adjusted` posts as its own
  adjustment line against the customer (carrying the provider's reason when
  the export surfaces one) instead of being silently dropped, and the import
  refuses to post when the provider total does not foot to amount paid plus
  adjustments plus applied credits — naming the invoice rather than booking
  an unreconciled receipt. Adjustments are tracked apart from refunds in
  batch totals and post as their own clearing line. Schema gains
  `psp_settlement_batches.adjustment_amount` and the `adjustment` settlement
  line kind (migration 0144, additive).

### Scheduler topology

- Scheduled work now runs in the worker process only (`npm run worker`, the
  `worker` Compose service / worker Deployment). The web process no longer
  starts the scheduler unless `OPENBOOKS_RUN_SCHEDULER=1` is set explicitly
  (single-process installs), and never under `next dev`
  (`OPENBOOKS_RUN_SCHEDULER=force` is the only development override). Each
  process logs one `[scheduler]` line at boot stating which mode it is in.
  Concurrent worker replicas still run each tick once via the existing
  Postgres claim lock. No job semantics changed.

### Analytics

- Analytics: True Cost dashboard restored as a hub dashboard; the report
  remains at /reports/true-cost.

### Operator action

- Scheduler topology: multi-process deployments take no action — keep the
  worker service running (it already runs in `compose.yaml` and the HA
  reference). Single-process installs that run web without a worker: set
  `OPENBOOKS_RUN_SCHEDULER=1` on web.

### Ledger and close

- Posted journal entries can no longer be flipped back to draft through the
  kernel guard (migration 0146, `je_guard` v3: posted exits only to
  reversed). Tax amounts without calculation evidence fail closed instead of
  silently dropping at posting. Account-parent cycles no longer hang every
  statement. Direct inventory postings stamp the GL location dimension.
- Close readiness scopes the posting-period check to the run period, goes red
  on unrecognized deferred revenue, and re-publishing after a reopen versions
  the binder (original retained, restatement note required). Consolidation,
  elimination, lease, asset and FX-revaluation writes into closed periods
  refuse with named errors instead of raw storage failures. Depreciation
  catches up skipped months and allocates 4-4-5 calendars; secondary books
  revalue; asset disposal refuses while a begun stub period is unposted.
- New admin remediation paths: bulk assign-posting-period from the readiness
  blocker, and duplicate-project detection with an audited merge.

### Cash, receivables and payables

- Open items net unapplied credit memos (cash forecast, cash position,
  vitals and assistant tools now tie to aging to the cent); as-of agings and
  forecasts reconstruct settlement timing instead of reading live balances;
  day-90 items age into the 90+ bucket; quiet parties keep their balance on
  statements. Consolidated open items, bank balances, cockpit tiles and the
  analytics hubs translate every functional currency to the presentation
  currency at the correct spot and fail closed on missing rates.
- Ad-hoc vendor payments honour subcontractor compliance blocks. Early-payment
  discounts round to the bill currency's minor units. Refund-first PSP
  webhooks park as pending clawbacks and settle exactly once (migration
  0149). Void versus application races no longer deadlock.

### Tax, payroll and standards

- GST34 packs installed by the pre-split seed are healed to the collected /
  paid / taxable bases (migration 0147; a real tenant filed net tax at double
  the true amount). Codeless source tax is refused upstream with the source
  reference. The payroll remittance summary survives a run with an unknown
  filing account and statutory payable remappings return a typed warning.
- Conformance matrix republished at 75 passing cases and 15 declared gaps
  (partial disposal, intercompany asset transfer, lease early termination,
  4-4-5 depreciation, partial disassembly, loss of control, …).

### Integrity, contracts and concurrency

- Reference ownership is fenced on every write path (records API, documents
  and lines, journals, expenses, items, parties, assets, timesheets, rate
  cards, property, custom records, scripts, Flows actions and imports):
  foreign-org ids are refused with tenant-opaque 404s instead of storage
  errors. Dozens of routes refuse magnitudes wider than their numeric columns
  and dates that are not real calendar days with typed 4xx responses.
- Revision tokens on prebill lines, AP-capture reviews, custom records and
  opportunities; compare-and-swap on percent-complete overrides; sorted
  advisory locks for inventory reversals; repeatable-read sandbox clones with
  per-sandbox refresh serialization; sandboxes holding posted documents can
  be created, refreshed and deleted (migration 0148). Audit rows now carry
  actor and before/after for the v1 writer, imports, Flows mutations,
  pay-run commits and mirror-posted documents.
- The approvals worklist and the pending-approvals count unify Flows gates,
  document-status approvals and pay runs. KPI definitions are single-sourced
  (DSO across all six surfaces). Paginated lists carry a unique tiebreaker and
  malformed filters fail closed to empty. Budget vs actual and the dashboard
  cash tile bind to the resolved period.

### Imports and integrations

- Every registered data resource round-trips export → import into a fresh
  org and re-imports idempotently (matrix test committed). Settlement links
  state their currency on all six connectors and the reconciler converts or
  refuses. Source subsidiary functional-currency changes are held for review.
  The QuickBooks Desktop Web Connector SOAP route is reachable through the
  edge and password guessing is bounded.

### Dashboard

- Saving Quick Actions on a never-customized dashboard no longer wipes the
  widget grid; malformed or empty stored layouts fall back to the default and
  self-heal on the next view. The greeting follows the viewer's clock.
- Performance: the indirect cash flow's outer scans are bounded by the window
  (138 s → ~10 s on a multi-million-line tenant); capped detail exports
  disclose the cap in every format.

### Operator action

- Migrations 0146–0149 apply automatically on deploy (forward-only,
  idempotent). 0147 rewrites installed CA_GST34 pack rows for lines 101 /
  103 / 106 on every org that installed the pre-split seed; re-run affected
  returns after upgrading.

## [0.1.0-alpha.5] - 2026-09-15

A hardening release. A multi-agent audit read the engine, API, and application
layers end to end and shipped about 350 atomic defect fixes, each with a
regression test that failed before the fix and passes after it. No feature
work is included. Operator action: none beyond the normal migration step; the
three payroll migrations below are additive.

### Financial integrity

- Posting: source corrections can no longer over-apply live settlements;
  negative-total credit memos and vendor credits are refused at the posting
  boundary; FX spot lookups break direct/inverse ties deterministically; line
  accounts and parties are checked against the tenant and subsidiary before
  any write; the vendor-payment "total is the cash amount" contract is pinned.
- Payments and receipts: allocation totals use exact money everywhere the UI
  or engine summed them; provider over-collection stays on account instead of
  being dropped; early-payment discounts are vendor-only; settlement evidence
  is scoped to the run's bank account; CPA-005, NACHA and SEPA writers refuse
  blank, oversized or checksum-invalid account and creditor identifiers.
- Banking: Plaid pending authorizations are no longer imported as statement
  truth; GoCardless and CAMT.053 lines are keyed by provider-unique ids;
  inactive reconciliation rules cannot be applied; SFTP statements are parsed
  from exact bytes.
- Payroll: signed stub lines net the deduction-protection base; WCB and
  employer QPIP caps consume committed stubs only; staleness watches pay
  schedules, statutory rates and union fringes; US state withholding engines
  receive YTD supplemental wages and current federal tax; RL-1 slips carry
  opening YTD; Quebec-only remittances use the Revenu Quebec calendar; SINs
  are Luhn-checked on T4/RL-1 transmission; bank-file generation re-verifies
  approval inside its transaction; opening balances now carry second-order YTD
  history and capped employer levies (migrations 0141 and 0143); retro
  readiness compares against a persisted quantification snapshot (0142).
- Tax: taxable-base return boxes convert at the posted FX rate; MACRS pool
  runs refuse short-year factors; nexus rates compare at ledger scale;
  provision reconciliation percents round half away from zero; filing boxes
  keep exact decimals; 1099 thresholds and box rules follow the IRS
  instructions (fishing boat proceeds, OBBBA 2026 threshold, corporate boxes).
- Consolidation and FX: proportionate interests are eliminated; source-to-
  elimination rate pairs are derived; test FX syncs no longer move the
  production schedule cursor.
- Reports and analytics: quarter breakouts follow the organization's fiscal
  start month; cash-basis drill-downs tie to settlement-share recognition;
  utilization and true-cost bases count approved time only; project margins
  scale identically in tables and exports; CSV exports keep exact decimals;
  cockpit tiles are scoped to the primary book and visible subsidiaries and
  translate mixed-currency totals.

### Isolation, authorization, and audit

- Subsidiary scope is enforced on budgets, journals, timesheets, approvals,
  flows, custom records, file-cabinet folders, parties, assistant and MCP
  tools, payroll run populations, and every module cockpit that read past it.
- Feature gates for field tickets, WIP billing, work breakdown and project
  scheduling are enforced in services, not only in navigation.
- Configuration saves (close policy, automation, calendars, reporting
  packages, sandbox schedules), timesheet decisions, and approval gate
  decisions write actor-attributed before/after audit evidence.
- Sealed tax identifiers are omitted from directory payloads; sandbox clones
  scrub masked custom data and users and rebuild derived aggregates.

### API contracts

- Malformed ids answer 404 on every verb instead of surfacing database errors;
  PATCH and DELETE validate what POST validates (dates, booleans, enums,
  referenced ids, custom fields on partial updates); document edits and voids
  carry the exact revision token so stale writes are refused.

### Sync

- Open-item verification compares expense reports alongside invoices, bills
  and credits (the NetSuite mirror had failed the financial gate on a clean
  ledger since the previous release); QuickBooks report dates are normalized
  at the adapter boundary; realized-FX groups get their own entry numbers;
  master-data upserts type their JSON parameters; tax-rate mirrors touch only
  the open current window.

### Test infrastructure

- Test fixtures refuse databases that do not carry the ephemeral marker, so a
  stray test run cannot write to a real database.

### Payroll

- Remittance bills for Revenu Québec destinations are now due on Revenu
  Québec's own timetable. The Canada pack declares the RQ schedule
  (quarterly, monthly, or twice-monthly by average monthly remittance, per
  Guide TP-1015.G and form TPZ-1015.R): Québec income tax, QPP, and QPIP bills
  carry RQ due dates and rules instead of inheriting the filing account's CRA
  remitter type, which previously stamped CRA accelerated-threshold dates on
  RQ bills. Set the frequency from your Revenu Québec notice under Setup →
  Payroll (new employers remit monthly, the default); Setup readiness warns
  while it is unconfirmed and when last year's average points at another band.

## [0.1.0-alpha.4] - 2026-08-20

### Time and timesheets

- Timesheet weeks have a lifecycle. Approved time stays read-only, but a week
  can be reopened while nothing downstream has consumed its hours; the reasons
  it cannot be (invoiced, paid, costed) are named rather than implied. Weeks
  carry their own record, with rejection reasons and amendment links.
- Whether hours require approval before they can be billed or paid is now
  organization policy rather than an assumption, and approval routing runs
  through flows, so approver, order, and quorum are configuration.

### Payments

- Fixed: the NACHA and SEPA direct-debit writers accepted a half-configured
  originator. They checked only that each required field was non-empty, while
  the credit rails additionally reject unfinished `FILL-ME` placeholders and an
  ODFI routing number that is not exactly nine digits. Because the writer
  slices that number to eight characters, an over-long value produced a
  well-formed file addressed to the wrong originating institution. Both debit
  rails now parse their originator to the same standard as the credit rails.

### Integrations

- NetSuite accounts can map their own job billing types instead of inheriting a
  single tenant-wide convention.

### Internal

- Raw SQL now carries its row type as a type argument (`db.execute<Row>(…)`)
  instead of asserting the shape back afterwards. 2,381 laundering casts across
  504 files were removed, along with a dozen ad-hoc "anything with `.execute`"
  parameter types that discarded the row type at the boundary; they share one
  `SqlExecutor` seam. Type-level only — no runtime behaviour changed.

### Operator action

- None. The schema gains `timesheet_weeks` plus two nullable columns on time
  entries; existing weeks derive their state on first use.

## [0.1.0-alpha.3] - 2026-08-04

The first public community preview of OpenBooks.

### Accounting and operations

- PostgreSQL-enforced double-entry ledger, exact decimal money arithmetic,
  periods and close controls, audit evidence, receivables, payables, payments,
  banking, reconciliation, budgets, tax workpapers, and income-tax provisions
- Multi-currency, multi-book, multi-subsidiary, intercompany, consolidation,
  eliminations, non-controlling interest, and goodwill configuration
- Inventory costing and reconciliation, fixed assets and tax pools, project
  accounting, time and job costing, construction progress billing, retainage,
  change orders, and project revenue recognition
- Configurable transaction approvals and workflows, reports and analytics,
  saved searches, exports, custom fields and records, scripts, apps, API keys,
  backups, sandboxes, and optional AI assistance

### First-run experience

- Adaptive company setup that uses industry, size, entity structure, currency,
  operational complexity, and control requirements to shape the workspace
- Three progressive operating profiles—Essentials, Growing, and Advanced—with
  authoritative feature gates that remain fully adjustable in Company Settings
- Go-live readiness guidance from company identity and fiscal calendar through
  opening balances, controls, and first month-end close
- RLS-isolated industry sample-company imports for evaluation and training
- Maintained country tax packs for Canada, the United States, Australia, New
  Zealand, the United Kingdom, Germany, France, Spain, Italy, the Netherlands,
  Ireland, Singapore, India, South Africa, the UAE, and Japan

### Data, integrations, and platform

- Generic migration and mirror framework with adapter-scoped source identities
  for NetSuite, QuickBooks, Xero, ERPNext, Odoo, and Microsoft Dynamics
- Governed tenant-scoped query console with schema browsing, contextual table
  actions, and access only through reviewed reporting views
- Platform controls for apps, scripts, API documentation and keys, MCP, query
  tools, workflows, sandboxes, and AI features
- English, French, Spanish, German, Brazilian Portuguese, Chinese, and Japanese
  locale catalogs

### Deployment, security, and integrity

- One-command Docker Compose installation using separate database-owner and
  constrained runtime roles, generated secrets, health checks, MinIO, Redis,
  web, worker, and migration-first startup
- Multi-platform GHCR image built once, scanned at the exact digest, retagged
  without rebuilding, and published with provenance attestation
- One audited canonical PostgreSQL baseline for clean installations, plus
  release tests for row-level security, source identity, setup provisioning,
  accounting invariants, and documented claims
- Production startup rejection of database roles that can bypass tenant RLS;
  tenant context is enforced across APIs, integrations, scripts, query tools,
  and background jobs
- Product-neutrality, history-hygiene, secret, dependency, container, and
  workflow checks in the release and security pipelines

### Known limitations

- This is alpha software and has not completed an independent accounting audit,
  security audit, or broad production validation. Start with test or parallel
  books and reconcile all opening balances, tax treatment, permissions,
  reports, backups, and jurisdiction-specific requirements.
- Country packs provide maintained configuration, workpapers, and exports; they
  are not universal electronic-filing certification or professional tax advice.
- The included Compose deployment is a single-host installation. A separate HA
  application-tier reference is provided, but operators remain responsible for
  production-grade database, cache, object-storage, ingress, monitoring,
  backup, and recovery infrastructure.

### Operator action

- Fresh installations bootstrap directly from the canonical baseline.
- Keep the generated `.env.compose` file secure and back it up; it contains the
  first administrator login and deployment secrets.
- Before using OpenBooks as a system of record, complete a restore rehearsal and
  the validation steps in the upgrade and backup runbooks.

[0.1.0-alpha.4]: https://github.com/braedonsaunders/openbooks/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/braedonsaunders/openbooks/releases/tag/v0.1.0-alpha.3
