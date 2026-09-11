import 'server-only'

import { BLOCK_KINDS, CELL_KINDS, SPEC_VERSION, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { FRAME_NAMES, WIDGET_NAMES } from '../../components/viewspec/registry-names'
import { can } from '../authz'
import type { ApplicationContext } from './context'
import { forbidden } from './errors'
import { validateAgainstRegistries } from '../page-spec-validate'
import { clearPageSpec, listPageSpecs, savePageSpec } from '../page-specs'

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

const registries = { widgets: WIDGET_NAMES, frames: FRAME_NAMES }

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
  return { layouts: await listPageSpecs(context.authz.user.orgId) }
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
