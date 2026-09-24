import { mergeHref } from '../list-params'

/**
 * ONE shared href helper for the HRM workspace drawers (F3-55/56/57).
 *
 * A drawer open/close href preserves the list's tab, filter, and
 * setup-section params and only swaps the selection keys — so closing a
 * drawer returns the operator to the same tab, filter, and selection
 * context instead of dropping them onto the default view.
 *
 * `preserved` carries exactly the tab/filter/setup params (never selection
 * keys); `patch` sets selection keys, and omitting a key clears it. All
 * three workspaces delegate here instead of hand-rolling query strings.
 */

/**
 * Tab, filter, and setup-section params. Never selection keys. The shape
 * matches the shared mergeHref's Search so loader currentParams pass
 * straight through.
 */
export type PreservedParams = Record<string, string | string[] | undefined>

export function recruitingHref(
  preserved: PreservedParams,
  patch: {
    status?: string | null
    requisition?: string | null
    candidate?: string | null
    offer?: string | null
  } = {},
): string {
  return mergeHref('/hrm/recruiting', preserved, patch)
}

export function performanceHref(
  preserved: PreservedParams,
  patch: { status?: string | null; cycle?: string | null; review?: string | null; exit?: string | null } = {},
): string {
  return mergeHref('/hrm/performance', preserved, patch)
}

export function complianceHref(preserved: PreservedParams, patch: { generate?: string | null } = {}): string {
  return mergeHref('/hrm/compliance', preserved, patch)
}
