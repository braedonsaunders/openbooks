'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { useShortcuts } from './shortcut-provider'
import type { ShortcutCommand } from './shortcut-keys'

export interface FormShortcutActions {
  save?: () => void
  saveAndNew?: () => void
  saveAndClose?: () => void
  /** Save, post, and open a fresh form: the heads-down entry loop. */
  postAndNew?: () => void
  /** Save and post, staying on the posted record. */
  post?: () => void
}

/**
 * Save commands for an editing form, scoped to the drawer or dialog that
 * renders this marker: ⌘S / Ctrl+S saves, Ctrl+Alt+S (⌃⌥S) saves and opens
 * a new form, Ctrl+Alt+D (⌃⌥D) saves and closes, ⌘Enter / Ctrl+Enter
 * saves, posts and opens a new form, and ⌘⇧Enter / Ctrl+Shift+Enter saves
 * and posts. They work while typing in
 * the form's fields. `enabled` must be false while the form is not editing
 * or a save is already running; each action runs the form's own save, so
 * its validation, confirmation and refusal handling all apply.
 */
export function FormShortcuts({ enabled, actions }: { enabled: boolean; actions: FormShortcutActions }) {
  const t = useTranslations('shell.shortcuts.commands')
  const [marker, setMarker] = useState<HTMLSpanElement | null>(null)
  const container = () => marker?.closest('[role="dialog"]') ?? marker?.parentElement ?? null
  const commands: ShortcutCommand[] = []
  if (actions.save) {
    const run = actions.save
    commands.push({ id: 'formSave', label: () => t('save'), binding: { modifier: 'primary', code: 'KeyS' }, scope: 'form', allowInEditable: true, container, enabled: () => enabled, run })
  }
  if (actions.saveAndNew) {
    const run = actions.saveAndNew
    commands.push({ id: 'formSaveAndNew', label: () => t('saveAndNew'), binding: { modifier: 'chord', code: 'KeyS' }, scope: 'form', allowInEditable: true, container, enabled: () => enabled, run })
  }
  if (actions.saveAndClose) {
    const run = actions.saveAndClose
    commands.push({ id: 'formSaveAndClose', label: () => t('saveAndClose'), binding: { modifier: 'chord', code: 'KeyD' }, scope: 'form', allowInEditable: true, container, enabled: () => enabled, run })
  }
  if (actions.postAndNew) {
    const run = actions.postAndNew
    commands.push({ id: 'formPostAndNew', label: () => t('postAndNew'), binding: { modifier: 'primary', code: 'Enter' }, scope: 'form', allowInEditable: true, container, enabled: () => enabled, run })
  }
  if (actions.post) {
    const run = actions.post
    commands.push({ id: 'formPost', label: () => t('postRecord'), binding: { modifier: 'primary', code: 'Enter', shift: true }, scope: 'form', allowInEditable: true, container, enabled: () => enabled, run })
  }
  useShortcuts(commands)
  return <span ref={setMarker} hidden />
}
