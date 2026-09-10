# /payroll ViewSpec integration handoff

Page: `web/app/(app)/payroll/` — owner files are `view.ts`, `sections.tsx`
(+ this file) and the `__viewspec` branch + imports in `page.tsx`.

Spec blocks used: `pageHeader`, `grid`, `statTile` ×5, `panel` ×3 (all
exist), `module-home-tabs`, `directory-section`, `attention-list` (all exist
in the registry), plus `payroll-settings-banner`, `payroll-current-period`,
`payroll-previous-run`, `payroll-manage-links` (proposed below — none exist
in the registry yet).

Division of labor follows the purchasing cockpit exactly: ViewSpec composes
the GRID and the PANELS; the panel bodies stay components in `sections.tsx`,
shared by both render paths so they cannot drift. The schedule cards carry
the one smart action (Start / Resume / Review — a three-way choice), the
previous-period body carries a conditional badge + link, the checklist banner
carries a translated settings list, and the manage links are a conditional
pair — none of which a spec can express, so all four live in `sections.tsx`.

## 1. WIDGET_REGISTRY entries (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (components already exist in my owned dir):

```tsx
import {
  PayrollChecklistBanner,
  PayrollPreviousRun,
  PayrollManageLinks,
  PayrollScheduleList,
  type PayrollChecklistBannerProps,
  type PayrollPreviousRunProps,
  type PayrollManageLinksProps,
  type PayrollScheduleListProps,
} from '../../app/(app)/payroll/sections'
```

Entries (place after the `/* --- pay runs --- */` group):

```tsx
/* --- payroll cockpit -------------------------------------------------------- */
/**
 * Setup-checklist banner. Presence-gated by the spec (`showChecklist` =
 * canManage && missingSettings.length > 0); the translated settings list
 * arrives pre-joined from the loader.
 */
/* --- payroll cockpit -------------------------------------------------------- */
/**
 * Setup-checklist banner. Presence-gated by the spec (`showChecklist` =
 * canManage && missingSettings.length > 0); the translated settings list
 * arrives pre-joined from the loader.
 */
'payroll-settings-banner': (props) => (
  <PayrollChecklistBanner
    text={str(props, 'text') ?? ''}
    settings={str(props, 'settings') ?? ''}
    openSettingsLabel={str(props, 'openSettingsLabel') ?? ''}
  />
),
/**
 * Current-period hero body, INCLUDING its empty state (same call the
 * purchasing cockpit made: a negated conditional pair is not a spec
 * construct). Schedule rows arrive display-ready; the Start / Resume /
 * Review action was already resolved to a plain ref triple by the loader.
 */
'payroll-current-period': (props) => (
  <PayrollScheduleList
    schedules={
      (props.schedules as PayrollScheduleListProps['schedules']) ?? []
    }
    emptyText={str(props, 'emptyText') ?? ''}
    showSetupLink={props.showSetupLink === true}
    setupLabel={str(props, 'setupLabel') ?? ''}
    labels={
      (props.labels as PayrollScheduleListProps['labels']) ?? {
        frequency: {},
        period: '',
        payDate: '',
        employees: '',
        net: '',
      }
    }
  />
),
/**
 * Previous completed period, INCLUDING its empty state. The badge variant
 * (posted → success, committed → default) is re-derived from the `posted`
 * flag inside the component, exactly like the native branch.
 */
'payroll-previous-run': (props) => (
  <PayrollPreviousRun
    run={(props.run as PayrollPreviousRunProps['run']) ?? null}
    periodLabel={str(props, 'periodLabel') ?? ''}
    payDateLabel={str(props, 'payDateLabel') ?? ''}
    netLabel={str(props, 'netLabel') ?? ''}
    employeesLabel={str(props, 'employeesLabel') ?? ''}
    noneText={str(props, 'noneText') ?? ''}
  />
),
/**
 * Manage-only setup links under the directory. Presence-gated by the spec
 * (`canManage`); the two hrefs are static routes owned by the component.
 */
'payroll-manage-links': (props) => (
  <PayrollManageLinks
    paySchedulesLabel={str(props, 'paySchedulesLabel') ?? ''}
    payComponentsLabel={str(props, 'payComponentsLabel') ?? ''}
  />
),
```

