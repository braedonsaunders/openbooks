# /admin/navigation ViewSpec integration handoff

Page: `web/app/(app)/admin/navigation/` — owner files are `view.ts` (+ this
file) and the `__viewspec` branch + imports in `page.tsx`. No `sections.tsx`:
the page defines no local components (`NavEditor` lives in its own
`NavEditor.tsx` and is shared unchanged by both paths — brief §2's
single-implementation rule is satisfied without moving it).

Spec blocks used: `frame('page-container')` (pre-existing — no new frame),
`pageHeader` with `back`, `grid`, one `widgetBlock`. One new widget:
`nav-editor` (proposed below).

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (already exists as a component):

```tsx
import { NavEditor } from '../../app/(app)/admin/navigation/NavEditor'
```

Entry (place next to the other admin entries):

```tsx
/* --- navigation admin ----------------------------------------------------- */
/**
 * The org nav-layout editor. Whole-component passthrough, exactly like
 * `form-drawer` / `list-view-drawer` (`admin/customization/INTEGRATION.md`):
 * the editor owns unsaved client state, prompt() dialogs, a 4-pin mobile
 * limit with a toast, and a PUT save — it is never decomposed. Props are the
 * two loader-resolved values the native page already builds: the
 * saved-or-default config and the installed-app options.
 *
 * EXACT prop shape — the spec binds verbatim, so the entry must too:
 *   initial: OrgNavConfig  ({ version: 2, groups: [{ id, label, items }] })
 *   apps: NavAppOption[]   ({ key, name, iconKey }[])
 */
'nav-editor': (props) => (
  <NavEditor
    initial={props.initial as ComponentProps<typeof NavEditor>['initial']}
    apps={(props.apps as ComponentProps<typeof NavEditor>['apps']) ?? []}
  />
),
```

Why a widget and not spec blocks: `NavEditor` is ~200 lines of interactive
client state (per-item label inputs, group selects, move/pin/hide/delete
buttons, add-link/add-app/add-group prompts, save/reset). No block or cell
vocabulary can express an editor; the customization page sets the precedent
(designers ride through as whole components, native and spec paths sharing
one implementation).

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Verified read-only against `openbooks_sim_viewspec` (harness org
`da472d3a-98e5-4fa5-a6ee-2451e6d6970a`, `app.bypass_rls='on'`):

- `org_nav_configs`: **0 rows** → loader falls back to `defaultNavConfig()`
  (deterministic: 8 registry groups, module items from DEFAULT_NAV_ORDER).
- Installed apps with an active version in the harness org: **2**
  (`viewspec-demo` "ViewSpec demo app", `viewspec-nodesc` "ViewSpec nodesc
  app"; both manifests carry no `nav.label`, so names fall back to `app.name`;
  `viewspec-archived` is `disabled`, `viewspec-noversion` has no active
  version — both filtered, matching the native filter verbatim).
- The harness user `viewspec@sim.test` is authenticated on both paths, so the
  logged-out `return null` branch is unreachable in the harness (same position
  as the admin hub's `redirect('/')` GATES note).
- No query params exist on this page (the loader ignores `sp`), so a single
  default render covers every branch the harness tenant can reach: the header
  (title + back link) and one `NavEditor` (8 group cards, item rows, the Save /
  Reset / Add-workspace footer). The interactive editor renders identically on
  both paths because it is the same component with the same props.

```js
{
  path: '/admin/navigation',
  // The nav-layout editor: PageHeader (title + back to /admin) over one
  // NavEditor. No org_nav_configs row exists for the harness org, so both
  // paths render defaultNavConfig(); 2 installed apps with active versions
  // feed the add-app selects. No query params on this page.
  variants: [''],
  expect: 'input[aria-label="Group label"]',
  minMatches: 8,
},
```

## 3. What the spec does NOT cover (nothing — full coverage)

- The loader (`loadNavigationAdmin`) copies the native query, filter and
  fallback logic VERBATIM: same `org_nav_configs` select, same `listApps`
  filter (`installed && activeVersionId`), same `manifest.nav.label/icon`
  trim-or-fallback mapping, same `saved?.version === 2 ? saved :
  defaultNavConfig()`. The logged-out `return null` is preserved via the
  approvals precedent (`Promise<Data | null>` + `if (!data) return null` in
  the branch).
- Shell equivalence: the native page sits in
  `<PageContainer className="max-w-3xl">` (`app-scroll` scroll div +
  `FadeInBody` motion div + `mx-auto w-full max-w-screen-2xl … max-w-3xl`
  inner). The spec takes the analytics-hub precedent: `layout: 'bare'` +
  the pre-existing `page-container` frame with `{ className: 'max-w-3xl' }`
  (the frame forwards `className` — verified in
  `web/components/viewspec/blocks.tsx`). Both paths therefore render the
  same `PageContainer` component with the same prop.
- `PageHeader` props (`title`, `description`, `back { href: '/admin', label:
  tHub('title') }`) travel as loader-resolved strings; no actions, so no
  `actionsClassName` wrapper question arises.
- The `<div className="mt-6">` editor wrapper is `grid('mt-6', [widgetBlock…])`
  — `grid` renders a bare div with exactly that class, `WidgetBlockView`
  renders a fragment around the widget, so no extra nodes intervene.
- Message keys (all verified in `web/messages/en/admin.json` — no invented
  keys): `admin.navigation.title/description`, `admin.hub.title`. Every other
  string the editor shows (`groupLabelAria`, `addLink`, `save`, …) resolves
  inside `NavEditor` itself via `useTranslations('admin.navigation')` — shared
  code, not spec data.
- No fixture id block is claimed: the page needs no seeded rows (empty
  `org_nav_configs` exercises the default-config path; the 2 installed apps
  already exist in the `…1101-1199 installed apps` block owned by whoever
  seeded them). `scripts/viewspec-fixtures.sql` untouched.

## 4. Typecheck status — RUN, clean

`node_modules/.bin/tsc --noEmit -p web/tsconfig.json` → exit 0, no errors
(run in this worktree after a fresh `npm install`; `git status` confirms the
install left no collateral edits — only the three navigation files).
Contract spot-checks done while writing (all confirmed in source, now also
compiler-verified): `pageHeader` accepts `back` (`builder.ts` spreads
`PageHeaderBlock`, `schema.ts` types `back` as `{ href, label }`);
`frame('page-container', blocks, { className })` forwards `className`;
`WidgetBlockView` renders a bare fragment; `NavEditor` takes
`{ initial: OrgNavConfig; apps: NavAppOption[] }`.
