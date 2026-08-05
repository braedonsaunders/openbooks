'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Loader2, Plus, Trash2, User, Users } from 'lucide-react'
import { Badge, Button, Label, Select } from '@openbooks/ui'

type Tier = 'viewer' | 'editor' | 'manager'
const TIERS: Tier[] = ['viewer', 'editor', 'manager']

interface Grant {
  id: string
  principalType: 'user' | 'role'
  principalId: string
  principalName: string
  access: Tier
}
interface Principal {
  id: string
  name: string
}

/**
 * Sharing editor for a folder or file. Manager access is required to reach it
 * (the parent gates rendering). Grants a user or role a Viewer/Editor/Manager
 * tier; folder grants inherit to everything inside.
 */
export function SharePanel({
  resourceType,
  resourceId,
}: {
  resourceType: 'folder' | 'file'
  resourceId: string
}) {
  const t = useTranslations('documents.share')
  const tt = useTranslations('documents.toasts')
  const [grants, setGrants] = useState<Grant[] | null>(null)
  const [users, setUsers] = useState<Principal[]>([])
  const [roles, setRoles] = useState<Principal[]>([])
  const [selected, setSelected] = useState('')
  const [tier, setTier] = useState<Tier>('viewer')
  const [busy, setBusy] = useState(false)

  const base = `/api/file-cabinet/${resourceType === 'folder' ? 'folders' : 'files'}/${resourceId}/grants`

  async function load() {
    const [g, p] = await Promise.all([
      fetch(base).then((r) => (r.ok ? r.json() : { grants: [] })),
      fetch('/api/file-cabinet/principals').then((r) => (r.ok ? r.json() : { users: [], roles: [] })),
    ])
    setGrants((g.grants as Grant[]) ?? [])
    setUsers((p.users as Principal[]) ?? [])
    setRoles((p.roles as Principal[]) ?? [])
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceId])

  const granted = new Set((grants ?? []).map((g) => `${g.principalType}:${g.principalId}`))

  async function post(principalType: string, principalId: string, access: Tier) {
    setBusy(true)
    try {
      const res = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ principalType, principalId, access }),
      })
      if (res.ok) {
        toast.success(tt('shareUpdated'))
        await load()
      } else {
        toast.error(tt('shareFailed'))
      }
    } finally {
      setBusy(false)
    }
  }

  async function addGrant() {
    if (!selected) return
    const [pType, pId] = selected.split(':')
    await post(pType, pId, tier)
    setSelected('')
    setTier('viewer')
  }

  async function remove(g: Grant) {
    setBusy(true)
    try {
      const res = await fetch(`${base}/${g.id}`, { method: 'DELETE' })
      if (res.ok) {
        toast.success(tt('shareRemoved'))
        await load()
      } else {
        toast.error(tt('shareFailed'))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-3">
      <div>
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-slate-400 dark:text-slate-500" />
          <Label>{t('title')}</Label>
        </div>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          {t('subtitle', { kind: t(resourceType === 'folder' ? 'kindFolder' : 'kindFile') })}
        </p>
      </div>

      {/* Add grant — kept at the top so the principal dropdown always has room
          to open below it inside the drawer. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={selected}
          disabled={busy}
          searchable
          sheetTitle={t('addPrincipal')}
          placeholder={t('selectPrincipal')}
          className="h-9 min-w-[12rem] flex-1"
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">{t('selectPrincipal')}</option>
          <optgroup label={t('usersGroup')}>
            {users
              .filter((u) => !granted.has(`user:${u.id}`))
              .map((u) => (
                <option key={u.id} value={`user:${u.id}`}>
                  {u.name}
                </option>
              ))}
          </optgroup>
          <optgroup label={t('rolesGroup')}>
            {roles
              .filter((r) => !granted.has(`role:${r.id}`))
              .map((r) => (
                <option key={r.id} value={`role:${r.id}`}>
                  {r.name}
                </option>
              ))}
          </optgroup>
        </Select>
        <Select
          value={tier}
          disabled={busy || !selected}
          className="h-9 w-28"
          onChange={(e) => setTier(e.target.value as Tier)}
        >
          {TIERS.map((tr) => (
            <option key={tr} value={tr}>
              {t(`tiers.${tr}`)}
            </option>
          ))}
        </Select>
        <Button size="sm" disabled={busy || !selected} onClick={addGrant}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {t('add')}
        </Button>
      </div>
      {resourceType === 'folder' ? (
        <p className="text-xs text-slate-400 dark:text-slate-500">{t('inheritedHint')}</p>
      ) : null}

      {grants == null ? (
        <div className="flex items-center gap-2 py-3 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : grants.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{t('noGrants')}</p>
      ) : (
        <div className="divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {grants.map((g) => (
            <div key={g.id} className="flex items-center gap-3 px-3 py-2">
              {g.principalType === 'user' ? (
                <User className="h-4 w-4 shrink-0 text-slate-400" />
              ) : (
                <Users className="h-4 w-4 shrink-0 text-teal-500" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-200">
                {g.principalName}
              </span>
              {g.principalType === 'role' ? (
                <Badge variant="outline" className="shrink-0">
                  {t('rolesGroup')}
                </Badge>
              ) : null}
              <Select
                value={g.access}
                disabled={busy}
                className="h-8 w-28 shrink-0"
                onChange={(e) => void post(g.principalType, g.principalId, e.target.value as Tier)}
              >
                {TIERS.map((tr) => (
                  <option key={tr} value={tr}>
                    {t(`tiers.${tr}`)}
                  </option>
                ))}
              </Select>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                disabled={busy}
                aria-label={t('remove')}
                onClick={() => void remove(g)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
