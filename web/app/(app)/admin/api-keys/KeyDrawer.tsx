'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Copy, KeyRound, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, Textarea, UrlDrawer } from '@openbooks/ui'
import { PERMISSION_GROUPS, type CataloguePermission } from '@/lib/permissions'

export type KeyRow = {
  id: string
  name: string
  description: string | null
  key_prefix: string
  key_preview: string
  scopes: string[]
  rate_limit_per_min: number | null
  is_active: boolean
  expires_at: string | null
  last_used_at: string | null
  owner_name?: string
  owner_email?: string
}

export function NewKeyButton() {
  const t = useTranslations('admin.apiKeys')
  const router = useRouter()
  return (
    <Button onClick={() => router.push('/admin/api-keys?key=new')}>
      <KeyRound size={15} /> {t('drawer.newKey')}
    </Button>
  )
}

export function KeyDrawer({ keyRow }: { keyRow: KeyRow | null }) {
  const t = useTranslations('admin.apiKeys')
  const tCommon = useTranslations('common')
  const tAdmin = useTranslations('admin')
  const creating = !keyRow
  const router = useRouter()

  const [name, setName] = useState(keyRow?.name ?? '')
  const [description, setDescription] = useState(keyRow?.description ?? '')
  const [selected, setSelected] = useState<Set<string>>(new Set(keyRow?.scopes ?? []))
  // Blank = unlimited; new keys default to 120/min.
  const [rateLimit, setRateLimit] = useState(
    creating ? '120' : keyRow?.rate_limit_per_min == null ? '' : String(keyRow.rate_limit_per_min),
  )
  const [busy, setBusy] = useState(false)
  const [createdKey, setCreatedKey] = useState<string | null>(null)

  const selectedCount = useMemo(
    () => PERMISSION_GROUPS.reduce(
      (n, g) => n + g.permissions.filter((p) => selected.has(p.key)).length, 0,
    ),
    [selected],
  )

  function togglePermission(permKey: CataloguePermission) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(permKey)) next.delete(permKey)
      else next.add(permKey)
      return next
    })
  }

  function toggleGroup(groupKey: string) {
    const group = PERMISSION_GROUPS.find((g) => g.key === groupKey)
    if (!group) return
    setSelected((prev) => {
      const next = new Set(prev)
      const allOn = group.permissions.every((p) => next.has(p.key))
      for (const p of group.permissions) {
        if (allOn) next.delete(p.key)
        else next.add(p.key)
      }
      return next
    })
  }

  async function save() {
    if (!name.trim()) {
      toast.error(t('drawer.nameRequired'))
      return
    }
    setBusy(true)
    const res = await fetch('/api/admin/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        description: description.trim(),
        scopes: [...selected],
        rateLimitPerMin: rateLimit.trim() === '' ? null : Number(rateLimit),
      }),
    })
    const data = await res.json()
    setBusy(false)
    if (!res.ok) {
      toast.error(data.error ?? t('drawer.saveFailed'))
      return
    }
    setCreatedKey(data.plaintext)
    toast.success(t('drawer.created'))
    router.refresh()
  }

  async function saveChanges() {
    if (!keyRow) return
    setBusy(true)
    const res = await fetch('/api/admin/api-keys', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: keyRow.id,
        name: name.trim(),
        description: description.trim(),
        scopes: [...selected],
        rateLimitPerMin: rateLimit.trim() === '' ? null : Number(rateLimit),
      }),
    })
    const data = await res.json()
    setBusy(false)
    if (!res.ok) {
      toast.error(data.error ?? t('drawer.saveFailed'))
      return
    }
    toast.success(t('drawer.updated'))
    router.push('/admin/api-keys')
    router.refresh()
  }

  async function revoke() {
    if (!keyRow) return
    const ok = confirm(t('drawer.revokeConfirm'))
    if (!ok) return
    setBusy(true)
    const res = await fetch('/api/admin/api-keys', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: keyRow.id }),
    })
    setBusy(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error ?? t('drawer.revokeFailed'))
      return
    }
    toast.success(t('drawer.revoked'))
    router.push('/admin/api-keys')
    router.refresh()
  }

  function copyKey() {
    if (createdKey) {
      navigator.clipboard.writeText(createdKey)
      toast.success(t('drawer.copied'))
    }
  }

  return (
    <UrlDrawer
      open
      closeHref="/admin/api-keys"
      size="lg"
      title={creating ? t('drawer.newTitle') : keyRow!.name}
      description={t('drawer.description')}
      headerActions={
        <>
          {!creating && keyRow.is_active ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={revoke} className="text-red-600 hover:text-red-700 dark:text-red-400">
              {t('drawer.revoke')}
            </Button>
          ) : null}
          <Button variant="outline" disabled={busy} onClick={() => router.push('/admin/api-keys')}>
            {createdKey ? tCommon('actions.close') : tCommon('actions.cancel')}
          </Button>
          {!createdKey ? (
            <Button disabled={busy || !name.trim()} onClick={creating ? save : saveChanges}>
              {busy ? tCommon('actions.saving') : creating ? t('drawer.createKey') : t('drawer.saveChanges')}
            </Button>
          ) : null}
        </>
      }
    >
      {createdKey ? (
        <div className="space-y-4 p-1">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
            <div className="flex items-start gap-3">
              <ShieldAlert size={20} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                  {t('drawer.keyCreated')}
                </h3>
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                  {t('drawer.keyCreatedHint')}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <code className="flex-1 truncate rounded-md border border-amber-300 bg-white px-3 py-2 font-mono text-[13px] text-slate-900 dark:border-amber-700 dark:bg-slate-900 dark:text-slate-100">
                    {createdKey}
                  </code>
                  <Button size="sm" variant="outline" onClick={copyKey}>
                    <Copy size={14} /> {t('drawer.copy')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-5 p-1">
          {!creating && !keyRow.is_active ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
              {t('drawer.revokedNotice')}
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="key-name">{tCommon('labels.name')}</Label>
              <Input
                id="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!creating && !keyRow?.is_active}
                placeholder={t('drawer.namePlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="key-owner">{t('table.owner')}</Label>
              <Input
                id="key-owner"
                value={keyRow ? `${keyRow.owner_name ?? ''} · ${keyRow.owner_email ?? ''}` : ''}
                disabled
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="key-description">{tCommon('labels.description')}</Label>
            <Textarea
              id="key-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={!creating && !keyRow?.is_active}
              rows={2}
              placeholder={t('drawer.descriptionPlaceholder')}
            />
          </div>

          <div className="space-y-1.5 sm:max-w-xs">
            <Label htmlFor="key-rate">{t('drawer.rateLimitLabel')}</Label>
            <Input
              id="key-rate"
              type="number"
              min={1}
              inputMode="numeric"
              value={rateLimit}
              onChange={(e) => setRateLimit(e.target.value)}
              disabled={!creating && !keyRow?.is_active}
              placeholder={t('drawer.rateLimitPlaceholder')}
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">{t('drawer.rateLimitHint')}</p>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {t('drawer.scopesHeading')}
              </h3>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {selected.size === 0
                  ? t('drawer.fullScope')
                  : t('drawer.scopesCount', { count: selectedCount })}
              </span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('drawer.scopesHint')}
            </p>
            {PERMISSION_GROUPS.map((group) => {
              const allOn = group.permissions.every((p) => selected.has(p.key))
              const someOn = group.permissions.some((p) => selected.has(p.key))
              return (
                <fieldset
                  key={group.key}
                  className="rounded-lg border border-slate-200 dark:border-slate-800"
                >
                  <legend className="sr-only">{tAdmin(group.labelKey)}</legend>
                  <label className="flex cursor-pointer items-center gap-2.5 border-b border-slate-100 bg-slate-50/60 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/60">
                    <input
                      type="checkbox"
                      checked={allOn}
                      ref={(el) => { if (el) el.indeterminate = !allOn && someOn }}
                      disabled={creating ? false : !keyRow?.is_active}
                      onChange={() => toggleGroup(group.key)}
                      className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600 dark:bg-slate-800"
                    />
                    <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                      {tAdmin(group.labelKey)}
                    </span>
                  </label>
                  <div className="grid gap-x-4 px-3 py-2 sm:grid-cols-2">
                    {group.permissions.map((perm) => (
                      <label
                        key={perm.key}
                        className="flex cursor-pointer items-start gap-2.5 py-1.5"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(perm.key)}
                          disabled={creating ? false : !keyRow?.is_active}
                          onChange={() => togglePermission(perm.key)}
                          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600 dark:bg-slate-800"
                        />
                        <span className="min-w-0">
                          <span className="block text-sm text-slate-800 dark:text-slate-200">
                            {tAdmin(perm.labelKey)}
                          </span>
                          <span className="block font-mono text-[11px] text-slate-400 dark:text-slate-500">
                            {perm.key}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )
            })}
          </div>
        </div>
      )}
    </UrlDrawer>
  )
}
