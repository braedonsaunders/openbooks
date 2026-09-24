'use client'

import { useCallback, useState } from 'react'
import { confirmDialog } from './confirm'

/**
 * Shared close guard for forms with unsaved edits. Use `close` for a Drawer
 * `onClose` callback and `beforeClose` for URL-controlled drawers whose own
 * close flow commits navigation after the guard approves.
 */
export function useDirtyClose({
  dirty,
  busy = false,
  onClose,
  message,
  confirmLabel,
}: {
  dirty: boolean
  /** In-flight writes cannot be dismissed, even with a discard confirmation. */
  busy?: boolean
  onClose: () => void
  message: string
  confirmLabel: string
}) {
  const [dirtyChildren, setDirtyChildren] = useState<ReadonlySet<string>>(() => new Set())
  const registerDirty = useCallback((sourceId: string, childDirty: boolean) => {
    setDirtyChildren((current) => {
      if (current.has(sourceId) === childDirty) return current
      const next = new Set(current)
      if (childDirty) next.add(sourceId)
      else next.delete(sourceId)
      return next
    })
  }, [])

  const beforeClose = useCallback(async () => {
    if (busy) return false
    if (!dirty && dirtyChildren.size === 0) return true
    return confirmDialog({ message, confirmLabel, tone: 'danger' })
  }, [busy, confirmLabel, dirty, dirtyChildren, message])

  const close = useCallback(async () => {
    if (await beforeClose()) onClose()
  }, [beforeClose, onClose])

  return { close, beforeClose, registerDirty }
}
