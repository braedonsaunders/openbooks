/**
 * Read every page's loader/spec contract out of its source.
 *
 * Every page in the app is a `view.ts` exporting a loader and a spec builder,
 * and `page.tsx` wires the two together. That wiring is the only place the
 * pairing is written down, which means nothing else — an agent asked to
 * customize a page, an admin screen listing what is customizable — can find a
 * route's layout without a human having transcribed it first. A transcribed
 * list is a list that silently stops covering new pages.
 *
 * So this reads the pairing back out of the source. The registry it writes is
 * DATA plus lazy `import()` closures: naming a module is not loading it, so a
 * caller that describes one route does not drag 165 loaders and their query
 * graphs into its bundle.
 *
 * Pure on purpose: `generate-page-registry.mjs` writes the file, this module
 * only reads and formats. `web/lib/page-registry.test.ts` imports these same
 * functions to re-derive the facts and fail on drift, and a module that
 * regenerated the registry as a side effect of being imported would make that
 * test rewrite the very file it is checking.
 */
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()

/** Every `view.ts` under the app directory. */
export function findViews(dir) {
  const found = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) found.push(...findViews(full))
    else if (entry === 'view.ts') found.push(full)
  }
  return found.sort()
}

/** Split a parameter list on commas that are not inside `<>`, `{}` or `()`. */
function splitParams(text) {
  const parts = ['']
  let depth = 0
  for (const c of text) {
    if (c === '<' || c === '{' || c === '(' || c === '[') depth++
    else if (c === '>' || c === '}' || c === ')' || c === ']') depth--
    if (c === ',' && depth === 0) parts.push('')
    else parts[parts.length - 1] += c
  }
  return parts.map((part) => part.trim()).filter(Boolean)
}

/** The dynamic segments in a route pattern, in order: `[accountId]` → `accountId`. */
function segmentsOf(route) {
  return [...route.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1])
}

/**
 * Read a view module's contract out of its source.
 *
 * Deliberately strict: an unparseable view is thrown rather than skipped,
 * because a silently skipped page is a page the registry claims does not
 * exist, and a MIS-parsed one is worse — it would call the loader with the
 * arguments in the wrong order and report a confidently wrong layout. Three
 * parameter shapes exist across the 165 pages and each is recognized by its
 * TYPE; anything else stops the build.
 */
export function describeView(file, source) {
  const route = /^\s*route: '([^']+)'/m.exec(source)?.[1]
  if (!route) throw new Error(`${file}: no literal \`route:\` field — a page without one cannot be customized`)

  const loader = /^export (?:async )?function (load[A-Za-z0-9_]*)\s*\(([\s\S]*?)\)\s*(?::|\{)/m.exec(source)
  if (!loader) throw new Error(`${file}: no exported loader`)
  const spec = /^export function ([a-zA-Z0-9_]*Spec)\s*\(([^)]*)\)/m.exec(source)
  if (!spec) throw new Error(`${file}: no exported spec builder`)
  // Three specs take no data at all — a page whose content is entirely static
  // chrome. Passing one an argument is a type error, so the call has to match
  // the signature rather than assume it.
  const specTakesData = spec[2].trim() !== ''

  // Classify each parameter, keeping DECLARATION ORDER. Loaders disagree about
  // which comes first — `loadBankAccount(accountId, sp)` against
  // `loadRecordsList(sp, typeKey)` — so the call has to be built from the
  // signature rather than from a convention none of them share.
  const segments = segmentsOf(route)
  let nextSegment = 0
  const args = splitParams(loader[2]).map((param) => {
    const type = param.slice(param.indexOf(':') + 1).trim()
    if (/^Record</.test(type)) return { kind: 'search-params' }
    // A route segment. Its NAME comes from the route pattern, not from the
    // parameter: `/entities/[role]` is loaded by a parameter called `slug`,
    // and the caller supplies what the url says, not what the author typed.
    if (/^string$/.test(type)) {
      const name = segments[nextSegment++]
      if (!name) throw new Error(`${file}: loader takes more segments than \`${route}\` has`)
      return { kind: 'segment', name }
    }
    // `params: { id: string }` — the Next.js shape, passed through whole.
    const object = /^\{\s*([A-Za-z0-9_]+)\s*:\s*string\s*\}$/.exec(type)
    if (object) {
      const name = segments[nextSegment++]
      if (!name) throw new Error(`${file}: loader takes more segments than \`${route}\` has`)
      return { kind: 'segment-object', name, key: object[1] }
    }
    throw new Error(`${file}: unrecognized loader parameter \`${param}\``)
  })

  const required = args.flatMap((arg) => (arg.kind === 'search-params' ? [] : [arg.name]))
  // Relative to web/lib/, without the extension — the specifier the generated
  // file will import.
  const specifier = relative(join(ROOT, 'web', 'lib'), file).replace(/\.ts$/, '').split(sep).join('/')
  return {
    route,
    loader: loader[1],
    spec: spec[1],
    specTakesData,
    args,
    segments: required,
    searchParams: args.some((arg) => arg.kind === 'search-params'),
    specifier: specifier.startsWith('.') ? specifier : `./${specifier}`,
  }
}

