# ViewSpec conversion brief — read this in full before writing anything

You are converting ONE page of the openbooks app to ViewSpec. Many agents are
working in this same checkout at the same time, so the file-ownership rules
below are not advice — breaking them destroys another agent's work.

## What ViewSpec is

`packages/viewspec` is a closed, declarative page-description language.
Renderers live in `web/components/viewspec/` (`blocks.tsx`, `cells.tsx`,
`widgets.tsx`, `module-view.tsx`).

**The one rule: THE LOADER COMPUTES. THE SPEC BINDS.**

A loader is ordinary TypeScript. It does permissions, queries, i18n,
formatting, and every derived flag, and it returns presentation-ready data. A
spec only names blocks and binds already-resolved fields. A spec contains **no**
conditionals, **no** arithmetic, **no** string building, **no** function values,
**no** component references, and **no** capability objects (no `Authz`, no
`orgId`, no bound server actions).

Corollaries you will hit:

- **Presence, not branching.** `when: f('someFlag')` OMITS a block. It cannot
  choose between two. A conditional PAIR (a link when published, an em-dash
  otherwise) is a component, not a spec construct.
- A cell that is more than one element (a link over a summary line; three
  optional badges in a wrapper) is a small component in `sections.tsx`, placed
  by the spec as `widgetCell('name', {...})`.
- `$root` inside a table row or `repeat` item resolves to the PAGE. Use
  `rootRef` for shared labels, `field` for per-row values.

## Your deliverable

For page `<PATH>` at `web/app/(app)/<DIR>/page.tsx`:

1. **`web/app/(app)/<DIR>/view.ts`** — `load<Name>(sp)` returning a flat,
   serializable data object, plus `<name>Spec(data): PageSpec`. Copy the
   native page's query, permission and formatting logic VERBATIM; do not
   "improve" it. Keep its comments where they explain a decision.
2. **`web/app/(app)/<DIR>/sections.tsx`** — only if the page needs composite
   cells. If the native page defines a local component you also need, MOVE it
   here and import it back into `page.tsx` so both render paths share one
   implementation. Never write a second copy.
3. **Edit `page.tsx`**: add, as the FIRST statements of the component body:

   ```tsx
   if ((await searchParams).__viewspec === '1') {
     const sp = await searchParams
     const data = await load<Name>(sp)
     return (
       <>
         {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
         <meta name="x-viewspec-render" content="1" />
         <ModuleView spec={<name>Spec(data)} data={data} searchParams={sp} trusted />
       </>
     )
   }
   ```

   The native branch STAYS. Both paths must keep working.
4. **`web/app/(app)/<DIR>/INTEGRATION.md`** — a handoff file containing:
   - the exact `WIDGET_REGISTRY` entries and imports your spec needs,
   - the conformance registry entry you propose (path, query variants that
     exercise the page's real branches, an `expect` selector and a
     `minMatches` count you have VERIFIED against the database),
   - anything you could not express and why.

## File ownership — do not violate

| File | Who edits |
|---|---|
| `web/app/(app)/<your page dir>/**` | you |
| `web/components/viewspec/widgets.tsx` | **the coordinator only** — put your entries in `INTEGRATION.md` |
| `scripts/viewspec-conformance.mjs` | **the coordinator only** — propose in `INTEGRATION.md` |
| `packages/viewspec/**` | **the coordinator only** — if you need new vocabulary, STOP and report it |
| anything else | nobody; report it instead |

Do **not** run `next build`, do **not** start a server, do **not** touch port
4780 or the Postgres on 55439 beyond read-only queries. One shared build exists
and the coordinator drives it.

## Correctness bar

This is accounting software. The conformance harness compares the native and
spec renders byte for byte in a real browser, so "close enough" fails.

- **Class strings must be identical**, including order-independent duplicates.
  Transcribe them; never retype from memory.
- **Message keys must exist.** Every `t('...')` you write must already be used
  by the native page or present in `web/messages/en/*.json`. An invented key
  throws at render time. Grep before you write.
- **Permission and visibility logic is load-bearing.** If the native loader
  filters a list by what the reader may see — including COUNTS — reproduce it
  exactly. A count is a disclosure.
- **Money, dates and numbers are formatted in the loader**, using the same
  formatter the native page used (`getMoneyFormatter`, `Intl.DateTimeFormat`
  with the same options, `.slice(0, 10)` — whatever it actually does).
- Verify row counts and ids with:
  `PGPASSWORD=openbooks_app psql -h 127.0.0.1 -p 55439 -U openbooks_app -d openbooks_sim_viewspec -Atc "set app.bypass_rls='on'; select ..."`
- Typecheck before you finish: `cd web && node_modules/.bin/tsc --noEmit -p tsconfig.json`
  It must be clean. Nothing else in the repo may newly fail.

## Worked examples to copy from

Read at least two before starting. They are the style guide.

- `web/app/(app)/reports/custom/view.ts` — plain admin list with sorting,
  filter chips, an empty state, and visibility-filtered counts.
- `web/app/(app)/parties/view.ts` — list + flyout drawer, composite role cell,
  drawer remount key.
- `web/app/(app)/continuous-close/view.ts` — two independent lists behind a
  tab, two pagers, `repeat` with `unwrapped`.
- `web/app/(app)/accounts/view.ts` — three mutually exclusive bodies chosen by
  three presence flags; a slot that re-derives `Authz` server-side.
- `web/app/(app)/ar/invoices/view.ts` — the universal record list with a
  drawer and per-row actions threaded through widget refs.

## When you are done

Reply with: the files you created, the widget entries and conformance entry
you propose, your typecheck result, and anything you could not express.
Do not claim the page is verified — only the harness can say that, and the
coordinator runs it.
