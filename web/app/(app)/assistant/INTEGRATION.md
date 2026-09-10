# /assistant ViewSpec integration handoff

Page: `web/app/(app)/assistant/` — owner files are `view.ts`
(+ this file) and the `__viewspec` branch + imports in `page.tsx`.
No `sections.tsx`: there are no composite cells, and the client component
is NOT moved — it stays in `web/components/assistant/assistant-app.tsx`
because the `[id]` sibling route also renders it.

Spec widgets used: `assistant-app` only (proposed below — does not exist in
the registry yet). No `table`, `repeat`, or `frame` vocabulary: this page is
the degenerate case — a fully client-side workbench (`'use client'`) with
zero server-rendered content. The LOADER reproduces `page.tsx` verbatim and
resolves the widget props; the whole app below the shell is one interactive
component placed whole, the same treatment as `query-console` (a studio:
`card-studio`, `view-studio`).

Read `web/app/(app)/query/view.ts` + `web/app/(app)/query/INTEGRATION.md`
before touching this spec: it is the same "whole interactive component
through one widget" precedent. `web/app/(app)/analytics/view.ts` shows the
`data.*`-valued (non-FieldRef) widget-props style this spec copies.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (already exists as a component):

```tsx
import { AssistantApp } from '../assistant/assistant-app'
```

Entry:

```tsx
/* --- assistant ------------------------------------------------------------ */
/**
 * The whole assistant workbench, placed whole rather than decomposed into
 * blocks: conversation sidebar, streaming thread, composer, every fetch.
 * All conversational state is client-side (useState, fetch to
 * /api/assistant/*); the loader hands over only what the native page
 * already resolved — the owner-scoped sidebar list, the write flag, the
 * model-configured flag, and the optional ?q= prompt — and the widget
 * carries the Remaining props (`activeId: null`, `initialMessages: []`)
 * as spec literals, exactly as the native branch passes them.
 */
'assistant-app': (props) => (
  <AssistantApp
    conversations={props.conversations as ComponentProps<typeof AssistantApp>['conversations']}
    activeId={null}
    initialMessages={[]}
    canWrite={props.canWrite === true}
    aiEnabled={props.aiEnabled === true}
    initialPrompt={str(props, 'initialPrompt')}
  />
),
```

EXACT prop shape the widget receives (verbatim from `assistantSpec`):

```ts
{
  conversations: { id: string; title: string; updatedAt: string }[] // data.conversations
  activeId: null            // literal — the /assistant route has no active thread
  initialMessages: []       // literal — new-chat view starts with an empty thread
  canWrite: boolean         // data.canWrite
  aiEnabled: boolean        // data.aiEnabled
  initialPrompt?: string    // present ONLY when ?q= is a single string (else omitted)
}
```

Why `activeId: null` / `initialMessages: []` are literals, not loader
fields: they are route constants, not query results — the native branch
passes the same literals on every render. Why `initialPrompt` is omitted
rather than `undefined`: keeps the two render paths' props objects
identical, and `str()` already maps a missing key to `undefined`, which is
what the component's optional prop expects.

