<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/openbooks-logo-dark.svg" />
    <img src=".github/assets/openbooks-logo.svg" alt="openbooks" width="440" />
  </picture>
</p>

<p align="center">
  <img src=".github/codeflow-card.svg" alt="CodeFlow card — codebase scale and structure snapshot" width="100%" />
</p>

<p align="center">
  <strong>The open business suite. Run on open books.</strong><br />
  An open-source ERP built on a double-entry general-ledger kernel: dimensions,
  subledgers, multi-entity, multi-currency, period close, real-JavaScript
  scripting, and a real-SQL reporting engine — with an open schema you can always
  get your data out of.
</p>

<p align="center">
  <a href="#what-is-openbooks">What</a> ·
  <a href="#why-openbooks-is-different">Why</a> ·
  <a href="#features">Features</a> ·
  <a href="#the-kernel">The Kernel</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#quick-start">Quick start</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL v3" src="https://img.shields.io/badge/License-AGPL_v3-0f766e" /></a>
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-16-000?logo=next.js&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white" />
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white" />
  <img alt="Drizzle" src="https://img.shields.io/badge/Drizzle-ORM-C5F74F?logo=drizzle&logoColor=black" />
  <a href="https://github.com/braedonsaunders/openbooks/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/braedonsaunders/openbooks?style=flat&color=f5a623" /></a>
</p>

---

## What is openbooks?

openbooks is an open-source business suite with the discipline of a real
accounting system at its core: a **double-entry general-ledger kernel** where
every posted entry balances to zero, closed-period rows are immutable, and
controlled open-period amendments preserve immutable before/after document and
GL-impact evidence — invariants enforced by **PostgreSQL triggers**, not by
hopeful application code.

On top of that kernel sit the workflows a company actually runs on — payables,
receivables, payments, expenses, banking, period close — plus an app-builder,
real-JavaScript scripting, and a real-SQL reporting surface that make it
extensible without a proprietary DSL in sight.

openbooks is AGPL-3.0-licensed — **self-host it, extend it, or run your whole
back office on it.** The copyleft is deliberate: improvements stay open, and
anyone who offers it as a hosted service has to share their changes.

## Why openbooks is different

- **A kernel, not a spreadsheet with steps.** Documents are strictly separated
  from their ledger projection. Posting produces exactly one journal entry;
  authorized edits in an open period re-materialize that entry in place and
  atomically record its old/new business and GL state. Closed-period impact is
  immutable, and the database physically refuses unbalanced entries.
- **Real tools, not sanitized brands.** User scripting is **real JavaScript** in
  a QuickJS sandbox. The query surface is **real PostgreSQL** through a
  SELECT-only role. No invented mini-language you have to relearn.
- **Reporting as data.** Financial statements are layouts — group / subtotal /
  formula rows, first-match account claiming, an automatic catch-all — that
  render to first-class **PDF** (pure-JS, no Chromium), **Excel**, and **CSV**,
  and every account line drills straight into its register.
- **Your data stays yours.** A source-adapter registry can pull a full ledger
  in, and the SQL surface plus open schema make getting your data back out
  straightforward. No lock-in by design.
- **Vendor-neutral by construction.** No hardcoded org or vendor names in the
  product — identity comes from the database and the adapter registry, so the
  same build runs anyone's books.
- **Internationalized to the last string.** Every user-facing string flows
  through next-intl in **English, French, Spanish, German, Brazilian Portuguese,
  Chinese, and Japanese** — copy, placeholders, aria-labels, toasts, and empty
  states. Locale selection is available per tenant and per user.

## Features

Every module is permission-aware, audited, and org-scoped. The sidebar itself is
editable per tenant — modules are **registered, not hard-coded** — and every list
ships with search, filters, and pagination as a non-negotiable.

### Payables & spend

- **Vendor bills** — line editor, tax codes with dated rates,
  auto-numbering, draft → submit → approve → post lifecycle.
- **Purchase orders**, **expense reports** (instant-draft flyout → line grid →
  approval → posting to employee payable), and an **approval engine** with
  policy-driven amount-threshold routing, role worklists, and approve/reject.
- **Payment runs** → Canadian **EFT (CPA-005)** file export, with atomic
  open-item payment application and an auto-reversal safety net.

### Receivables & revenue

- **Customer invoices** — instant-draft flyout, line grid, approval, posting
  (DR AR / CR income + tax).
- **Estimates & sales orders**, **receipts**, and **payment application** from any
  crediting document to any open item — open balances clear atomically.

### Banking & close

- **Bank reconciliation** — OFX/CSV import → dedupe → auto-match → two-pane
  workspace → zero-difference sign-off, with reusable **reconciliation rules**
  and SFTP statement drops.
- **Journal entries**, a **chart of accounts** with dimensions
  (department / project), and **period close** — per-module AR/AP/GL close and
  reopen with ordering rules; the kernel refuses to post into a closed period.

### Insight

- **Financial statements** — trial balance, P&L (period ranges, FY presets,
  prior-year comparatives with Δ / Δ%), balance sheet (as-of, computed retained
  earnings), AR/AP position by party — all **drillable to the register**.
- **Reports** — a report library plus a custom report builder, exported to
  **PDF / Excel / CSV** with per-report page setup, and saved report views.
- **Analytics** — a native BI hub, **Insights** (a BHQL card studio), and
  **Saved Searches** — named, shareable queries over the ledger, documents,
  parties, and accounts.
- **SQL** — an ad-hoc query surface over a read-only role, and a **Documents**
  file cabinet.

### Platform

- **RBAC** — roles, a permission catalogue with wildcards, per-user overrides,
  admin Users/Roles UI, and a permission gate on every mutation.
