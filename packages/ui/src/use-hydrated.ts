'use client'

import * as React from 'react'

const subscribe = () => () => undefined
const clientSnapshot = () => true
const serverSnapshot = () => false

/** Hydration-safe client availability without an effect-driven render cascade. */
export function useHydrated(): boolean {
  return React.useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot)
}