Why a widget with loader-resolved props (not a bare no-props widget like
`query-console`): the console has NO server data — every string stays
inside its own `useTranslations` calls. The assistant DOES have server
data the component cannot fetch itself: the owner-scoped sidebar list
(`listConversations` filters by owner in SQL — the component's
best-effort `/api/assistant/conversations` refresh is a post-mount
convenience, not the first paint), the `assistant.write` flag, and the
model-configured flag (resolving it client-side would expose the org AI
config over an API). The loader computes; the spec binds.

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/assistant',
  // Fully client-side workbench: both paths serve the same AssistantApp
  // with loader-resolved props, identical by construction. Two variants pin
  // the page's real branches: the ?q= prompt (auto-sent once per distinct
  // query) and the unconfigured-model branch.
  // Range-limited on purpose: minMatches counts STATIC chrome only — never
  // streamed tokens or fetched sidebar refreshes. The header title
  // (t('title') = "AI assistant"), the New chat button (t('newChat')), and
  // the composer placeholder (t('placeholder')) are component chrome owned
  // by the same component on both paths; the Welcome EmptyState title
  // (t('welcomeTitle')) renders on first paint because initialMessages is [].
  variants: [
    '',
    { query: '?q=zzzznomatch', expect: 'main textarea', minMatches: 1 },
  ],
  expect: 'main button',
  minMatches: 2,
},
```

GATES verification (read-only queries, 2026-09-10) — verified against the
page's GATES, not just row counts:

- Permission: harness user `viewspec@sim.test`
  (`01a08426-0962-74c7-a086-e1609c589dcb`, org
  `da472d3a-98e5-4fa5-a6ee-2451e6d6970a` "SIM · Summit Ridge
  Construction") holds role `Administrator`
  (`01a083e6-dc9e-7bf1-8c16-d6aa413b9655`), whose `permissions` array
  contains `"assistant.use"` AND `"assistant.write"`. `requirePermission`
  passes on both branches; `canWrite` resolves true.
- AI config: the harness org's `settings->'ai'` is NULL, so `readAi`
  returns `{}`, `getOrgAiConfig` returns null (no key to unseal), and
  `getModel(null, 'smart')` is null — `aiEnabled` is false on both paths.
  The page renders the `notConfiguredTitle` EmptyState + the
  `errors.notConfigured` notice in the composer slot. This is the
  `aiEnabled=false` branch — deterministic, no provider key needed, no
  fetch to AI backends. The `?q=` variant auto-send is a no-op here: the
  component's auto-send effect requires `aiEnabled`, so the prompt is
  accepted as `initialPrompt` and never sent — both paths keep the empty
  thread identically.
- `assertVariantsDiffer` (conformance.mjs:1640) fails an entry whose
  variants render byte-identical markup. The `?q=` variant differs from
  bare: `initialPrompt` travels from loader to widget props (and the
  component stamps it into its auto-send ref path), so the two captures
  are not identical. Kept to two variants because there is no second
  server-data branch to pin — conversations, messages, and AI enablement
  are covered by §3's fixture, not by params.
- No `table tbody tr` selector: the thread renders client-side after mount
  (fetch to `/api/assistant/*`, localStorage-free but stream-driven). The
  `renderSettled` quiescence loop may capture the stream at different fill
  states on the two passes. `main button` / `main textarea` name
  loader-independent static chrome only (New chat button, sidebar menu
  buttons, composer send/stop — all rendered on first paint from the same
  component on both paths).

## 3. Fixture SQL (for the coordinator — fold into `scripts/viewspec-fixtures.sql`)

Block claim: **…1401-1499 assistant conversations and messages** — FRESH,
verified 2026-09-10 by grepping every `00000000-0000-7000-9000-*` id in
`scripts/viewspec-fixtures.sql` (134 distinct ids; no `…1401`-`…1499`,
`…d*`, or `…e*` id present) and against the allocation table at the top of
the file (no 14xx block claimed). A collision would become a silent
`ON CONFLICT DO NOTHING` skip leaving the page empty.

Why rows are needed: the harness user owns ZERO `assistant`-scope
conversations today (verified: `count(*) = 0` for the harness user/org/
scope), and the sidebar is owner-scoped in SQL. Without rows both paths
render "No conversations yet" — a byte-perfect match of two empty states
that proves nothing about the sidebar path. One conversation + two
messages pins the populated branch; the empty branch stays pinned by the
fact that no OTHER user owns them (owner filter, not absence).

```sql
  -- ---- assistant ------------------------------------------------------------
  --
  -- /assistant is a fully client-side workbench whose only server data is
  -- the owner-scoped sidebar list. The harness user owns zero assistant
  -- conversations, so without rows both paths render "No conversations
  -- yet" — a byte-perfect match of two empty states that proves nothing.
  -- One conversation + two messages (user question, assistant answer with
  -- UI-message parts) pins the populated sidebar branch. Block …1401-1499
  -- is FRESH (no 14xx id anywhere in this file; allocation table claims no
  -- 14xx block) — a collision would be a SILENT ON CONFLICT skip.
  -- ai_conversations / ai_messages carry NO triggers, so fixed ids insert
  -- plainly. Scoped to the SIM org + harness user only; nothing here
  -- touches a real tenant.
  insert into ai_conversations (id, org_id, user_id, scope, title, created_by, updated_by)
  select '00000000-0000-7000-9000-000000001401', v_org, v_user, 'assistant',
         'ViewSpec bank balances', v_user, v_user
   where exists (select 1 from users where id = v_user)
  on conflict (id) do nothing;

  insert into ai_messages (id, org_id, conversation_id, role, content, data, created_by, updated_by)
  select '00000000-0000-7000-9000-000000001402', v_org,
         '00000000-0000-7000-9000-000000001401', 'user',
         'What is the balance of our bank accounts right now?', null, v_user, v_user
   where exists (select 1 from ai_conversations where id = '00000000-0000-7000-9000-000000001401')
  on conflict (id) do nothing;

  insert into ai_messages (id, org_id, conversation_id, role, content, data, created_by, updated_by)
  select '00000000-0000-7000-9000-000000001403', v_org,
         '00000000-0000-7000-9000-000000001401', 'assistant',
         'Your bank accounts total $12,340.56.',
         '{"parts": [{"type": "text", "text": "Your bank accounts total $12,340.56."}]}',
         v_user, v_user
   where exists (select 1 from ai_conversations where id = '00000000-0000-7000-9000-000000001401')
  on conflict (id) do nothing;
```

Notes for the coordinator:

- `v_user` must resolve to the harness user. The approvals block in the
  same file already does exactly this
  (`select id into v_user from users where org_id = v_org and email =
  'viewspec@sim.test'`) — reuse that declaration if the assistant block
  lands after it, else repeat the select. The `where exists` guards keep
  the block a no-op when the harness user is absent (same idiom as the
  approvals `v_docs is null` early return).
- `ai_messages.data` is `jsonb` (nullable): the `jsonb_build_object`
  idiom used elsewhere in this file works too; the string literal above
  relies on implicit cast. The `parts` array exercises the component's
  `toChatMessage` stored-parts path (as opposed to the
  `{type:'text',text:content}` fallback) — the shape the chat API
  persists after a real streamed turn.
- `created_by`/`updated_by` are nullable; `created_at`/`updated_at`
  default to `now()`. The sidebar orders by `updated_at desc`; a single
  conversation needs no explicit timestamp.
- Deliberately NO `assistant.write`-negative variant: the harness user
  holds `assistant.write`, and permissionBOOLs are loader-resolved flags
  (`writeHint` paragraph), not URL branches — there is no query param
  that flips them.
- Deliberately NO `aiEnabled=true` fixture: enabling AI would require
  sealing a provider key into the SIM org's `settings->'ai'`, which is a
  real credential in a seed file. The `false` branch (deterministic,
  keyless) is what the harness pins.

Do NOT register the §2 entry until this §3 is applied: without the
fixture the `main button` count still matches (static chrome renders
either way), but the comparison would be two empty sidebars.

## 4. What the spec does NOT cover (nothing renderable is missing)

- No composite cells, so no `sections.tsx` cell components and no local
  component to move. `AssistantApp` is shared with the `[id]` sibling
  route (`web/app/(app)/assistant/[id]/page.tsx`, NOT under conversion),
  so it stays in `web/components/assistant/` — moving it into the
  converting dir would break the sibling's import. The widget renders it
  directly with loader-resolved props; there is exactly one
  implementation on all paths.
- The streaming thread, tool-use cards, proposal cards, rename/delete
  menus, mobile drawer state, and all `/api/assistant/*` fetch logic are
  untouched — client behavior, not server content, inexpressible by design
  (no conditionals, no function values, no component references).
- `layout: 'bare'` is load-bearing, not a default: the native root is
  `flex h-full min-h-0 flex-1` under the app shell's `<main>` (which the
  harness scopes, not anything ModuleView wraps). `list`/`detail` would
  nest a second `ListPageLayout` (sticky header container + padded body)
  around the workbench and break pixel parity. Same call as the
  `query-console` spec.
- No `pageHeader` block and no message keys in the spec: the native page
  has no server-rendered header — title, welcome copy, suggestions, and
  all chrome stay inside the component's own `useTranslations('assistant')`
  calls (`title`, `newChat`, `history`, `placeholder`, `welcomeTitle`,
  `suggestions.s1-4`, `errors.*` — all present in
  `web/messages/en/assistant.json`, none invented). Threading static
  strings through widget props instead would double every key and drift
  from the catalog on the first copy edit (query-console precedent,
  INTEGRATION.md §1).
- The `assistant.use` gate runs in the LOADER before any data — both
  branches 403/redirect identically when the permission is absent. Nothing
  travels through the spec for it: an org id in spec props would be a
  cross-tenant read.
- `?q=` array handling: `pickString`-style single-string check inline
  (`typeof q === 'string'`) — the same semantics as the native
  `initialPrompt={typeof q === 'string' ? q : undefined}`. No new import:
  `parseListParams`/`pickString` would pull list-page machinery into a
  page with no list params.
- The `[id]` conversation route is out of scope (this brief covers
  `/assistant` only). Its loader adds `ownsConversation` + `recentMessages`
  behind the same whole-component treatment; flagged here so the
  coordinator can task it as a follow-up without colliding with this dir.

## 5. Pre-existing state of the merged base (not mine, not touched)

`git merge --no-edit main` reported "Already up to date" — no conflicts, no
new files from main.
