import { FRAME_NAMES, WIDGET_NAMES } from './registry-names'
import { WIDGET_CONTRACTS } from './widget-contracts'

/**
 * What a spec is checked against, and why there are two answers.
 *
 * **Authoring** — every rule we have, including the prop contracts. A layout
 * being written is a layout that can still be corrected, so the strictest
 * check is the kindest one: a prop the widget does not read is a typo the
 * author can fix now rather than a missing control they puzzle over later.
 *
 * **Rendering** — names only. A stored layout was accepted under the rules of
 * the day it was saved, and tightening a rule must never take a working page
 * away from a reader who had nothing to do with it. An unreadable prop reaches
 * nothing at render anyway, so refusing the whole layout over one would trade
 * a cosmetic flaw for a page that does not draw.
 *
 * The split is the point. Keeping one shared set would force a choice between
 * never tightening the rules and breaking pages every time we did.
 */
export const AUTHORING_REGISTRIES = {
  widgets: WIDGET_NAMES,
  frames: FRAME_NAMES,
  contracts: WIDGET_CONTRACTS,
} as const

export const RENDER_REGISTRIES = {
  widgets: WIDGET_NAMES,
  frames: FRAME_NAMES,
} as const