function callArgs(view) {
  return view.args
    .map((arg) => {
      if (arg.kind === 'search-params') return 'input.searchParams ?? {}'
      if (arg.kind === 'segment') return `segment(input, '${arg.name}')`
      return `{ ${arg.key}: segment(input, '${arg.name}') }`
    })
    .join(', ')
}

export function generate(views) {
  const entries = views.map((view) => {
    // No parameter when the loader takes nothing: an unused binding in a
    // generated file is lint debt nobody can fix at its source.
    const param = view.args.length === 0 ? '()' : '(input)'
    const specCall = view.specTakesData
      ? `(data) => m.${view.spec}(data as never)`
      : `() => m.${view.spec}()`
    return `  '${view.route}': {
    route: '${view.route}',
    segments: [${view.segments.map((name) => `'${name}'`).join(', ')}],
    searchParams: ${view.searchParams},
    module: async () => {
      const m = await import('${view.specifier}')
      return {
        load: ${param} => m.${view.loader}(${callArgs(view)}),
        spec: ${specCall},
      }
    },
  },`
  })

  return `// GENERATED by scripts/generate-page-registry.mjs — do not edit by hand.
// Regenerate after adding, moving or renaming a page; web/lib/page-registry.test.ts
// re-derives these facts from source and fails if this file has drifted.
import type { PageSpec, ViewData } from '@braedonsaunders/appkit-viewspec'

export interface PageInput {
  /** Values for the route's dynamic segments, keyed as the route names them. */
  params?: Record<string, string | undefined>
  /** The query string the page would have been visited with. */
  searchParams?: Record<string, string | undefined>
}

export interface PageModule {
  /**
   * \`null\` when the page renders nothing for this caller. Nine loaders
   * answer that way: they have already issued a redirect, or the reader has
   * no dashboard to show. It is an outcome, not a failure.
   */
  load: (input: PageInput) => Promise<ViewData | null>
  spec: (data: ViewData) => PageSpec
}

export interface PageRegistryEntry {
  /** The Next.js route PATTERN, matching the spec's own \`route\` field. */
  route: string
  /** Dynamic segments the loader needs, in route order. */
  segments: readonly string[]
  /** Whether the loader reads the query string. */
  searchParams: boolean
  /** Loaded on demand: naming a page must not import it. */
  module: () => Promise<PageModule>
}

/**
 * A required segment, or a refusal naming it.
 *
 * Thrown rather than defaulted to \`''\`: an empty id sends the loader looking
 * up a record that cannot exist, and the caller gets "not found" for a page
 * that is fine. Saying which segment is missing is the useful answer.
 */
export class MissingSegmentError extends Error {
  override name = 'MissingSegmentError'
  constructor(readonly segment: string) {
    super(\`this route needs a value for [\${segment}]\`)
  }
}

function segment(input: PageInput, name: string): string {
  const value = input.params?.[name]
  if (value === undefined || value === '') throw new MissingSegmentError(name)
  return value
}

export const PAGE_REGISTRY: Readonly<Record<string, PageRegistryEntry>> = {
${entries.join('\n')}
}

/** Every route that has a built-in layout, sorted. */
export const PAGE_ROUTES: readonly string[] = Object.keys(PAGE_REGISTRY).sort()
`
}
