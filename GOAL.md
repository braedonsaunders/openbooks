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
- [ ] Financial statements: trial balance, P&L (period ranges, comparatives),
      balance sheet (as-of, computed retained earnings)
- [ ] AR/AP position by party
- [ ] Statement layouts as data (custom P&L groupings — the 25 NS layouts)
- [ ] Dimension filters (department/project) on every report
- [ ] Account register drill-down (account → entries → document)
- [ ] Auth (single-org, sessions, roles seeded from the 23 NS roles)
- [ ] Saved reports + scheduled email delivery

### M2 — AP goes live: the first workflow leaves NetSuite
- [ ] Vendor bill entry (line editor, tax codes, dimensions, files)
- [ ] Approval engine live (policies → worklists; the Kara/Kevin/Melissa flows)
- [ ] Payment runs → Canadian EFT (CPA-005) file export + remittance emails
- [ ] Expense reports (mobile-friendly entry, receipt capture)
- [ ] Vendor statements / open-item views (payment application UI)
- [ ] Dual-entry period: AP entered in openbooks, mirrored to NS until trust

### M3 — AR + projects: the revenue side
- [ ] Customer invoices (T&M chains: time entries → billable → invoice)
- [ ] Invoice PDF rendering (their 27 Calibri templates as data)
- [ ] Payment application (any crediting doc → any open item)
- [ ] Project costing views (Account × Project, WIP, estimate-vs-actual)
- [ ] Sales orders / quotes (bidwright hookup point)

### M4 — Close the books in openbooks
- [ ] Bank reconciliation (statement import + matching)
- [ ] GST/HST return (tax report lines → GST34 numbers)
- [ ] Fixed assets + depreciation runs (replace the locked FAM bundle)
- [ ] Payroll journal import + labor burden runs (Paymate bridge)
- [ ] Period close checklist + module locks
- [ ] One full month closed in parallel, TB green the whole way

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
| Workflows live in openbooks | 0 | AP → AR → close |
| NetSuite spend | $120k/yr | $0 |
| Companies on openbooks | 0 (1 mirrored) | 2+ |

**Standing directive: when in doubt, pick the next unchecked box and build it.**
