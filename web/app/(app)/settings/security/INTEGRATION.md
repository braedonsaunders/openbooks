# /settings/security ViewSpec integration handoff

Page: `web/app/(app)/settings/security/` — owner files are `view.ts`,
`sections.tsx` (+ this file) and the `__viewspec` branch + imports in
`page.tsx`.

Spec widgets used: `security-panel` only (proposed below — does not exist in
the registry yet). No `table`, `repeat`, or `frame` vocabulary: this page is
the degenerate case — a fully client-side panel (`'use client'`) with zero
server-rendered content. The LOADER reproduces the `page.tsx` gate verbatim
and binds nothing; the whole body below the shell is one interactive
component placed whole, the same treatment as `query-console` (a studio:
`card-studio`, `view-studio`) and `assistant-app`.

Read `web/app/(app)/query/view.ts` + `web/app/(app)/query/INTEGRATION.md`
before touching this spec: it is the same "whole interactive component
through one no-props widget" precedent. `web/app/(app)/reports/view.ts`
shows the `frame('page-container', …)` style this spec deliberately does
NOT copy (see §4).

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (moved, not new — owned by this page's dir):

```tsx
import { SecurityPageContent } from '../../app/(app)/settings/security/sections'
```

Entry:

```tsx
/* --- security settings ------------------------------------------------------ */
/**
 * The whole sign-in security page body, placed whole rather than decomposed
 * into blocks: the <main> wrapper + header copy (static English owned by the
 * component, not loader data) plus the interactive SecurityPanel (MFA
 * setup/disable forms, recovery codes, session list, every fetch). All
 * state is client-side (useState, fetch to /api/auth/mfa and
 * /api/auth/sessions); there is no server content to decompose, so the
 * widget carries no props. Same precedent as `query-console`, which
 * likewise renders loader-resolved nothing whole. The `data-export` /
 * `import-wizard` entries cite the same precedent.
 */
'security-panel': () => <SecurityPageContent />,
```

EXACT prop shape the widget receives (verbatim from `securitySpec`):

```ts
// no props — widgetBlock('security-panel') with no second argument
{}
```

Why a bare widget with no props: the spec cannot carry interactive state
(password/code inputs, setup secret, recovery codes, fetched sessions, busy
flags) and the loader cannot precompute it (it does not exist until the
component fetches it after mount — see §2's GATES analysis). Threading the
static header copy ("Sign-in security", "Protect your account…") through
widget props instead would double strings the component already owns and
drift on the first copy edit (query-console precedent, INTEGRATION.md §1).
`SecurityData` is an empty record: the loader runs the gate and binds
nothing.

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/settings/security',
  // Fully client-side panel: both paths serve the same SecurityPageContent
  // with no props, identical by construction. No query variants exist on
  // this page (the panel reads no search params — every control is client
  // state or a fetch). The MFA branch (enabled vs setup-form) and the
  // sessions rows arrive over /api/auth/* after mount, so minMatches counts
  // STATIC chrome only: the h1 plus the two card h2s, all server-rendered
  // on first paint by the same component on both paths.
  variants: [''],
  expect: 'main h1, main h2',
  minMatches: 3,
},
```

GATES verification (read-only queries against `openbooks_sim_viewspec`,
2026-09-10) — verified against the page's GATES, not just row counts:

- Auth gate: the harness user `viewspec@sim.test`
  (`01a08426-0962-74c7-a086-e1609c589dcb`, org
  `da472d3a-98e5-4fa5-a6ee-2451e6d6970a`) is active with roles, so
  `currentUser()` resolves on both paths and neither redirects to /login.
- MFA state: `auth_mfa_factors` holds NO row for the harness user (queried
  2026-09-10) — the panel's `/api/auth/mfa` GET returns
  `{ enabled: false, recoveryCodesRemaining: 0 }`, so both paths first-paint
  the "Require a time-based code…" copy and the setup-password form. No
  fixture touches MFA: enrolling a factor would require a TOTP secret +
  recovery hashes for the harness user — real credential material in a seed
  file — and the MFA branch is post-mount fetch content, outside the
  compared static chrome either way.
- Sessions: 25 live `auth_sessions` rows for the harness user (queried
  2026-09-10, all `auth_method='password'`, latest `last_seen_at`
  2026-09-10 17:50). The session ROWS are post-mount fetch content —
  `Last used {toLocaleString()}` renders client-side — so they are outside
  the compared static chrome; the `main h2` for "Active sessions" is what
  the entry pins. No fixture needed: nothing about the harness user's live
  session set is asserted.
- `assertVariantsDiffer` (conformance.mjs:1969) only fires when an entry
  has 2+ passing variants with byte-identical markup; this entry has ONE
  variant, so the guard is vacuous — deliberately so, because there is no
  URL branch to pin (see also the single-variant `/query`, `/reports`,
  `/analytics` entries).
- Client-fetch timing caveat for the coordinator: both paths fetch
  `/api/auth/mfa` + `/api/auth/sessions` on mount and re-render when they
  land. `renderSettled`'s DOM-quiescence poll (conformance.mjs:1738) waits
  for two consecutive identical reads, so the settled capture INCLUDES the
  fetched rows — including `toLocaleString()` timestamps and the
  `last_seen_at` touch (`validateSessionToken` rewrites `last_seen_at`
  when older than 5 minutes, auth.ts:204). If the two passes land in
  different 5-minute touch windows the "Last used" strings can differ by a
  minute. The entry's `expect` selector gates on static chrome only, but
  the byte comparison covers the whole `<main>` — flagging here so the
  coordinator is not surprised if this page flakes on the minute boundary.
  Both passes log in as the same user seconds apart, so in practice they
  share a window.

## 3. Fixture SQL — none (no id block claimed)

No fixtures needed: the harness user's live state already satisfies every
static-chrome gate (active user, no MFA row → setup branch, 25 sessions →
populated "Active sessions" heading), and every dynamic branch is
post-mount fetch content the entry deliberately does not pin. No id block
is claimed. For the record, blocks `…1401-1799` are FRESH (grepped all
`00000000-0000-7000-9000-0000000014*` through `…17*` ids in
`scripts/viewspec-fixtures.sql` 2026-09-10 — zero hits; the allocation
table at the top claims no 14xx–17xx block), so a future agent that needs
auth-fixture rows for this page should claim `…1401-1499` — but note the
§2 caveat: seeding `auth_sessions` for the harness user only grows a row
count the entry does not assert, and seeding `auth_mfa_factors` would flip
the static MFA copy the entry DOES pin.

## 4. What the spec does NOT cover (nothing renderable is missing)

- No composite cells, so no cell components in `sections.tsx` — but
  `sections.tsx` DOES exist: the native page body (`SecurityPageContent` —
  the `<main>` wrapper + header + `<SecurityPanel/>`) was MOVED there from
  `page.tsx` so both render paths share one implementation, per the brief
  §2. `SecurityPanel` itself stays in `security-panel.tsx` (also owned by
  this dir); there is exactly one implementation on all paths.
- No `pageHeader` block: the native header is a plain `<h1>` + `<p>` pair
  inside the page's own `<main>`, NOT the shared `PageHeader` component —
  expressing it as `pageHeader` would render different markup (sticky
  ListPageLayout chrome the native page never had). The whole `<main>`
  arrives through the widget instead.
- No `frame('page-container', …)`: the native page does NOT sit in a
  `PageContainer` — its `<main className="mx-auto w-full max-w-4xl
  space-y-6 p-4 sm:p-6 lg:p-8">` is narrower (`max-w-4xl` vs the shell's
  `max-w-screen-2xl`) and unwrapped by any scroll container. `layout:
  'bare'` passes the widget's output through untouched, which is the only
  shape that preserves those classes byte-for-byte. Same call as the
  `query-console` spec.
- The MFA setup/disable/recovery-code flows, the copy-codes clipboard
  write, the per-session Revoke buttons, "Revoke all other sessions", and
  the `window.location.assign("/login")` redirect on revoking the current
  session are untouched — client behavior, not server content,
  inexpressible by design (no conditionals, no function values, no
  component references).
- No message keys in the spec: every string on this page is a hardcoded
  English literal in `page.tsx`/`security-panel.tsx` (verified: no
  `useTranslations`/`getTranslations` anywhere under
  `settings/security/`). There is no catalog key to thread through, and
  inventing `t('…')` keys would throw at render time.
- No permission flags in the loader beyond the login gate: the native page
  checks nothing but `currentUser()` — MFA and session revocation are
  self-scoped by `homeUserId` in SQL (`getMfaStatus`,
  `listUserSessions`), so there is no reader-visible filtering to
  reproduce and no count disclosure beyond what the component fetches
  itself post-mount.

## 5. Pre-existing state of the merged base (not mine, not touched)

`git merge --no-edit main` reported "Already up to date" — no conflicts, no
new files from main.
