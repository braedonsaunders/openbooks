export type SearchInputEditState = {
  value: string
  /**
   * The user has a local edit that must win over URL updates until every
   * in-flight navigation settles. This prevents an older server response from
   * replacing text entered after that request began.
   */
  dirty: boolean
}

export function createSearchInputEditState(urlValue: string): SearchInputEditState {
  return { value: urlValue, dirty: false }
}

export function applySearchInputEdit(
  value: string,
  urlValue: string,
  navigationPending: boolean,
): SearchInputEditState {
  return {
    value,
    // A pending navigation may still carry an older value even when the new
    // edit happens to equal the URL currently visible to this render.
    dirty: value !== urlValue || navigationPending,
  }
}

export function reconcileSearchInputUrl(
  state: SearchInputEditState,
  urlValue: string,
  navigationPending: boolean,
): SearchInputEditState {
  if (state.dirty) {
    // While navigation is pending, URL values can arrive out of order. Keep
    // the user's latest edit authoritative. It becomes clean only after all
    // transitions settle with that exact value in the URL.
    if (!navigationPending && state.value === urlValue) {
      return { value: state.value, dirty: false }
    }
    return state
  }

  // With no local edit, browser history and links remain authoritative.
  if (state.value === urlValue) return state
  return { value: urlValue, dirty: false }
}
