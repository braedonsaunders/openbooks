# /docs/[slug] ViewSpec integration handoff

Page: `web/app/(app)/docs/[slug]/` — owner files are `view.ts`, `sections.tsx`
(shared `DocArticleView` component, imported back into `page.tsx` so both
render paths use one implementation) and the `__viewspec` branch + imports in
`page.tsx`.

Spec widgets used: one — `doc-article` (proposed below; does not exist in the
registry yet). No slots, no registry vocab changes, no fixture SQL: the page
reads no database, takes no query params, and performs no permission check.

## 1. WIDGET_REGISTRY entry (for the coordinator — `web/components/viewspec/widgets.tsx`)

New import needed (already exists as a component in this directory):

```tsx
import { DocArticleView } from '../../app/(app)/docs/[slug]/sections'
```

Entry:

```tsx
/* --- doc article ----------------------------------------------------------- */
/** Static help-center article: breadcrumb, Markdown body, related links and
 *  prev/next cards. Same whole-component doctrine as `docs-home` — the page
 *  is conditional PAIRS (category span, related block, adjacent nav,
 *  prev/next cards) that generic vocabulary cannot name without NEW language
 *  (coordinator-owned): `when` can omit a block but cannot choose between
 *  two, and the prev/next cards are styled composites (one `<a>` holding a
 *  lucide icon + two text rows). Icons alone (`ChevronRight`, `ArrowLeft`,
 *  `ArrowRight` via lucide) force a widget — specs name no components. */
'doc-article': (props) => (
  <DocArticleView content={props.content as ComponentProps<typeof DocArticleView>['content']} />
),
```

Why one entry and not generic blocks: every region of the page is either a
conditional pair or a styled composite that generic vocabulary cannot name
without NEW language (coordinator-owned): the breadcrumb category span
(link + chevron + span, omitted when the category lookup misses); the body
(`ChatMarkdown`, a client component — specs name no components); the related
block (`<div>` + `<h2>` + `<ul>`, omitted when empty); the adjacent nav
(em-dash-free conditional pair: a prev card or a bare `<span/>` placeholder
when only next exists, a next card or nothing when only prev exists — the
bare `<span/>` placeholder matters for the `sm:grid-cols-2` layout).

Prop shape: FLAT. The widget receives exactly one prop, `content`, whose value
is the whole `DocArticleContent` object (strings, nullable strings, and plain
`{ slug, title }` link records). It is NOT spread — `props.content`, not
`{...props}`. The loader precomputes the four `t(...)` label strings and the
`lastUpdated` interpolation (`t('lastUpdated', { date })`) so no function
values cross the boundary. The body travels as RAW Markdown — the native page
renders it client-side via ChatMarkdown (react-markdown), so the loader must
NOT pre-render or format it (same rule as a browser-locale date).

## 2. Proposed conformance registry entry (for the coordinator — `scripts/viewspec-conformance.mjs`)

Content counts VERIFIED against the registry via `tsx` (no DB involved on this
page — static content; GATES: none, the page performs no permission check):

- `welcome`: no related, no previous, next=`quick-start` → 1 article link + no `ul`
- `file-cabinet`: 3 related, previous=`audit-log`, no next → 4 links + bare `<span/>` placeholder
- `apps`: 2 related, previous + next → 4 links
- `quick-start`: 3 related, previous + next → 5 links
- every article has a matching category (category span always rendered)

```js
{
  path: '/docs/quick-start',
  // Middle article: related block + both prev/next cards. Branch coverage
  // comes from DISTINCT paths (each slug is its own page state), not query
  // params — the page reads no search params, so a query variant that
  // cannot differ from the default is not coverage and the harness
  // rejects it.
  variants: [
    { query: '', expect: 'article ul a[href^="/docs/"]', minMatches: 3 },
    { query: '', expect: 'article nav a[href^="/docs/"]', minMatches: 2 },
  ],
  expect: 'article a[href^="/docs/"]',
  minMatches: 5,
},
{
  path: '/docs/welcome',
  // First article: no related block, next-only nav (bare `<span/>`
  // placeholder takes the prev slot).
  variants: [
    { query: '', expect: 'article nav a[href^="/docs/"]', minMatches: 1 },
  ],
  expect: 'article nav a[href="/docs/quick-start"]',
  minMatches: 1,
},
{
  path: '/docs/file-cabinet',
  // Last article: related block + prev-only nav.
  variants: [
    { query: '', expect: 'article ul a[href^="/docs/"]', minMatches: 3 },
  ],
  expect: 'article nav a[href="/docs/audit-log"]',
  minMatches: 1,
},
```

## 3. What the spec does NOT cover (nothing — full coverage)

- No GATES: the native page performs no permission check (available to every
  signed-in user per `layout.tsx`), so the loader performs none either.
- No slots: nothing needs an Authz, an org id or a user id.
- No fixture SQL: nothing to fixture; article content is bundled TS modules.
  No FRESH id block to claim, no trigger/CHECK guard needed — there is no
  insert at all.
- `notFound` for an unknown slug runs in the loader in both paths (verbatim
  from the native page), so no 404 variant: the harness compares renders, and
  a not-found slug renders the same not-found page on both paths.
- `generateStaticParams` / `generateMetadata` are untouched (build-time
  pre-render + `<head>` metadata, not page body).
- No `repeat.unwrapped` / `frame` / `table` vocabulary needed: the whole body
  is the one widget, and `layout: 'bare'` because the component owns its own
  `max-w-3xl` container (same reason as the docs home).
- The `related` unknown-slug filter (`.filter(Boolean)`) is preserved verbatim
  in both paths.

## 4. Pre-existing breakage in the merged base (none from me)

`git merge --no-edit main` reported "Already up to date". `node_modules`
symlinks were created per the task setup (repo node_modules → main checkout)
for the typecheck; no packages installed.
