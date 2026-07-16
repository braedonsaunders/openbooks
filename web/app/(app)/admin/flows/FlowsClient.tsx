'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Drawer, Input, Label, SearchSelect, cn } from '@openbooks/ui'
import { confirmDialog } from '../../../../lib/confirm'

/**
 * Client bits of the flows list: the New Flow drawer (name + subject kind
 * from the profiles API) and per-row enable/delete controls.
 */

type ProfileOption = { subjectKind: string; label: string }

export function NewFlowButton() {
  const t = useTranslations('admin.flows')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [subjectKind, setSubjectKind] = useState('')
  const [profiles, setProfiles] = useState<ProfileOption[] | null>(null)
  const [busy, setBusy] = useState(false)

  function openDrawer() {
    setOpen(true)
    if (profiles === null) {
      fetch('/api/admin/flows/profiles')
        .then((r) => (r.ok ? r.json() : { profiles: [] }))
        .then((d) =>
          setProfiles(
            (d.profiles ?? []).map((p: ProfileOption) => ({
              subjectKind: p.subjectKind,
              label: p.label,
            })),
          ),
        )
        .catch(() => setProfiles([]))
    }
  }

  async function create() {
    setBusy(true)
    try {
      const res = await fetch('/api/admin/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), subjectKind }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error ?? t('new.failed'))
        return
      }
      router.push(`/admin/flows/${data.id}`)
    } catch {
      toast.error(t('new.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button onClick={openDrawer}>
        <Plus size={15} /> {t('new.button')}
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        size="sm"
        title={t('new.title')}
        description={t('new.description')}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button disabled={busy || !name.trim() || !subjectKind} onClick={create}>
              {t('new.create')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t('new.name')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('new.namePlaceholder')}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('new.subject')}</Label>
            <SearchSelect
              value={subjectKind}
              options={(profiles ?? []).map((p) => ({ value: p.subjectKind, label: p.label }))}
              placeholder={t('new.subjectPlaceholder')}
              loading={profiles === null}
              onChange={setSubjectKind}
            />
          </div>
        </div>
      </Drawer>
    </>
  )
}

export function FlowRowActions({
  id,
  name,
  enabled,
}: {
  id: string
  name: string
  enabled: boolean
}) {
  const t = useTranslations('admin.flows')
  const router = useRouter()
  const [isEnabled, setIsEnabled] = useState(enabled)
  const [busy, setBusy] = useState(false)

  async function toggle() {
    const next = !isEnabled
    setIsEnabled(next)
    const res = await fetch(`/api/admin/flows/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    }).catch(() => null)
    if (!res?.ok) {
      setIsEnabled(!next)
      toast.error(t('actions.updateFailed'))
      return
    }
    router.refresh()
  }

  async function remove() {
    const ok = await confirmDialog({
      title: t('actions.deleteConfirmTitle'),
      message: t('actions.deleteConfirm', { name }),
      confirmLabel: t('actions.delete'),
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    const res = await fetch(`/api/admin/flows/${id}`, { method: 'DELETE' }).catch(() => null)
    setBusy(false)
    if (!res?.ok) {
      toast.error(t('actions.deleteFailed'))
      return
    }
    toast.success(t('actions.deleted'))
    router.refresh()
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={isEnabled}
        title={isEnabled ? t('actions.disable') : t('actions.enable')}
        onClick={toggle}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition',
          isEnabled ? 'bg-teal-500' : 'bg-slate-300 dark:bg-slate-600',
        )}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 transform rounded-full bg-white shadow transition',
            isEnabled ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </button>
      <button
        type="button"
        title={t('actions.delete')}
        disabled={busy}
        onClick={remove}
        className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400"
      >
        <Trash2 size={15} />
      </button>
    </div>
  )
}
