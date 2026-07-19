// In-app documentation content model.
//
// Docs are authored as typed TS modules (not .md files on disk) so the content
// is BUNDLED into the JS output — this is deploy-safe under Next standalone,
// where arbitrary filesystem reads are not traced into the runtime image.
//
// Authoring conventions for `body` (Markdown, rendered by react-markdown +
// remark-gfm). To keep the content inside a TS template literal robust, do NOT
// use backticks:
//   • identifiers / UI labels / option values  →  **bold**  (e.g. **account_group**)
//   • code / config blocks                      →  ~~~ tilde fences ~~~
// Tables, lists, headings, and links all work normally.

export interface DocArticle {
  /** Stable URL id (never change once shipped — links/bookmarks depend on it). */
  slug: string
  title: string
  /** Category key (see DocCategory.key). */
  category: string
  /** Sort order within the category. */
  order: number
  /** One-line summary shown on cards and in search results. */
  summary: string
  /** ISO date (YYYY-MM-DD) the article content was last revised. */
  updated: string
  /** Markdown body. See authoring conventions above. */
  body: string
  /** Optional related-article slugs shown at the foot of the page. */
  related?: string[]
  /** Optional keywords to widen search matching beyond title/summary. */
  keywords?: string[]
}

export interface DocCategory {
  /** Stable category key. */
  key: string
  title: string
  /** One-line description shown on the docs home cards. */
  description: string
  /** nav-icon key (see components/sidebar-nav ICONS). */
  icon: string
  /** Sort order across the docs home + sidebar. */
  order: number
}
