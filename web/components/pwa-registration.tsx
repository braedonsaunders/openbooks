'use client'

import { useEffect } from 'react'

/** Register once without reloading open forms when a new worker activates. */
export function PwaRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !window.isSecureContext || !('serviceWorker' in navigator)) return

    void navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    }).catch((error: unknown) => {
      console.error('OpenBooks offline support could not be registered.', error)
    })
  }, [])

  return null
}