`str` and `ComponentProps`-style casts follow the existing registry
conventions (`str` for strings, direct casts for arrays/records). No other
new imports: `StartRunButton` and `RunStatusBadge` are used inside
`sections.tsx` (both already exist), never referenced by the registry
directly. The exceptions rail reuses the existing `attention-list` widget
(markup-verified identical: same `divide-y divide-slate-50` list, same
`flex items-start gap-2.5 px-4 py-2.5` rows, same red/amber dots for the
negative/warning tones this page emits, same all-clear paragraph classes);
the directory reuses the existing `directory-section` widget.

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/payroll',
  // Cockpit page — it reads no query params (the loader ignores
  // searchParams), so one variant pins every branch at once: the payroll
  // feature flag is on and the harness user is an admin with
  // payroll.read/run/manage, so both render paths show the checklist
  // banner, both schedule cards, the previous period, the exception queue
  // and the full directory. The h3 count pins the composition: three
  // HomePanel titles plus the directory h3.
  variants: [''],
  expect: 'h2, h3',
  minMatches: 4,
},
```

GATES verification (the page 404s without them, and no row count shows
that): `payroll.read` — the harness user `viewspec@sim.test` holds the
`admin` role, whose permission set includes `payroll.read`,
`payroll.manage` and `payroll.run` (verified in `app_roles`). The
`payroll` feature flag is `true` in the sim org's settings (verified in
`orgs`). Same gates as the already-green `/payroll/runs` entry.

Row counts behind the single variant (all read-only, bypass RLS on):

- 2 active pay schedules (fixtures `…1801` biweekly default +
  `…1802` monthly) → current-period hero renders 2 `ScheduleCard` rows.
- 3 pay runs, all draft documents: 2 × `calculated` (PAY-00001/2), 1 ×
  `committed` (PAY-00003). The biweekly card's latest run is PAY-00003
  (committed, open) → Resume/Review action with `outline` variant and
  `?step=finish` href; the monthly card has no run → `StartRunButton`
  (harness user `canRun`). The committed run is also the previous period
  (`posted: false` → default-variant "Committed" badge).
- 0 active payroll profiles, 12 active profile-less employees, 0 stubs →
  vitals render zeros, the exceptions rail renders 6 missing-profile rows
  + the "6 more" row (verified: 12 missing, limit 6), and the
  previous-period panel renders (not the `none` empty state).
- Directory: runs badge `3` / hint `in progress · 3 total` / warning tone
  (3 draft docs), employees badge `0`, setup badge on the missing-settings
  count, plus the 3 static links — 6 items for the admin harness user,
  with the manage-links row beneath.

Heads-up on one moving part: `runsThisYear`, the YTD figures and the
"periods of" tile all key off `businessToday(orgId)`'s tax year. Today's
value renders "1 of 26" and zeros — both paths compute it in the same
loader, so any drift moves both renders together.

## 3. Fixture SQL (for the coordinator — fold into `scripts/viewspec-fixtures.sql`)

None needed. This page reuses the `…1801–1899` payroll schedules-and-runs
block the `/payroll/runs` conversion already claimed (2 schedules, 3
draft-document runs with `calculated`/`calculated`/`committed` statuses —
one open run per the hero's Resume path, one schedule with no run for the
Start path, and the committed run for the previous-period panel), plus the
simulator's own 12 profile-less employees for the exception queue. I claim
no new id block; ON CONFLICT DO NOTHING has nothing of mine to collide
with.

## 4. What the spec does NOT cover (explicitly shared instead)

- No per-row widget decomposition of the schedule cards: the Start /
  Resume / Review action is a three-way choice (open run → wizard link
  with committed-dependent variant + label, else Start button when
  `canRun`, else nothing) plus two conditional pairs (status badge only
  with a run, net fact only for non-draft runs). Per the brief, a
  conditional pair is a component: `PayrollCurrentPeriod` /
  `ScheduleCard` in `sections.tsx`, imported back into `page.tsx`.
- Same for `PayrollPreviousRun` (facts + conditional badge + link vs the
  `none` empty state), `PayrollChecklistBanner` (icon + pre-joined
  translated list + setup link), and `PayrollManageLinks` (conditional
  pair of links).
- `Fact`, `ExceptionRow` and `shortDate` moved to `sections.tsx` and are
  imported back into `page.tsx` — one implementation, both paths.
- The reused `directory-section` widget returns null on an empty list while
  the native markup always renders the wrapper div + h3 (with `LiveDirectory`
  rendering nothing inside). Unreachable here: the runs entry is
  unconditional, so `directory.length >= 1` on every render of both paths.
  Same for `attention-list`'s index keys vs the native `p-`/`w-` keys — keys
  never reach the DOM.
- `t.has('home.directory.openingBalances' as never)` and friends: the
  loader reproduces the fallback logic verbatim; all three keys exist in
  `web/messages/en/payroll.json` today, so both branches resolve the
  real labels.
- `t('home.frequency.${schedule.frequency}')` is loader-resolved per
  row (`frequencyLabels[id]`); the component falls back to the raw
  frequency string for unknown ids, exactly like an untranslated key
  would surface.
- `RunStatusBadge` and `StartRunButton` are client components used
  inside `sections.tsx` — same as the native page used them. No slot
  needed: neither takes an Authz, an org id, or a user id.
