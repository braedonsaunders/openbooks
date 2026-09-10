# /docs ViewSpec integration handoff

Page: `web/app/(app)/docs/` — owner files are `view.ts`, `sections.tsx` (shared
`DocsHome` component, imported back into `page.tsx` so both render paths use
one implementation) and the `__viewspec` branch + imports in `page.tsx`.

Spec widgets used: one — `docs-home` (proposed below; does not exist in the
registry yet). No slots, no registry vocab changes, no fixture SQL: the page
reads no database and takes no query params.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (already exists as a component in this directory):

```tsx
import { DocsHome } from '../../app/(app)/docs/sections'
```

Entry:

```tsx
/* --- docs home ------------------------------------------------------------ */
/** Static help-center home: gradient hero, start-here cards, switching pills
 *  and a card per category. Same whole-component doctrine as `reports-hub`
 *  and `analytics-hub` — decomposing styled composite cards would
 *  reimplement the component, not compose it. */
'docs-home': (props) => (
  <DocsHome content={props.content as ComponentProps<typeof DocsHome>['content']} />
),
```

Why one entry and not generic blocks: every region of the page is a composite
that generic vocabulary cannot name without NEW language (coordinator-owned):
the hero (gradient panel + lucide `BookOpenCheck` tile + eyebrow/title/subtitle
—
`panel` has no icon tile or gradient, `pageHeader` renders the list chrome);
the start-here cards (a step label + title/arrow row + summary inside one
`<a>`);
the violet switching pills; the category cards (count badge + description +
article links with hover-reveal arrows). Icons alone (`BookOpenCheck`,
`Compass`,
`Replace`, `ArrowRight` via lucide) force a widget — specs name no components.

Prop shape: FLAT. The widget receives exactly one prop, `content`, whose value
is the whole `DocsHomeContent` object (strings, string arrays, and plain
article/category records). It is NOT spread — `props.content`, not
`{...props}`.
The loader precomputes the two derived string lists (`stepLabels`,
`switchingShortTitles`) so no function values cross the boundary.

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Content counts VERIFIED against the registry via `tsx` (no DB involved on this
page — static content; GATES: none, the page has no permission checks):

- 10 category groups, 66 articles total
- 3 start-here cards (`welcome`, `quick-start`, `migration-and-cutover`)
- 2 switching pills ("Switching from a Small Business System", "Switching from
  an Enterprise System" — the "Coming from " strip is vacuous on current
  titles, kept verbatim from the native page)

```js
{
  path: '/docs',
  // Static help-center home: one `docs-home` widget. No DB, no gates, no
  // query params — the single default variant covers the whole page. Ten
  // category sections, three start-here cards, two switching pills, and 66
  // article links (3 start-here + 2 switching + 66 browse − 5 duplicated
  // across sections = 66 unique /docs/<slug> hrefs on the page).
  variants: [{ query: '', expect: 'main section[id]', minMatches: 10 }],
  expect: 'main a[href^="/docs/"]',
  minMatches: 66,
},
```

Selector notes: `main` is the app-shell element; the docs layout renders the
page inside it. `section[id]` counts the ten category cards (they are the only
`<section>` elements carrying an `id`). The `expect` link count: start-here 3
+ switching 2 + browse 66 = 71 `<a>` elements, of which 66 are unique
`/docs/<slug>` hrefs (the 5 start-here/switching links duplicate browse
links), so `minMatches: 66` on distinct-href matching holds either way; on
raw-element matching the count is 71 ≥ 66.

## 3. What the spec does NOT cover (nothing — full coverage)

- No GATES: the native page performs no permission check (available to every
  signed-in user per `layout.tsx`), so the loader performs none either.
- No query variants: the page reads no search params. A variant that cannot
  differ from the default is not coverage, and the harness rejects it — so
  there is exactly one variant.
- No fixture SQL: nothing to fixture; article content is bundled TS modules.
- The `article.title.replace('Coming from ', '')` transform is preserved
  verbatim in both paths (loader precomputes `switchingShortTitles`).
- The `t('home.step', { number })` and pluralized `t('home.articleCount',
  { count })` formatting runs in the loader in both paths.
- No `repeat.unwrapped` / `frame` / `table` vocabulary needed: the whole body
  is the one widget, and `layout: 'bare'` because the component owns its own
  `max-w-5xl` container (same reason as the reports hub).

## 4. Pre-existing breakage in the merged base (none from me)

`git merge --no-edit main` reported "Already up to date". `node_modules`
symlinks were created per the task setup (repo node_modules → main checkout)
for the typecheck; no packages installed.
