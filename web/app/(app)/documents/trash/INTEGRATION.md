# /documents/trash ViewSpec integration handoff

Page: `/documents/trash` — deleted files and folders. Back link, header, and
the empty/non-empty pair (empty state vs the `TrashList` table island with its
restore / delete-forever client behaviour).

Files created (all inside `web/app/(app)/documents/trash/`, the only dir this
page owns):

- `view.ts` — `loadTrash()` + `trashSpec(data)`. The loader copies the native
  page's query, permission and formatting logic verbatim
  (`documents.manage` gate, manager-baseline viewer, `listTrash`, `documents`
  + `documents.trash` namespaces, `fileTypes.*` badge labels, `inLocation`
  interpolation, `dateTime`). `loadTrash` takes no search params — the page
  has no filters, sorting or pagination — but the page component still threads
  `searchParams` through to `ModuleView` per the branch contract.
- `sections.tsx` — `TrashBackLink` (the back link above the header). Moved
  here from `page.tsx`, which imports it back, so both paths share one
  implementation; the spec places it as the `trash-back-link` widget. It
  stays a local component rather than `pageHeader({ back })` because the
  native markup (`next/link` + chevron + its own class string) is not what
  PageHeader's `back` slot renders (UiBackLink: `← label`, different
  classes).
- `page.tsx` — viewspec branch added FIRST in the component body (exact
  snippet from the brief); native branch unchanged apart from rendering the
  shared back-link component.

## WIDGET_REGISTRY entries needed (coordinator: add to `web/components/viewspec/widgets.tsx`)

```tsx
import { TrashList } from '../../app/(app)/documents/trash/TrashList'
import { TrashBackLink } from '../../app/(app)/documents/trash/sections'
import { ChevronLeft, Trash2 } from 'lucide-react' // ADD to the existing lucide-react imports

/* --- trash -------------------------------------------------------------- */
/**
 * The back link above the trash header. Shared implementation with the
 * native path (see trash/sections.tsx): the PageHeader `back` slot renders
 * UiBackLink (`← label`, different classes), not this chevron link.
 */
'trash-back-link': (props) => (
  <TrashBackLink href={str(props, 'href') ?? '/documents'} label={str(props, 'label') ?? ''} />
),
/**
 * The trash table with restore / delete-forever behaviour. Passed whole —
 * like the file list — because row busy state, the purge confirm dialog
 * and the per-row fetches + toasts are client state the spec cannot name.
 *
 * EXACT prop shape of TrashList (coordinator: wire verbatim):
 *   { items: TrashRow[] }
 * where TrashRow = {
 *   kind: 'folder' | 'file'; id: string; name: string;
 *   fileTypeLabel: string | null; folderName: string | null;
 *   modifiedLabel: string;
 * }
 * The loader's `rows` field already has exactly this shape, so the spec
 * passes it through as `rows` and the entry remaps the key:
 */
'trash-list': (props) => (
  <TrashList items={(props.rows as ComponentProps<typeof TrashList>['items']) ?? []} />
),
```

No new slot is needed: the trash table takes plain loader-resolved data (no
org id, no permission decision, no server action crosses the spec boundary).

## Empty-state icon (coordinator: extend the `empty-state` widget's icon map)

The native empty state renders `icon={<Trash2 className="h-8 w-8" />}`. The
`empty-state` widget's closed icon map has no trash entry, so the spec passes
`icon: 'trash'` and the registry entry needs one addition:

```tsx
// In the 'empty-state' widget's `icons` map, add:
'trash': <Trash2 className="h-8 w-8" />,
```

Fidelity note: the map renders its icons bare while `EmptyState` wraps them
in `[&_svg]:h-7 [&_svg]:w-7`, so any `h-8 w-8` class on the icon is
overridden to `h-7 w-7` on BOTH paths identically (native included) — the
comparison still holds byte for byte.

## Fixture SQL needed (coordinator: append to `scripts/viewspec-fixtures.sql`)

