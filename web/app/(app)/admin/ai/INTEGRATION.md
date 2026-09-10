# /admin/ai ViewSpec integration handoff

Page: `web/app/(app)/admin/ai/` — owner files are `view.ts` (+ this file)
and the `__viewspec` branch + imports in `page.tsx`. No `sections.tsx`:
there are no composite cells, and the client component is NOT moved — it
stays in `AiSettingsForm.tsx` because the native branch renders it and both
paths must share one implementation.

Spec widgets used: `ai-settings-form` only (proposed below — does not exist
in the registry yet). The `page-container` frame and `card` frame already
exist; no new vocabulary needed. Read `web/app/(app)/admin/backups/view.ts`
+ `web/app/(app)/platform/view.ts` before touching this spec: backups is the
"whole client island through one widget" precedent this copies, and platform
is the `PageContainer` → `layout: 'bare'` + `frame('page-container')` shell
precedent (header sits INSIDE the width wrapper, not in a sticky region).

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (already exists as a component):

```tsx
import { AiSettingsForm } from '../../app/(app)/admin/ai/AiSettingsForm'
```

Entry:

```tsx
/* --- admin ai ------------------------------------------------------------- */
/**
 * Whole: the provider/agent/capture settings form owns per-field useState,
 * the auto-load-models effect, every fetch mutation (save, test, clear key,
 * run-now, capture test), and the ?agent= configuration drawer with its own
 * draft state and router.push navigation — client state, effects and
 * capabilities, not spec vocabulary.
 */
'ai-settings-form': (props) => (
  <AiSettingsForm
    specs={props.specs as ComponentProps<typeof AiSettingsForm>['specs']}
    detectorSpecs={props.detectorSpecs as ComponentProps<typeof AiSettingsForm>['detectorSpecs']}
    initial={props.initial as ComponentProps<typeof AiSettingsForm>['initial']}
    selectedAgentKey={
      typeof props.selectedAgentKey === 'string'
        ? (props.selectedAgentKey as ComponentProps<typeof AiSettingsForm>['selectedAgentKey'])
        : null
    }
  />
),
```

EXACT prop shape the widget receives (verbatim from `adminAiSpec`):

```ts
{
  specs: ProviderSpecLite[]      // data.specs — value/label/baseUrl/requiresBaseUrl/fast/smart/keyHint/modelHint
  detectorSpecs: DetectorSpecLite[] // data.detectorSpecs — detectorKey/agentKey/supportsMateriality/parameters[]
  initial: OrgAiSettings         // data.initial — enabled/provider/modelFast/modelSmart/baseUrl/hasKey/agents/documentCapture (no secrets)
  selectedAgentKey: 'accounting' | 'finance' | null // data.selectedAgentKey — null unless ?agent= names a real agent key
}
```

Why `selectedAgentKey` resolves null explicitly instead of `str()`: the
native branch passes `null` (not `undefined`) when `?agent=` is absent or
unrecognized, so the widget reproduces the exact prop — `typeof` guard, not
a string helper.

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/admin/ai',
  // One client island behind the admin.ai.manage gate: both paths serve the
  // same AiSettingsForm with loader-resolved props, identical by
  // construction. Variants pin the page's real branches: the ?agent=
  // configuration drawer (UrlDrawer portal, hence the drawer scope) and the
  // ?agent= whitelist fallback (unrecognized key → no drawer).
  // Range-limited on purpose: minMatches counts STATIC first-paint chrome
  // only — never the model list (fetched post-mount) or toast/test results.
  // main h1 is the PageHeader title; main h4 counts the two agent cards
  // (accounting + finance always resolve — getContinuousClosePolicies maps
  // over both keys with defaults, so no fixture rows are needed).
  variants: [
    { query: '', expect: 'main h4', minMatches: 2 },
    {
      query: '?agent=accounting',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
    { query: '?agent=bogus', expect: 'main h4', minMatches: 2 },
  ],
  expect: 'main h4',
  minMatches: 2,
},
```

GATES verification (read-only queries, 2026-09-10) — verified against the
page's GATES, not just row counts:

- Permission: harness user `viewspec@sim.test` (org
  `da472d3a-98e5-4fa5-a6ee-2451e6d6970a` "SIM · Summit Ridge Construction")
  holds role `Administrator` via `role_assignments`, whose `permissions`
  array contains `"admin.ai.manage"` (verified:
  `permissions::text LIKE '%admin.ai.manage%'` → true). `requirePermission`
  passes on both branches.
- AI config: the harness org's `settings->'ai'` is NULL, so `readAi`
  returns `{}`, and the loader resolves `enabled=true`
  (`undefined !== false`), `provider='anthropic'`, empty models/baseUrl,
  `hasKey=false`. `ai_agent_policies` holds ZERO rows for the harness org
  (verified: `count(*) = 0`), so `getContinuousClosePolicies` returns the
  two defaults (accounting + finance, disabled, daily, `1000.0000`,
  detectors on, `lastRunAt=null` → the `neverRun` branch). Deterministic,
  no provider key needed, no fetch to AI backends.
- `?agent=accounting` always opens the drawer: both agent keys always
  resolve (defaults, never missing), so `agents.find(...)` succeeds and
  `selectedAgent` is non-null. `?agent=bogus` hits the
  `isContinuousCloseAgentKey` whitelist fallback → null → no drawer, markup
  identical to bare (allowed: `assertVariantsDiffer` fails only when ALL
  variants are identical, and the drawer variant differs).
- `assertVariantsDiffer` (conformance.mjs:1872) passes: the drawer variant
  captures `main` + the `[data-drawer-layer]` portal, which the bare
  variants do not render.

## 3. Fixture SQL

None. This page has no table path and no empty state: the provider specs are
hardcoded, both agent policies resolve from defaults when
`ai_agent_policies` is empty, and the form renders its full first paint from
`initial` alone. The bare SIM tenant already exercises every branch above,
so no `viewspec-fixtures.sql` block is claimed and none is needed. (Block
…1401-1499 belongs to the /assistant entry and …1501-1599 was verified free
but is deliberately left unclaimed.)

## 4. What could not be expressed (intentionally inside the widget)

- Everything interactive: provider-driven base-URL field, model SearchSelect
  + manual-type toggle + live reload, save/test/clear-key mutations,
  run-agent-now (save-then-scan), document-capture test, and the
  `AgentConfigurationDrawer` draft editing + `router.push` navigation. All
  are client state, effects, fetch capabilities, or navigation — no spec
  vocabulary exists for them, and decomposing them would reimplement the
  component rather than compose it (the backups precedent, §1).
- `nextRunAt`/`lastRunAt` formatting stays client-side
  (`Intl.DateTimeFormat` in the island); the loader passes raw ISO strings,
  exactly as the native page does.
- No `Authz`, no `orgId`, no server actions cross the boundary: the loader
  resolves the gate and the org-scoped settings; the widget receives only
  the serializable slice the native branch already passes.
