'use client'

import * as React from 'react'

/**
 * Hydration-safe media-query match. Subscribes to the query (an external
 * browser store) instead of copying `matches` into state from an effect, so
 * there is no cascading render and no server/client mismatch: the server
 * snapshot pins the pre-hydration value.
 */
export function useMediaQuery(query: string, serverSnapshot = true): boolean {
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      const mq = window.matchMedia(query)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    [query],
  )
  const getSnapshot = React.useCallback(() => window.matchMedia(query).matches, [query])
  const getServerSnapshot = React.useCallback(() => serverSnapshot, [serverSnapshot])
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
