import type { ReactNode } from 'react'
import { WIDGET_FAMILY, type WidgetFamily } from './widget-index'
import type { WidgetRenderer } from './widget-props'
// The list and empty-state renderers sit on nearly every page, so they load
// with the loader and render synchronously.
import { CORE_WIDGETS } from './widgets-core'

/**
 * Load-on-use widget resolution.
 *
 * The registry stays closed — a spec can name only widgets listed in the
 * index — but a family module is evaluated only when a page renders one of
 * its widgets. Each family composes native pages with their own dependency
 * graphs, so loading every family for every spec would make each route pay
 * for editors, charts and document renderers it never shows.
 */

type WidgetFamilyRegistry = Readonly<Record<string, WidgetRenderer>>

// Literal import specifiers so the bundler emits one chunk per family.
const FAMILY_LOADERS: Record<WidgetFamily, () => Promise<WidgetFamilyRegistry>> = {
  core: async () => CORE_WIDGETS,
  agents: () => import('./widgets-agents').then((m) => m.AGENTS_WIDGETS),
  'assets-tax': () => import('./widgets-assets-tax').then((m) => m.ASSETS_TAX_WIDGETS),
  banking: () => import('./widgets-banking').then((m) => m.BANKING_WIDGETS),
  commerce: () => import('./widgets-commerce').then((m) => m.COMMERCE_WIDGETS),
  controls: () => import('./widgets-controls').then((m) => m.CONTROLS_WIDGETS),
  home: () => import('./widgets-home').then((m) => m.HOME_WIDGETS),
  'home-persona': () => import('./widgets-home-persona').then((m) => m.PERSONA_WIDGETS),
  hrm: () => import('./widgets-hrm').then((m) => m.HRM_WIDGETS),
  'hrm-continuous': () => import('./widgets-hrm-continuous').then((m) => m.HRM_CONTINUOUS_WIDGETS),
  'hrm-documents': () => import('./widgets-hrm-documents').then((m) => m.HRM_DOCUMENT_WIDGETS),
  'hrm-field-time': () => import('./widgets-hrm-field-time').then((m) => m.HRM_FIELD_TIME_WIDGETS),
  'hrm-processes': () => import('./widgets-hrm-processes').then((m) => m.HRM_PROCESS_WIDGETS),
  nonprofit: () => import('./widgets-nonprofit').then((m) => m.NONPROFIT_WIDGETS),
  operations: () => import('./widgets-operations').then((m) => m.OPERATIONS_WIDGETS),
  payroll: () => import('./widgets-payroll').then((m) => m.PAYROLL_WIDGETS),
  platform: () => import('./widgets-platform').then((m) => m.PLATFORM_WIDGETS),
  records: () => import('./widgets-records').then((m) => m.RECORDS_WIDGETS),
  reporting: () => import('./widgets-reporting').then((m) => m.REPORTING_WIDGETS),
  'resourcing-board': () => import('./widgets-resourcing-board').then((m) => m.RESOURCING_BOARD_WIDGETS),
  'resourcing-cockpit': () => import('./widgets-resourcing-cockpit').then((m) => m.RESOURCING_COCKPIT_WIDGETS),
  'resourcing-demand': () => import('./widgets-resourcing-demand').then((m) => m.RESOURCING_DEMAND_WIDGETS),
  'resourcing-requests': () => import('./widgets-resourcing-requests').then((m) => m.RESOURCING_REQUEST_WIDGETS),
  'resourcing-retainers': () => import('./widgets-resourcing-retainers').then((m) => m.RESOURCING_RETAINER_WIDGETS),
  setup: () => import('./widgets-setup').then((m) => m.SETUP_WIDGETS),
  warehouse: () => import('./widgets-warehouse').then((m) => m.WAREHOUSE_WIDGETS),
}

export class UnknownWidgetError extends Error {
  readonly name = 'UnknownWidgetError'
}

// Families already evaluated in this process: a table rendering one widget per
// cell resolves synchronously after the first cell instead of awaiting per cell.
const loadedFamilies = new Map<WidgetFamily, WidgetFamilyRegistry>()

function loadedFamily(family: WidgetFamily): WidgetFamilyRegistry | undefined {
  // Read at call time: the core module imports this loader, so it may still
  // be initializing when this module evaluates.
  return family === 'core' ? CORE_WIDGETS : loadedFamilies.get(family)
}

function familyOf(name: string): WidgetFamily | undefined {
  return Object.hasOwn(WIDGET_FAMILY, name) ? WIDGET_FAMILY[name] : undefined
}

/** Whether a spec may name this widget. Loads nothing. */
export function isRegisteredWidget(name: string): boolean {
  return familyOf(name) !== undefined
}

/** One family's renderers, loaded on first use. */
export async function loadWidgetFamily(family: WidgetFamily): Promise<WidgetFamilyRegistry> {
  const loaded = loadedFamily(family)
  if (loaded) return loaded
  const registry = await FAMILY_LOADERS[family]()
  loadedFamilies.set(family, registry)
  return registry
}

/** The named widget's renderer, or undefined when no family defines it. */
export async function findWidget(name: string): Promise<WidgetRenderer | undefined> {
  const family = familyOf(name)
  if (!family) return undefined
  const registry = await loadWidgetFamily(family)
  return Object.hasOwn(registry, name) ? registry[name] : undefined
}

/** The named widget's renderer; an unknown name refuses. */
export async function loadWidget(name: string): Promise<WidgetRenderer> {
  const renderer = await findWidget(name)
  if (!renderer) throw new UnknownWidgetError(`unknown widget: ${name}`)
  return renderer
}

/**
 * Render one widget. An unknown name refuses before anything loads; a known
 * widget renders synchronously once its family is loaded, otherwise the
 * returned node resolves when the family arrives.
 */
export function renderWidget(
  name: string,
  props: Record<string, unknown>,
  scope?: unknown,
  searchParams?: Record<string, string | string[] | undefined>,
): ReactNode {
  const family = familyOf(name)
  if (!family) throw new UnknownWidgetError(`unknown widget: ${name}`)
  const registry = loadedFamily(family)
  if (registry) {
    if (!Object.hasOwn(registry, name)) throw new UnknownWidgetError(`unknown widget: ${name}`)
    return registry[name]!(props, scope, searchParams)
  }
  return loadWidget(name).then((renderer) => renderer(props, scope, searchParams)) as ReactNode
}
