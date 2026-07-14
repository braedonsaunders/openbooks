# AGENTS.md

## Mission

openbooks is a pre-launch, open-source business suite (NetSuite-class
accounting: GL kernel, AP/AR, approvals, insights, reports, app builder)
proven by running a real company's books in parallel with NetSuite until
cutover. Treat the repository as a greenfield production system headed for a
hard cutover, not a prototype. Agents should leave the app more coherent than
they found it. The roadmap is `GOAL.md`; porting coordination lives in
`PORTING.md`.

## Non-Negotiable Engineering Rules

1. Clean cutover → leave no legacy code. The app has not launched; do not
   preserve old paths, compatibility shims, deprecated APIs, or duplicate
   flows unless explicitly asked for a temporary migration step.
2. Ship complete production-grade code: no stubs, placeholders, mock
   implementations, TODO-driven behavior, fake data paths, or "wire it later"
   branches.
3. If you see a bug while doing something, stop and fix it even if unrelated.
   If too large to fix safely in the current pass, flag it clearly before
   continuing.
4. Before building anything new, verify no duplicate exists. Search first,
   inspect nearby modules, reuse the existing system where it fits.
5. Unify existing systems and abstract shared behavior when it reduces real
   duplication or reconciles competing implementations.
6. No dead code, duplicate implementations, abandoned files, unused exports,
   stale routes, or shadow systems. Flag and clean up immediately.
7. beaconhs (local checkout: `~/Documents/Code/beaconhs-platform`) is the
   UI/UX boilerplate. Copy its foundations and quality bar; do not
   approximate them. When beaconhs gains primitives worth having, re-copy.
8. The product is vendor-neutral and general-purpose. No hardcoded vendor
   names (NetSuite, etc.) or org names (Rassaun) in product copy — identity
   comes from the database and the source-adapter registry. No
   account-shaped shortcuts: the reference company's usage profile
   prioritizes UX/migration order, never schema or feature scope.
9. Validation gates before any commit: `npx tsc -p web --noEmit` (web has its
   own TypeScript 5.9 — the root has TS7, use `web/node_modules/.bin/tsc`),
   engine typecheck (`npx tsc -p engine --noEmit`), and a clean
   `cd web && npx next build`. Never commit on red.

## Accounting Kernel Discipline (never violate)

- Documents (business layer, mutable while draft) are strictly separate from
  the ledger (journal entries/lines — append-only, immutable once posted).
  Posting a document produces exactly one journal entry; corrections are
  reversals (`reverses_entry_id`), never edits.
- Postgres enforces the invariants (balance = 0 per entry, posted-immutable,
  no posting to summary/inactive accounts, application caps) via triggers in
  `schema/migrations/kernel-constraints.sql`. Never weaken a trigger to "make
  it work"; the migration-mode GUC (`openbooks.migration = on`) exists only
  for historical replays.
- Money is `numeric(19,4)`; compute with `engine/src/money.ts` (BigInt units
  — handles scientific notation), never floats.
- User scripting is real JavaScript in the QuickJS sandbox; the user query
  surface is real PostgreSQL through the SELECT-only role. Never invent
  sanitized dialects.

## Quick Start

- Runtime: Node 24+, npm workspaces (`schema`, `engine`, `web`, `packages/*`).
- Install: `npm install` at the repo root.
- DB: Postgres 16 on the Patroni cluster (`OPENBOOKS_DB_URL` in gitignored
  `.env` at repo root; `web/.env.local` symlinks it for Next middleware).
  Rebuild from scratch = drop DB, re-apply
  `schema/migrations/generated/*.sql` in order + `referential-integrity.sql`
  + `kernel-constraints.sql`, then grants to `openbooks_read`.
- App: `npm run start -w web` (or `dev`) → `http://localhost:4780`.
- Users: `npx tsx engine/src/seed-user.ts <email> "<name>" <role> [password]`.
- NetSuite bridge (temporary): creds in gitignored `.env.netsuite`; sync via
  the UI button or `npx tsx engine/src/sync/cli.ts`.

## Repo Map

- `schema/` — Drizzle schema (`src/*.ts`, re-exported from `src/index.ts`),
  generated migrations, and the hand-written kernel/FK SQL.
- `engine/` — posting rules, approvals runtime, money math, QuickJS
  scripting, SQL API, NetSuite sync (`sync/` with the MigrationSource adapter
  registry), seeds, replay/proof tools.
- `web/` — Next.js 16 App Router app. Authenticated pages in `app/(app)`
  behind the shell; `login` + `api` outside.
- `packages/ui` — the design system (copied from beaconhs). Buttons, inputs,
  selects, tables, drawers, popovers, badges, page headers, skeletons.
- `packages/analytics` — BHQL insight query engine (AST → SQL → viz spec).
- `packages/reports` — custom report definitions/filters/schedules/runs.
- `packages/forms-core` — app-builder form schema, evaluator, field registry.
- `extraction/`, `analysis/` — NetSuite extraction artifacts and spec docs.

## Web App Conventions

