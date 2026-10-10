'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

/**
 * One record, one Save.
 *
 * A record drawer section that persists through its own endpoint (a CRM
 * relationship profile, a vendor compliance class) still edits as part of
 * the record: it is read-only until the drawer enters edit mode, it never
 * renders its own Save, and the drawer's single Save persists it alongside
 * the record. Sections join through `useRecordSaveParticipant`; the drawer
 * owns the registry from `useRecordSaveRegistry` and provides it with
 * `RecordSaveContext`.
 */
export interface RecordSaveParticipant {
  /** Whether the section holds edits the record has not saved. */
  dirty: boolean
  /** Persist the section's edits. Resolves false when refused; the section
   *  shows the reason where its fields are. */
  save: () => Promise<boolean>
  /** Discard the section's edits back to what was loaded. */
  reset: () => void
}

interface RegistryContext {
  /** Whether the record drawer is in edit mode. */
  editing: boolean
  register: (key: string, participant: RecordSaveParticipant) => () => void
  setDirty: (key: string, dirty: boolean) => void
}

export const RecordSaveContext = createContext<RegistryContext | null>(null)

export function useRecordSaveRegistry(editing: boolean) {
  const participants = useRef(new Map<string, RecordSaveParticipant>())
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(() => new Set())

  const setDirty = useCallback((key: string, dirty: boolean) => {
    setDirtyKeys((previous) => {
      if (previous.has(key) === dirty) return previous
      const next = new Set(previous)
      if (dirty) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  const register = useCallback((key: string, participant: RecordSaveParticipant) => {
    participants.current.set(key, participant)
    return () => {
      if (participants.current.get(key) === participant) participants.current.delete(key)
      setDirty(key, false)
    }
  }, [setDirty])

  /** Save every dirty section in registration order; stop at the first refusal. */
  const saveAll = useCallback(async (): Promise<{ ok: true } | { ok: false; key: string }> => {
    for (const [key, participant] of participants.current) {
      if (!participant.dirty) continue
      if (!(await participant.save())) return { ok: false, key }
    }
    return { ok: true }
  }, [])

  const resetAll = useCallback(() => {
    for (const participant of participants.current.values()) participant.reset()
  }, [])

  const context = useMemo<RegistryContext>(() => ({ editing, register, setDirty }), [editing, register, setDirty])

  return { context, dirty: dirtyKeys.size > 0, saveAll, resetAll }
}

/**
 * Join the enclosing record's Save. Returns whether a record registry is
 * present; a section rendered outside a record drawer has no Save at all
 * and must stay read-only.
 */
export function useRecordSaveParticipant(key: string, participant: RecordSaveParticipant): boolean {
  const registry = useContext(RecordSaveContext)
  const latest = useRef(participant)
  useEffect(() => {
    latest.current = participant
  })
  useEffect(() => {
    if (!registry) return
    return registry.register(key, {
      get dirty() {
        return latest.current.dirty
      },
      save: () => latest.current.save(),
      reset: () => latest.current.reset(),
    })
  }, [registry, key])
  useEffect(() => {
    registry?.setDirty(key, participant.dirty)
  }, [registry, key, participant.dirty])
  return registry !== null
}

/**
 * The enclosing record drawer's edit mode, or null outside a record drawer.
 * Sections rendered into a record (including server-rendered record tabs)
 * read it to stay read-only until the record is being edited.
 */
export function useRecordEditing(): boolean | null {
  return useContext(RecordSaveContext)?.editing ?? null
}
