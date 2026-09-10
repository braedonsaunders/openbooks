# /documents ViewSpec integration handoff

Page: `/documents` — the file cabinet: sidebar folder tree, breadcrumb,
paginated folder+file table, three URL-backed drawers (`?file=`,
`?folder=<id>`, `?folder=new`), header actions (trash link, new-folder,
upload).

Files created (all inside `web/app/(app)/documents/`, the only dir this page owns):

- `view.ts` — `loadDocuments(sp)` + `documentsSpec(data)`. The loader copies
  the native page's query, permission and formatting logic verbatim
  (`documents.read` gate, org-role baseline + resource_grants viewer, parallel
  tree/contents/path fetch, `?file=`/`?folder=` flyout resolution,
  `folderHref` builder, `formatSize`, `dateTime`); counts and row shapes are
  the visibility-filtered ones the page itself renders (a count is a
  disclosure).
- `sections.tsx` — `DocumentsBreadcrumb` (sticky strip: home link + last-crumb
  span vs link pair) and `DocumentsActions` (trash link + new-folder + upload
  cluster). The native `page.tsx` imports both back, so both paths share one
  implementation; the spec places the breadcrumb as the `documents-breadcrumb`
  widget and the actions as `documents-actions` (also reused by name as the
  empty-state action, exactly as the native page passes the same `actions`
  node to both PageHeader and EmptyState).
- `page.tsx` — viewspec branch added FIRST in the component body; native branch
  unchanged apart from rendering the two shared components.

## WIDGET_REGISTRY entries needed (coordinator: add to `web/components/viewspec/widgets.tsx`)

```tsx
import { FolderTree } from '../../app/(app)/documents/FolderTree'
import { FileList } from '../../app/(app)/documents/FileList'
import { FileDrawer } from '../../app/(app)/documents/FileDrawer'
import { FolderDrawer } from '../../app/(app)/documents/FolderDrawer'
import { UploadButton } from '../../app/(app)/documents/UploadButton'
import { NewFolderButton } from '../../app/(app)/documents/NewFolderButton'
import { DocumentsActions, DocumentsBreadcrumb } from '../../app/(app)/documents/sections'

/* --- file cabinet ------------------------------------------------------- */
/**
 * The header actions cluster. `newFolderParentId` arrives loader-resolved;
 * the two buttons are client components that own their labels and behaviour.
 */
'documents-actions': (props) => (
  <DocumentsActions
    trashHref={str(props, 'trashHref') ?? '/documents/trash'}
    trashLabel={str(props, 'trashLabel') ?? ''}
    newFolder={<NewFolderButton parentId={str(props, 'newFolderParentId') ?? undefined} />}
    upload={<UploadButton folderId={str(props, 'newFolderParentId') ?? undefined} />}
  />
),
/** Sticky breadcrumb strip: home link plus per-crumb href/isLast pairs. */
'documents-breadcrumb': (props) => (
  <DocumentsBreadcrumb
    homeHref={str(props, 'homeHref') ?? '/documents'}
    homeLabel={str(props, 'homeLabel') ?? ''}
    crumbs={(props.crumbs as ComponentProps<typeof DocumentsBreadcrumb>['crumbs']) ?? []}
  />
),
/** Collapsible sidebar tree. Client state (collapsed sets) is internal. */
'folder-tree': (props) => (
  <FolderTree
    folders={(props.folders as ComponentProps<typeof FolderTree>['folders']) ?? []}
    activeFolderId={str(props, 'activeFolderId') ?? undefined}
  />
),
/**
 * The folder+file table with checkboxes, context menu and bulk bar. Passed
 * whole — like the approvals table — because selection state, menu targets
 * and bulk fetches are client state the spec cannot name.
 */
'file-list': (props) => (
  <FileList
    folders={(props.folders as ComponentProps<typeof FileList>['folders']) ?? []}
    files={(props.files as ComponentProps<typeof FileList>['files']) ?? []}
    activeFolderId={str(props, 'activeFolderId') ?? undefined}
    showLocation={props.showLocation === true}
    canEdit={props.canEdit === true}
    canDelete={props.canDelete === true}
    currentParams={(props.currentParams as ComponentProps<typeof FileList>['currentParams']) ?? {}}
    sort={str(props, 'sort') ?? 'name'}
    dir={(str(props, 'dir') ?? 'asc') as ComponentProps<typeof FileList>['dir']}
  />
),
/** File flyout. Remount key rides along as a prop (same rule as
 *  account-drawer / party-drawer): the native FileDrawer resets its state
 *  from `file.name` via useState initialisers, so a reused position would
 *  keep the previous file's edit state. */
'file-drawer': (props) => {
  const drawer = props.drawer as (ComponentProps<typeof FileDrawer> & { remountKey: string }) | null
  if (!drawer) return null
  const { remountKey, ...rest } = drawer
  return <FileDrawer key={remountKey} {...rest} />
},
/** Folder create/edit flyout. Same remount-key rule as the file drawer. */
'folder-drawer': (props) => {
  const drawer = props.drawer as (ComponentProps<typeof FolderDrawer> & { remountKey: string }) | null
  if (!drawer) return null
  const { remountKey, ...rest } = drawer
  return <FolderDrawer key={remountKey} {...rest} />
},
```

