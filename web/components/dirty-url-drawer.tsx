'use client'

import { createContext, useCallback, useContext, useEffect, useId, useState, type ComponentProps, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { UrlDrawer } from '@openbooks/ui'
import { confirmDialog } from '../lib/confirm'

type DirtyDrawerContextValue = {
  register: (id: string, dirty: boolean, busy: boolean) => void
  close: (href?: string) => Promise<void>
}

const DirtyDrawerContext = createContext<DirtyDrawerContextValue | null>(null)

type Props = Omit<ComponentProps<typeof UrlDrawer>, 'beforeClose' | 'children'> & { children: ReactNode }

/** URL drawer that collects dirty state from form children and guards every shell close path. */
export function DirtyUrlDrawer({ children, ...props }: Props) {
  const router = useRouter()
  const common = useTranslations('common')
  const [formStates, setFormStates] = useState<ReadonlyMap<string, { dirty: boolean; busy: boolean }>>(() => new Map())

  const register = useCallback((id: string, dirty: boolean, busy: boolean) => {
    setFormStates((current) => {
      const before = current.get(id)
      if (!dirty && !busy) {
        if (!before) return current
        const states = new Map(current)
        states.delete(id)
        return states
      }
      if (before?.dirty === dirty && before.busy === busy) return current
      const states = new Map(current)
      states.set(id, { dirty, busy })
      return states
    })
  }, [])

  const confirmClose = useCallback(async () => {
    const states = [...formStates.values()]
    if (states.some((state) => state.busy)) return false
    if (!states.some((state) => state.dirty)) return true
    return confirmDialog({
      message: common('feedback.unsavedChanges'),
      confirmLabel: common('confirm.discardChanges'),
      tone: 'danger',
    })
  }, [common, formStates])

  const close = useCallback(async (href?: string) => {
    if (await confirmClose()) router.push((href ?? props.closeHref) as never)
  }, [confirmClose, props.closeHref, router])

  return (
    <DirtyDrawerContext.Provider value={{ register, close }}>
      <UrlDrawer {...props} beforeClose={confirmClose}>{children}</UrlDrawer>
    </DirtyDrawerContext.Provider>
  )
}

/** Registers form-local dirtiness and returns the shared, confirmation-aware close action. */
export function useDirtyUrlDrawer(dirty: boolean, busy = false): (href?: string) => Promise<void> {
  const context = useContext(DirtyDrawerContext)
  const id = useId()
  useEffect(() => {
    context?.register(id, dirty, busy)
    return () => context?.register(id, false, false)
  }, [busy, context, dirty, id])
  return context?.close ?? (async () => {})
}
