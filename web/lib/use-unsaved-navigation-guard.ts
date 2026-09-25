'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { confirmDialog } from './confirm'

/** Guard app links, browser history, and document unload while a page has a local draft. */
export function useUnsavedNavigationGuard(dirty: boolean, message: string, confirmLabel: string): void {
  const router = useRouter()

  useEffect(() => {
    if (!dirty) return
    const currentHref = window.location.href
    const currentState = window.history.state
    let waitingForConfirmation = false
    let allowNextPop = false

    const askToLeave = () => confirmDialog({ message, confirmLabel, tone: 'danger' })

    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest<HTMLAnchorElement>('a[href]')
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return
      const destination = new URL(anchor.href, window.location.href)
      if (destination.origin !== window.location.origin || destination.href === window.location.href) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      void askToLeave().then((allowed) => {
        if (allowed) router.push(`${destination.pathname}${destination.search}${destination.hash}` as never)
      })
    }

    const onPopState = () => {
      if (allowNextPop) {
        allowNextPop = false
        return
      }
      if (waitingForConfirmation) return
      waitingForConfirmation = true
      window.history.pushState(currentState, '', currentHref)
      void askToLeave().then((allowed) => {
        waitingForConfirmation = false
        if (allowed) {
          allowNextPop = true
          window.history.back()
        }
      })
    }

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }

    // Keep the restoration point current when other same-page controls update
    // history while the draft remains open.
    const onPopStateCapture = (event: PopStateEvent) => {
      if (allowNextPop) return
      onPopState()
      event.stopImmediatePropagation()
    }

    document.addEventListener('click', onClick, true)
    window.addEventListener('popstate', onPopStateCapture, true)
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('popstate', onPopStateCapture, true)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [confirmLabel, dirty, message, router])
}
