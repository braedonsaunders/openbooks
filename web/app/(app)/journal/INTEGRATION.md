# /journal ViewSpec integration handoff

Page: `/journal` — posted journal entries (entity list) with a draft-manual-journals
panel above and the manual-journal flyout (`?entry=` over DOCUMENT ids).

Files created (all inside `web/app/(app)/journal/`, the only dir this page owns):

- `view.ts` — `loadJournal(sp)` + `journalSpec(data)`. The loader copies the
  native page's query, permission and formatting logic verbatim (subsidiary-gated
  `entryVisibility`, `journalsOnly` predicate, draft-docs query, `?entry=new`
  instant-draft redirect, `resolveFormLayout`); the count for the header
  description uses the same predicate (a count is a disclosure).
- `sections.tsx` — `JournalDraftsPanel`, the drafts heading + per-draft link
  rows. The native `page.tsx` imports it back, so both paths share one
  implementation; the spec places it as the `journal-drafts` widget.
- `page.tsx` — viewspec branch added FIRST in the component body; native branch
  unchanged apart from rendering the shared panel.

## WIDGET_REGISTRY entries needed (coordinator: add to `web/components/viewspec/widgets.tsx`)

```tsx
import { JournalDraftsPanel } from '../../app/(app)/journal/sections'
import { JournalDrawer } from '../../app/(app)/journal/JournalDrawer'
import { NewJournalButton } from '../../app/(app)/journal/NewJournalButton'

/* --- journal ------------------------------------------------------------ */
'journal-drafts': (props) => (
  <JournalDraftsPanel
    heading={str(props, 'heading') ?? ''}
    drafts={(props.drafts as ComponentProps<typeof JournalDraftsPanel>['drafts']) ?? []}
  />
),
'journal-drawer': (props) => {
  const drawer = props.drawer as ComponentProps<typeof JournalDrawer> | null
  if (!drawer) return null
  return <JournalDrawer {...drawer} />
},
'new-journal': () => <NewJournalButton />,
```

`'entity-list-view'` already exists and needs no change. The journal drawer is
NOT given a `key={remountKey}`: the native page renders `<JournalDrawer>`
without a key (it resets its own state via `useEffect` on `doc.id`), so adding
one would diverge. This differs from the account/party drawers deliberately.

`NewJournalButton` needs no props and checks no permission client-side — the
`/api/journals/draft` endpoint enforces `gl.post`, exactly as on the native path.

## What the coordinator must NOT create

No new slot is needed. `entity-list-slot.tsx` already re-derives org id, user id
and `canManage` from the session; the journal page passes no capability through
the spec. The list's own `?txn=` row-drawer surface is owned by
`EntityListView` internally and renders identically on both paths because both
paths render the same component with the same `sp`.

## Proposed conformance entry (coordinator: add to `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/journal',
  // Entity list over posted journal entries, plus the drafts panel (empty in
  // the sim tenant) and the manual-journal flyout over a document id.
  variants: [
    '',
    // The manual-journal flyout, portaled to <body>.
    {
      query: '?entry=01a083e7-3954-7d4a-b2cc-c6a29f094351',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 5,
},
```

Verified against the database (`openbooks_sim_viewspec`, harness user
`viewspec@sim.test`, org `da472d3a-98e5-4fa5-a6ee-2451e6d6970a`, role `admin`):

- `journal_entries` visible under the page's own `journalsOnly` predicate for
  this org: **14** (all `JE-*` posted journal documents; the ~400 other entries
  are subledger postings the page deliberately excludes). Default list page
  size is 25, so all 14 render on page one — `minMatches: 5` is conservative.
- Draft journal documents for this org: **0**, so the default variant exercises
  the `hasDrafts === false` branch. The drafts panel cannot be exercised
  against the sim tenant without inserting a draft; the widget is a 1:1 move of
  the native markup into the shared component.
- Drawer id `01a083e7-3954-7d4a-b2cc-c6a29f094351` is `JE-00010`, kind
  `journal`, status `posted`, most recent `created_at` in the org. Note: it is
  POSTED, so the drawer opens read-only; the edit-mode branch
  (`?entry=<id>&mode=edit`, draft only) has no fixture in the sim tenant.
- `subsidiary_id` on the journal docs is non-null and the org has 1 subsidiary;
  `allowedSubsidiaryIds` for the harness admin resolves to null (unrestricted),
  so neither visibility predicate filters anything out for this user.

## Could not express

Nothing structural. Two coverage notes (above): the drafts panel's non-empty
branch and the drawer edit-mode branch have no sim-tenant fixture, so the
harness can only compare the empty/hidden drafts branch and the read-only
drawer. Both widgets are verbatim moves of native markup, not re-expressions.
