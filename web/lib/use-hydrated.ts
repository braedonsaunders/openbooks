'use client'

import { useSyncExternalStore } from 'react'

const subscribe = () => () => undefined
const clientSnapshot = () => true
const serverSnapshot = () => false

/** Hydration-safe client availability without an effect-driven render cascade. */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot)
}
