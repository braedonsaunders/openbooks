'use client'

import { useSyncExternalStore } from 'react'

const subscribe = (listener: () => void) => {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}
const readHidden = () => document.visibilityState === 'hidden'
const readServer = () => false

/** Background documents resume through their normal live read on visibility. */
export function useDocumentHidden(): boolean {
  return useSyncExternalStore(subscribe, readHidden, readServer)
}
