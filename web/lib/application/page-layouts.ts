import 'server-only'

import { BLOCK_KINDS, CELL_KINDS, SPEC_VERSION, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { FRAME_NAMES, WIDGET_NAMES } from '../../components/viewspec/registry-names'
import { AUTHORING_REGISTRIES, RENDER_REGISTRIES } from '../../components/viewspec/registries'
import { can } from '../authz'
import type { ApplicationContext } from './context'
import { forbidden } from './errors'
import { boundPaths, describeFields } from '../page-fields'
import { MissingSegmentError, PAGE_REGISTRY, PAGE_ROUTES } from '../page-registry'
import { validateAgainstRegistries } from '../page-spec-validate'
import { clearPageSpec, listPageSpecs, loadPageSpec, savePageSpec } from '../page-specs'

/**
 * Page layouts as an application capability.
 *
 * An agent editing what a page looks like is the reason ViewSpec is a closed
 * language rather than a template. A layout it writes binds fields the page's
 * LOADER already resolved, under the reader's own permissions — so the worst a
 * bad one can do is arrange data that reader could already see, or fail
 * validation and be refused. There is no code path from a stored layout to
 * execution, which is why these tools can exist at all.
 *
 * The permission is `admin.customization.manage`, the same one that governs
 * form layouts and list views, because it is the same authority: deciding what
 * a page looks like for everyone in the org.
 */

const registries = AUTHORING_REGISTRIES

function requireCustomization(context: ApplicationContext): void {
  if (!can(context.authz, 'admin.customization.manage')) {
    throw forbidden('admin.customization.manage is required to read or change page layouts')
  }
}

/**
 * The vocabulary a layout may use, and the rules it must obey.
 *
 * Handed over rather than documented elsewhere, because an agent that cannot
 * enumerate the widgets will invent one, and an invented widget is a rejected
 * save at best. The names are read from the live registries, so this answer
 * cannot drift from what the renderer actually accepts.
 */
export async function describeLayoutVocabulary(context: ApplicationContext) {
  requireCustomization(context)
  return {
    specVersion: SPEC_VERSION,
    blockKinds: [...BLOCK_KINDS],
    cellKinds: [...CELL_KINDS],
    widgets: [...WIDGET_NAMES].sort(),
    frames: [...FRAME_NAMES].sort(),
    rules: [
      'A spec names blocks and binds fields the page loader already resolved. It never computes.',
      'No conditionals, arithmetic, string building, function values, component references, or capability objects.',
      'A field reference is { "$": "dot.path" } into the loader data, and nothing else.',
      '`when` OMITS a block; it cannot choose between two. A conditional pair is a component, not a spec construct.',
      'Widgets and frames must be named from the lists above; anything else is refused at save.',
      'A widget prop the widget does not read is refused at save: it would reach nothing and fail silently.',
      'The org is taken from the session. A spec that names an org id is refused.',
    ],
    limits: {
      note: 'A layout replaces the built-in spec for one route pattern. Fields it binds must exist in that page loader\'s output; a missing path renders as absent, not as an error.',
    },
  }
}

/** Every route this org has customized. */
export async function listLayouts(context: ApplicationContext) {
  requireCustomization(context)
  return {
    layouts: await listPageSpecs(context.authz.user.orgId),
    customizableRoutes: PAGE_ROUTES,
  }
}

/** The five closest routes by name, for a caller who mistyped one. */
function nearestRoutes(route: string): string[] {
  const needle = route.toLowerCase().replace(/\/+$/, '')
  const scored = PAGE_ROUTES.map((candidate) => {
    const other = candidate.toLowerCase()
    let shared = 0
    while (shared < needle.length && shared < other.length && needle[shared] === other[shared]) shared++
    return { candidate, shared }
  })
  return scored
    .filter((entry) => entry.shared > 1)
    .sort((a, b) => b.shared - a.shared || a.candidate.length - b.candidate.length)
    .slice(0, 5)
    .map((entry) => entry.candidate)
}

/**
 * Next.js signals redirect and not-found by THROWING, and both are ordinary
 * answers here rather than failures. A loader that calls `requirePermission`
 * for a permission the caller lacks redirects to `/`; letting that escape
 * would turn a description request into an actual HTTP redirect on whatever
 * transport asked.
 *
 * Matched on the digest string because Next's own predicates are not public
 * API. The two prefixes are stable contract — they appear in serialized RSC
 * payloads — and a prefix that stopped matching would make this report a
 * loader failure instead of a redirect, which is wrong but not unsafe.
 */
function controlFlow(error: unknown): { kind: 'redirect' | 'not-found'; detail: string } | null {
  const digest = (error as { digest?: unknown } | null)?.digest
  if (typeof digest !== 'string') return null
  if (digest.startsWith('NEXT_REDIRECT')) {
    return { kind: 'redirect', detail: digest.split(';')[2] ?? '' }
  }
  if (digest.startsWith('NEXT_HTTP_ERROR_FALLBACK') || digest === 'NEXT_NOT_FOUND') {
    return { kind: 'not-found', detail: '' }
  }
  return null
}

/**
 * What a route renders right now, and what its data offers a layout to bind.
 *
 * This is the affordance the write tools were missing. `describeLayoutVocabulary`
 * lists the widgets that EXIST; it cannot say what a particular page is made
 * of, so an author had to compose from scratch and guess at field paths — and
 * a guessed path fails silently, because a missing field resolves to
 * `undefined` by design rather than erroring.
 *
 * It works by running the page's own loader, with the caller's own session and
 * the caller's own permissions, and then building the built-in spec over the
 * result. That is precisely what visiting the page does, minus the rendering.
 * Nothing is escalated and nothing is bypassed: a loader that would redirect
 * this caller away still redirects, and is reported as such rather than
 * answered around.
 *
 * The result deliberately includes the built-in spec verbatim. An author's
 * best starting point is the layout the app ships — copy it, move a panel,
 * save — and handing it over is what makes the difference between editing and
 * reinventing.
 */
export async function describePageLayout(
  context: ApplicationContext,
  input: {
    route: string
    params?: Record<string, string | undefined>
    searchParams?: Record<string, string | undefined>
  },
) {
  requireCustomization(context)
  const entry = PAGE_REGISTRY[input.route]
  if (!entry) {
    return {
      known: false as const,
      route: input.route,
      reason: 'no page declares this route pattern',
      didYouMean: nearestRoutes(input.route),
    }
  }

  // READ under the render rules, not the authoring ones. A layout stored
  // before the prop contracts existed is still what this route renders, so
  // describing it away as "no override" would show the author a page they
  // are not looking at.
  const stored = await loadPageSpec(context.authz.user.orgId, entry.route, RENDER_REGISTRIES)
  const common = {
    known: true as const,
    route: entry.route,
    requiredSegments: entry.segments,
    readsSearchParams: entry.searchParams,
    /** The org's own layout for this route, or null if it renders the built-in one. */
    override: stored ? { id: stored.id, spec: stored.spec } : null,
  }

  const page = await entry.module()
  let data: object | null
  try {
    data = await page.load({ params: input.params, searchParams: input.searchParams })
  } catch (error) {
    if (error instanceof MissingSegmentError) {
      return { ...common, described: false as const, reason: 'missing-segment', segment: error.segment }
    }
    const flow = controlFlow(error)
    if (flow?.kind === 'redirect') {
      // The destination is the informative part and is reported as fact; the
      // cause is NOT. Two very different things redirect — `requirePermission`
      // sends an unauthorized reader to `/`, and a disabled feature sends
      // anyone to the features page — and naming the wrong one sends the
      // caller looking in the wrong place.
      return {
        ...common,
        described: false as const,
        reason: 'redirect',
        redirectTo: flow.detail || null,
        detail:
          `this page redirects you to ${flow.detail || 'another route'}. That is usually a ` +
          'permission you do not hold or a feature that is off for this org.',
      }
    }
    if (flow?.kind === 'not-found') {
      return {
        ...common,
        described: false as const,
        reason: 'not-found',
        detail:
          'this page answers "not found" for these inputs — the record may not exist, or the ' +
          'page may be gated off for this org.',
      }
    }
    throw error
  }

  if (data === null) {
    // The loader chose to render nothing — it has already redirected, or this
    // reader has no content on this page. There is no spec to describe,
    // because the page itself would not build one.
    return {
      ...common,
      described: false as const,
      reason: 'renders-nothing',
      detail: 'the page renders nothing for you with these inputs',
    }
  }

  const builtIn = page.spec(data)
  const catalog = describeFields(data)
  return {
    ...common,
    described: true as const,
    /** The layout the app ships for this route — the thing to edit. */
    builtIn,
    /** Dot paths the built-in layout binds; a subset of `fields`. */
    boundFields: boundPaths(builtIn),
    fields: catalog.fields,
    fieldsTruncated: catalog.truncated,
    note: 'Field paths are resolved against the loader output. Paths under an array\'s `item` resolve against a ROW — that is what a table\'s columns and a repeat\'s blocks see.',
  }
}

/**
 * Check a draft without storing it.
 *
 * The affordance that makes the write tools usable: an agent iterates against
 * real errors instead of guessing, and a rejected draft costs nothing. Errors
 * name the offending widget or path rather than saying "invalid".
 */
export async function validateLayout(
  context: ApplicationContext,
  input: { spec: unknown },
) {
  requireCustomization(context)
  const result = validateAgainstRegistries(input.spec, registries)
  if (result.ok) return { valid: true, route: result.spec.route ?? null, errors: [] as string[] }
  return { valid: false, route: null, errors: result.errors }
}

/** Store a layout for a route, replacing whatever was active. */
export async function setLayout(
  context: ApplicationContext,
  input: { route: string; spec: unknown; note?: string | null },
) {
  requireCustomization(context)
  const result = await savePageSpec({
    orgId: context.authz.user.orgId,
    actorId: context.authz.user.id,
    route: input.route,
    spec: input.spec as PageSpec,
    note: input.note ?? null,
    registries,
  })
  if (!result.ok) {
    // Returned, not thrown: a rejected layout is an ordinary outcome an agent
    // should read and correct, not an exception it should retry blindly.
    return { stored: false, errors: result.errors }
  }
  return { stored: true, id: result.id, errors: [] as string[] }
}

/** Drop a layout; the page returns to its built-in spec. */
export async function clearLayout(context: ApplicationContext, input: { route: string }) {
  requireCustomization(context)
  const { cleared } = await clearPageSpec({
    orgId: context.authz.user.orgId,
    actorId: context.authz.user.id,
    route: input.route,
  })
  return { cleared }
}
