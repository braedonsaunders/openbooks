'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
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

/** Collect child-form state without creating another drawer shell. */
export function useDirtyDrawerState() {
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

  return {
    register,
    dirty: [...formStates.values()].some((state) => state.dirty),
    busy: [...formStates.values()].some((state) => state.busy),
  }
}

/** Existing shell owners share the same child-form registration and close action. */
export function DirtyDrawerFormScope({ children, register, close }: DirtyDrawerContextValue & { children: ReactNode }) {
  return <DirtyDrawerContext.Provider value={{ register, close }}>{children}</DirtyDrawerContext.Provider>
}

/** URL drawer that collects dirty state from form children and guards every shell close path. */
export function DirtyUrlDrawer({ children, ...props }: Props) {
  const router = useRouter()
  const common = useTranslations('common')
  const forms = useDirtyDrawerState()

  const confirmClose = useCallback(async () => {
    if (forms.busy) return false
    if (!forms.dirty) return true
    return confirmDialog({
      message: common('feedback.unsavedChanges'),
      confirmLabel: common('confirm.discardChanges'),
      tone: 'danger',
    })
  }, [common, forms.busy, forms.dirty])

  const close = useCallback(
    async (href?: string) => {
      if (await confirmClose()) router.push((href ?? props.closeHref) as never)
    },
    [confirmClose, props.closeHref, router],
  )

  return (
    <DirtyDrawerFormScope register={forms.register} close={close}>
      <UrlDrawer {...props} beforeClose={confirmClose}>
        {children}
      </UrlDrawer>
    </DirtyDrawerFormScope>
  )
}

/** Registers form-local dirtiness and returns the shared, confirmation-aware close action. */
export function useDirtyUrlDrawer(dirty: boolean, busy = false): (href?: string) => Promise<void> {
  const context = useContext(DirtyDrawerContext)
  const id = useId()
  const register = context?.register
  useEffect(() => {
    register?.(id, dirty, busy)
    return () => register?.(id, false, false)
  }, [busy, register, dirty, id])
  return context?.close ?? (async () => {})
}