`'search-input'`, `'empty-state'` and `'pagination'` already exist and need no
change. No new slot is needed: unlike the entity/record lists, every island on
this page (tree, table, drawers) already takes plain data props — no org id,
no permission decision, no server action crosses the spec boundary. The two
buttons take only an optional folder id, which the loader resolves.

## Fixture SQL needed (coordinator: append to `scripts/viewspec-fixtures.sql`)

The sim tenant holds **zero** folders and **zero** files, so the page compares
two identical empty states without fixtures. Claiming fresh block
`…000000000801–0803` (verified: no `0000-7000-9000-0000000008*` id exists in
the fixtures file):

```sql
-- ---- file cabinet -------------------------------------------------------
-- The simulator never creates folders or files, so /documents would compare
-- two identical empty states. One root folder, one child folder, one file in
-- the child (with one version row so versionCount = 1).
-- Block …0801–0803 claimed by the documents conversion; verified free.
do $$
declare
  v_org uuid;
  v_root uuid := '00000000-0000-7000-9000-000000000801';
  v_child uuid := '00000000-0000-7000-9000-000000000802';
  v_file uuid := '00000000-0000-7000-9000-000000000803';
  v_version uuid := '00000000-0000-7000-9000-000000000804';
begin
  select id into v_org from orgs where name like 'SIM · %' order by name limit 1;
  if v_org is null then
    raise notice 'no SIM org present; skipping ViewSpec fixtures';
    return;
  end if;

  insert into folders (id, org_id, parent_folder_id, name)
  values (v_root, v_org, null, 'ViewSpec Cabinet'),
         (v_child, v_org, v_root, 'ViewSpec Subfolder')
  on conflict (id) do nothing;

  insert into files (id, org_id, folder_id, name, extension, file_type, content_type, size_bytes)
  values (v_file, v_org, v_child, 'viewspec-fixture.txt', 'txt', 'text', 'text/plain', 42)
  on conflict (id) do nothing;

  insert into file_versions (id, file_id, version_number, size_bytes, content_type)
  values (v_version, v_file, 1, 42, 'text/plain')
  on conflict (id) do nothing;
end $$;
```

Verified against the database (`openbooks_sim_viewspec`, before fixtures):

- `select count(*) from folders` → **0**; `select count(*) from files` → **0**.
- After the fixture: default variant (virtual root) shows **1 folder row, 0
  file rows** (files never live at the virtual root), so `minMatches: 1`
  against `table tbody tr` is exact-conservative.
- `?fid=…0801` shows **1 folder row + 1 file row** → `minMatches: 2`.
- `?file=…0803` opens the file flyout (portaled to `<body>`, hence the
  explicit drawer scope).

## Proposed conformance entry (coordinator: add to `scripts/viewspec-conformance.mjs`)

```js
{
  path: '/documents',
  // File cabinet: folder tree + file table as widgets, breadcrumb, pager,
  // and the file flyout portaled to <body>. Fixture rows are seeded by the
  // documents block in scripts/viewspec-fixtures.sql (…0801–0804).
  variants: [
    '',
    { query: '?fid=00000000-0000-7000-9000-000000000801', expect: 'table tbody tr', minMatches: 2 },
    {
      query: '?file=00000000-0000-7000-9000-000000000803',
      expect: '[data-drawer-layer]',
      minMatches: 1,
      scopes: ['main', '[data-drawer-layer]'],
    },
  ],
  expect: 'table tbody tr',
  minMatches: 1,
},
```

## Could not express

Nothing structural. Three fidelity notes for the coordinator:

1. The shell (`flex h-full min-h-0 flex-col`, header strip, `flex min-h-0
   flex-1` body, `app-scroll … overflow-auto` listing column) is grids with
   transcribed class strings — no wrapper markup is added or lost.
2. The pager uses `bare: true`: the native page puts `<Pagination>` flush in
   the padded listing column with no `mt-3` wrapper.
3. The harness user must hold `documents.manage` for the actions cluster to
   render (the sim admin does); otherwise header and empty-state actions are
   absent on BOTH paths by the same `canManage` flag, so the comparison still
   holds.
