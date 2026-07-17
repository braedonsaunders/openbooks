# The Goal

**Build the best open-source accounting suite in existence, and prove it by
running a real $23M/yr company on it — then cancel the $120,000/yr NetSuite
contract with receipts.**

Two outcomes, one codebase:

1. **Escape** — Rassaun runs month-end close entirely in openbooks, the
   parallel-run trial balance stays green through a close, NetSuite goes
   read-only, the contract dies.
2. **Product** — a general-purpose, MIT-licensed suite anyone can self-host:
   NetSuite-class capability (GL kernel, subledgers, dimensions, approvals,
   real-JS scripting, real-SQL reporting) with none of the ransom. One-click
   migration *in*, and — unlike every incumbent — trivial migration *out*.

Non-negotiables (standing rules):
- **No account-shaped shortcuts.** Rassaun's usage prioritizes UX order,
  never schema/feature scope.
- **Vendor-neutral product.** No hardcoded vendors/orgs in UI; adapters and
  data carry identity.
- **Kernel discipline.** Balanced-by-construction, append-only, posted =
  immutable. Postgres enforces it, not app code.
- **Real tools, not sanitized brands.** User scripting is real JavaScript;
  the query language is real SQL.

## Milestones

### M0 — Kernel + proof ✅ (2026-07-14)
79-table schema on the HA cluster; posting engine; QuickJS scripting; SQL
API; web shell; manual sync bridge; **full 8-year GL replayed, 262/262
accounts match NetSuite exactly**.

### M1 — Read parity: "never open NetSuite just to LOOK at something"
- [x] Financial statements: trial balance, P&L (period ranges, FY presets),
      balance sheet (as-of, computed retained earnings) *(2026-07-14)*
- [x] AR/AP position by party *(2026-07-14)*
- [x] Statement layouts as data: group/subtotal/formula rows, first-match
      account claiming, automatic Other catch-all; "Contractor P&L" seeded
      and cross-foots with the default statement *(2026-07-14)*
- [x] Dimension filters (department/project) on P&L + trial balance *(2026-07-14)*
- [x] Account register drill-down (account → entries → document) *(2026-07-14)*
- [x] Auth: users, scrypt, signed-cookie sessions, middleware gate, login,
      roles enum *(2026-07-14 — role-based permissions still to enforce)*
- [x] Saved report views *(2026-07-14)*
- [ ] Scheduled report email delivery
- [x] P&L comparatives (vs prior year, Δ and Δ% — FY26 shows −24.7%
      revenue, matching the owner analysis) *(2026-07-14)*

### M2 — AP goes live: the first workflow leaves NetSuite
- [x] Vendor bill entry: line editor, GST/HST tax codes with dated rates,
      auto-numbering, draft lifecycle *(2026-07-14 — dimensions + file
      attachments on lines still to add)*
- [x] Approval engine live: policies → requests/steps, amount-threshold
      routing, role worklists, approve/reject with notes; full lifecycle
      verified draft → submit → approve → post (correct AP + ITC entry)
      *(2026-07-14 — per-person assignees + email nudges still to add)*
- [x] Payment runs → Canadian EFT (CPA-005) file export *(2026-07-14 —
      remittance emails still to add; needs a worker)*
- [x] Expense reports: instant-draft flyout, line grid, approval, posting to
      employee payable *(2026-07-14 — receipt capture/attachments to add)*
- [x] Payment application UI: open-item selection, apply amounts, post
      atomically w/ auto-reversal safety net *(2026-07-14, live-verified)*
- [ ] Dual-entry period: AP entered in openbooks, mirrored to NS until trust

### M3 — AR + projects: the revenue side
- [x] Customer invoices: instant-draft flyout, line grid, approval, posting
      (DR AR / CR income + tax) *(2026-07-14, live-verified)*
- [ ] Invoice PDF rendering (their 27 Calibri templates as data)
- [x] Payment application (any crediting doc → any open item) — receipts
      apply to invoices, open balance clears *(2026-07-14, live-verified)*
- [ ] Project costing views (Account × Project, WIP, estimate-vs-actual)
- [ ] Sales orders / quotes (bidwright hookup point)

### M4 — Close the books in openbooks
- [x] Bank reconciliation: OFX/CSV import → dedupe → auto-match → two-pane
      workspace → zero-difference sign-off *(2026-07-14)*
- [ ] GST/HST return (tax report lines → GST34 numbers)
- [ ] Fixed assets + depreciation runs (replace the locked FAM bundle)
- [ ] Payroll journal import + labor burden runs (Paymate bridge)
- [x] Period close operating system: Setup owns fiscal calendars, generated
      periods, book/entity/module locks, versioned dependency blueprints,
      policies, event automation, reporting packages, and controlled expiring
      reopen approvals; Banking owns the live readiness → execute → review →
      lock → publish wizard with evidence, continuous invalidation, independent
      sign-off, and hash-addressed audit binders. The kernel enforces scoped
      closed-period posting refusal *(2026-07-16)*
- [ ] One full month closed in parallel, TB green the whole way

### Platform (NetSuite-parity foundations, built 2026-07-14)
- [x] RBAC: roles, permission catalogue w/ wildcards, per-user overrides,
      admin Users/Roles UI, gates on every mutation
- [x] Custom fields: header + line, any module, server-validated
- [x] Custom record types: NetSuite-custrecord equivalent — builder +
      auto-generated modules + dynamic sidebar
- [x] Sidebar customization (/admin/navigation), user scripting admin
      (real JS), audit log viewer, parties directory
- [x] Insights (BHQL card studio) + custom reports engine *(2026-07-15)*
- [x] Reports: first-class PDF (pure-JS pdfkit engine), Excel (ExcelJS) + CSV
      export for the financial statements and custom reports; drillable
      statements (account lines carry the period into the register);
      per-report PDF page setup (paper/orientation/density/margins) *(2026-07-15)*
- [x] Saved Searches (NetSuite Saved Search analogue) — Knowledge menu: named,
      shareable queries over the ledger/documents/parties/accounts catalog
      (detail rows or grouped summaries), builder flyout, live preview, export *(2026-07-15)*

### M5 — Cutover
- [ ] NetSuite → read-only; openbooks system of record
- [ ] 90 days stable · then **cancel the contract** 🎯

### M6 — Product
- [ ] Multi-org auth + Postgres RLS enforced
- [ ] One-click migration UI (full-migration mode of the adapter registry;
      QuickBooks + Xero adapters)
- [ ] Docs site, public repo, install story (docker compose)
- [ ] First outside company running openbooks

## Scoreboard

| Metric | Now | Target |
|---|---|---|
| TB parity vs source | 262/262 | green streak through a month-end close |
| Workflows live in openbooks | AP · AR · payments · expenses · journals · banking · close | AP → AR → close ✅ |
| NetSuite spend | $120k/yr | $0 |
| Companies on openbooks | 0 (1 mirrored) | 2+ |

**Standing directive: when in doubt, pick the next unchecked box and build it.**