- Compose pages from the shells in `web/components/page-layout.tsx`
  (`PageContainer`, `ListPageLayout`, `DetailPageLayout`, `WizardLayout`) and
  `@openbooks/ui` primitives. lucide-react icons. Tailwind v4 with
  class-based dark mode — preserve light AND dark states in every change.
- NON-NEGOTIABLE: every table or list of records ships with search, relevant
  filters, and pagination — URL-driven via `parseListParams`, `SearchInput`,
  `FilterChips`, `SortTh`/`SortableTh`, `Pagination` (prefixed params on
  multi-table pages). Never render an unbounded or unsearchable table.
- NON-NEGOTIABLE — flyouts and in-app links use the client router, never a
  full reload. Opening a `?param=id` flyout or navigating between app routes
  uses Next `<Link>` or `router.push` — NEVER a plain `<a href="/…">` (that
  reloads the whole shell). Plain `<a>` is only for real file downloads
  (`/api/…/csv`, attachment downloads) and external URLs.
- NON-NEGOTIABLE — records are flyout-first: create/view/edit for business
  records (vendor bills, invoices, payments, journal entries, parties, …)
  happens in a `UrlDrawer` over the list (`?<record>=<id>` URL param, closable
  via `closeHref`), not on separate routes, unless the record is genuinely
  too complex for a drawer (then `DetailPageLayout`).
- NON-NEGOTIABLE — instant-into-draft: "New X" immediately creates a real
  draft record server-side and opens it in the flyout for editing. No big
  blocking create forms, no client-only state that can be lost. Drafts
  autosave (debounced PATCH); posting/submitting is an explicit action.
- Navigation comes from `web/lib/nav/registry.ts` + org overrides
  (`/admin/navigation`). Add modules to the registry — never hardcode
  sidebar entries.
- Mutations check permissions (`web/lib/authz.ts` — `requirePermission` /
  `assertCan` with wildcard keys from `web/lib/permissions.ts`) and money
  amounts render right-aligned `tabular-nums`.
- Statuses are `Badge` variants; toasts via sonner (`toast.success/error`).

## Brand

- The animated SVG logo lives in `web/components/brand-logo.tsx`: stroke-drawn
  open-ledger mark + monoline wordmark ("books" in brand teal), normalized
  `pathLength` strokes driven by the `brand-*` keyframes in `globals.css`.
- `<SplashScreen />` (root layout) plays the draw-in once per document load;
  route fallbacks that warrant a full-screen splash mount `<SplashHold />`.
- Heavy in-shell loading states use `<LogoLoader />` (or `<LogoMark draw />`),
  not bare spinners. Skeletons (`Skeleton`) remain right for row/card-level
  loading. Respect `prefers-reduced-motion` (the keyframes already do).
- NEVER add a root `(app)/loading.tsx`: it replaces the whole content pane on
  every soft navigation (drawers, filters, pagination) — the exact jank the
  UrlDrawer pattern exists to avoid. Loading boundaries go on individual
  slow segments only; URL-driven interactions must keep the current UI
  visible while the next render streams.
- Keep every brand shape a stroke with `pathLength={1}` so draw-in keeps
  working; update all three exports (Logo, LogoMark, BrandSplash) together.

## Database and Migrations

- Schema files live in `schema/src/` (one domain per file) using the helpers
  (`id()`, `orgRef()`, `auditColumns`, `money()`), org-scoped via `org_id`.
- FKs live in `schema/migrations/referential-integrity.sql` (the single
  authoritative FK map), kernel invariants in `kernel-constraints.sql`.
- Migration flow: export new tables from `schema/src/index.ts` → `cd schema &&
  npx drizzle-kit generate --name <slug>` → apply the generated file + any FK
  additions to the DB → `grant select on <new tables> to openbooks_read`.
- Never bypass the kernel triggers or RLS-style scoping to "make it work".

## Quality Bar

- Production-grade means permissions, validation, empty/loading/error states,
  audit trail, persistence, revalidation, and focused verification where risk
  justifies it. Verify UI changes in the preview browser (note: framer/CSS
  enter-animations idle in hidden headless tabs — inject a CSS override for
  screenshots; not a real-browser bug).
- No fake success paths; surface real configuration errors or disabled states.
- No unreachable UI: navigation registry entry, permission key, and route land
  together. No orphaned schema: UI, actions, migration, FK, grants land as one
  complete change.

## Search First Checklist

- `rg` route names, table names, package exports, and UI labels before adding.
- Check `packages/ui`, `web/components`, `web/lib`, `engine/src`, and
  `schema/src` for existing primitives.
- Check `web/lib/nav/registry.ts` before adding navigation.
- If you find duplication, clean it up as part of the change.

## Git

- Commit atomically to `main` as you work — focused, self-contained commits,
  staged intentionally (never sweep unrelated changes). End commit messages
  with the Claude co-author trailer already used in history.
- The worktree may contain concurrent agent work (see PORTING.md ownership).
  Never revert files you did not intentionally edit.

## Agent Handoff Notes

- End completed work with a condensed checklist the user can use to test every
  change. State what you changed, what you verified, and what remains risky.
- Mention any bug you found and fixed along the way.
- Keep documentation honest: GOAL.md checkboxes, PORTING.md status, and this
  file must match reality in the same change that alters it.