The live sim tenant holds **2 folders and 2 files but zero trashed rows**
(verified: `folders where is_inactive and not is_system` → 0,
`files where is_inactive` → 0), so the page compares two identical empty
states without fixtures. Claiming fresh block `…5811–5814` inside the
`…5801-5899` file-cabinet allocation (verified via grep: suffixes
`000000005801`–`000000005804` are the only `…58*` ids in the file):

```sql
  -- ---- trash -----------------------------------------------------------
  -- The sim tenant never deletes cabinet rows, so /documents/trash would
  -- compare two identical empty states. One trashed folder plus one trashed
  -- file (with one version row), both inactive but not private/system so the
  -- harness admin sees them through listTrash's visibility predicates.
  -- Block …5811–5814 claimed by the trash conversion; verified free.
  declare
    v_trash_folder uuid := '00000000-0000-7000-9000-000000005811';
    v_trash_file uuid := '00000000-0000-7000-9000-000000005812';
    v_trash_file_folder uuid := '00000000-0000-7000-9000-000000005813';
    v_trash_version uuid := '00000000-0000-7000-9000-000000005814';
  begin
    insert into folders (id, org_id, parent_folder_id, name, is_inactive)
    values (v_trash_folder, v_org, null, 'ViewSpec Trashed Folder', true),
           (v_trash_file_folder, v_org, null, 'ViewSpec Trash Location', false)
    on conflict (id) do nothing;

    insert into files
      (id, org_id, folder_id, name, extension, file_type, content_type,
       size_bytes, storage_kind, content_hash, is_inactive)
    values
      (v_trash_file, v_org, v_trash_file_folder, 'viewspec-trashed.txt', 'txt',
       'text', 'text/plain', 42, 'db',
       'viewspec-trash-file-5812', true)
    on conflict (id) do nothing;

    insert into file_versions (id, file_id, version_number, size_bytes, content_type)
    values (v_trash_version, v_trash_file, 1, 42, 'text/plain')
    on conflict (id) do nothing;
  end;
```

Verified against the database (`openbooks_sim_viewspec`):

- Before fixtures: trashed folders → **0**, trashed files → **0**.
- After the fixture: the page shows **1 folder row + 1 file row** →
  `minMatches: 2` against `table tbody tr` is exact.
- The file row renders the location suffix (`inLocation` →
  "in ViewSpec Trash Location"), exercising the `folderName` branch; the
  folder row renders the `folderLabel` badge and the file row the `Text`
  file-type badge.
- The default empty variant needs no fixture (0 inactive rows today).

## Proposed conformance entry (coordinator: add to `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/documents/trash',
  // Trash: back link + header in a bare shell, then the empty state or the
  // trash-list widget. Fixture rows are seeded by the trash block in
  // scripts/viewspec-fixtures.sql (…5811–5814); one folder row + one file
  // row, so minMatches 2 is exact.
  variants: [''],
  expect: 'table tbody tr',
  minMatches: 2,
},
```

Note: unlike most list pages there is no query-variant branch to pin — the
page has no search, filters, sorting, pagination or drawers, so the single
default variant covers both the only body branch (rows present) and, on an
unseeded tenant, the identical empty states. A can't-happen empty-with-rows
variant is not proposed.

## Could not express

Nothing structural. Three fidelity notes for the coordinator:

1. The shell (`flex h-full min-h-0 flex-col`, header strip, `app-scroll …
   overflow-auto` body column) is grids with transcribed class strings — no
   wrapper markup is added or lost.
2. The back link is a `trash-back-link` widget wrapping the shared
   `TrashBackLink` component, NOT `pageHeader({ back })`: PageHeader's back
   slot renders UiBackLink (`← label`, `text-xs text-slate-500
   hover:text-teal-700 …`) while the native page renders a `next/link` with
   a `ChevronLeft` icon and `… hover:text-slate-800 …` classes.
3. The harness user must hold `documents.manage` (the sim admin does);
   otherwise both paths 404/redirect identically via `requirePermission`.