- **App builder** — custom fields (header + line, any module), **custom record
  types** (auto-generated modules + dynamic sidebar), and a forms engine.
- **User scripting** (real JavaScript, QuickJS sandbox), **navigation
  customization**, an append-only **audit log** (including complete old/new
  document and GL snapshots for posted amendments and deletion tombstones),
  **API keys**, and a **data import/export** adapter registry.

## The Kernel

The general-ledger kernel is the part you can't fake, so openbooks doesn't.

- **Balanced by construction.** A Postgres trigger rejects any journal entry
  whose lines don't sum to zero. There is no code path that writes an unbalanced
  entry — not an admin override, not a migration.
- **Audited open-period amendments.** Posted transactions are locked by default,
  but the engine may re-materialize or delete them while every affected scope is
  open and dependency checks pass. The same transaction stores immutable old/new
  document and GL snapshots; closed-period corrections use controlled reopening
  or reversals (`reverses_entry_id`).
- **Money is exact.** Amounts are `numeric(19,4)` and computed with BigInt units
  (`engine/src/money.ts`) — never floats, never rounding drift, handles
  scientific notation.
- **Guardrails in the database.** No posting to summary or inactive accounts, no
  posting into a closed period, application caps enforced — all in
  `schema/migrations/kernel-constraints.sql`. The amendment GUC is engine-only
  and transaction-scoped; the separate migration-mode GUC exists only for
  historical replays.

## Architecture

openbooks is an npm-workspaces monorepo: a Next.js app over a shared schema, a
posting engine, and a set of focused packages.

```
schema/     Drizzle schema (one domain per file) + generated migrations
            + hand-written kernel/FK SQL — org-scoped
engine/     Posting rules, approvals runtime, money math, QuickJS scripting,
            SQL API, and the source-adapter registry (ledger migration in)
web/        Next.js 16 App Router app — authenticated shell in app/(app),
            login + API outside; flyout-first, instant-into-draft records
packages/
  ui/           Design system — buttons, inputs, tables, drawers, page headers
  analytics/    BHQL insight query engine (AST → SQL → viz spec)
  reports/      Custom report definitions, filters, schedules, runs
  pdf/          Pure-JS PDF renderer (pdfkit; no Chromium)
  office/       Excel (ExcelJS) + CSV export
  forms-core/   App-builder form schema, evaluator, field registry
  customization/ Custom fields + custom record types
  jobs/         Background job runtime
  emails/       Transactional email templates
```

Every change lands complete: UI, permission key, route, migration, FK, and
grants ship together — no orphaned schema and no unreachable UI.

## Tech stack

| Layer      | Choice                                                         |
| ---------- | -------------------------------------------------------------- |
| Framework  | Next.js 16 (App Router) + React 19                             |
| Language   | TypeScript 5.9 (strict)                                        |
| Database   | PostgreSQL 16 on a Patroni HA cluster                          |
| ORM        | Drizzle — with hand-written kernel & FK SQL                    |
| Money      | `numeric(19,4)` + BigInt math (no floats)                      |
| Scripting  | Real JavaScript in a QuickJS sandbox                           |
| Query      | Real PostgreSQL through a SELECT-only role                     |
| PDF        | Pure-JS pdfkit pipeline (no Chromium)                          |
| Office     | ExcelJS + CSV                                                  |
| i18n       | next-intl (English · French · Spanish)                         |
| Styling    | Tailwind CSS 4 (class-based dark mode) + shared component library |
| Auth       | scrypt + signed-cookie sessions, middleware gate, RBAC        |

## Quick start

You'll need **Node 24+**, **npm**, and a **PostgreSQL 16** database.

```bash
# 1. Install workspace dependencies
npm install

# 2. Point openbooks at your database
#    Set OPENBOOKS_DB_URL in a .env at the repo root
#    (web/.env.local symlinks it for Next middleware)

# 3. Create the schema — apply migrations, integrity, and kernel rules in order
#    schema/migrations/generated/*.sql
#    → schema/migrations/referential-integrity.sql
#    → schema/migrations/kernel-constraints.sql
#    then: grant select on <tables> to openbooks_read

# 4. Seed your first user
npx tsx engine/src/seed-user.ts you@example.com "Your Name" admin

# 5. Run the app
npm run dev -w web
```

Then open **http://localhost:4780** and sign in.

## Contributing

Contributions are welcome — issues, discussions, and PRs all help.

1. Fork the repo and follow the [Quick start](#quick-start).
2. Keep changes type-safe: `npx tsc -p web --noEmit`, `npx tsc -p engine
   --noEmit`, and a clean `cd web && npx next build`. **Never commit on red.**
3. Respect the non-negotiables: kernel discipline, complete i18n across every
   shipped locale, flyout-first records, and search/filter/pagination on every
   list.
4. Open a PR describing the change and the workflow it improves.

If you run a real back office and something here doesn't match how your books
actually work, that feedback is gold —
[open an issue](https://github.com/braedonsaunders/openbooks/issues).

## License

openbooks is licensed under the **[GNU Affero General Public License v3.0](LICENSE)**
— use it, modify it, self-host it, ship it. Because it's AGPL, if you run a
modified version as a network service you must make your source available to its
users under the same license. That keeps the project open for everyone and keeps
hosting-as-a-business honest.

Copyright © 2026 the openbooks contributors.

---

<p align="center">
  <a href="https://star-history.com/#braedonsaunders/openbooks&Date">
    <img alt="Star history" src="https://api.star-history.com/svg?repos=braedonsaunders/openbooks&type=Date" width="600" />
  </a>
</p>

<p align="center">
  <em>The open business suite. Run on open books.</em><br />
  If openbooks is useful to you, consider giving it a ⭐.
</p>
