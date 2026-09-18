'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { Loader2, Plus, Trash2, User, Users } from 'lucide-react'
import { Badge, Button, Label, Select } from '@openbooks/ui'
import { useAppAction } from '@/lib/use-app-action'

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
  const tc = useTranslations('common')
  const [grants, setGrants] = useState<Grant[] | null>(null)
  const [users, setUsers] = useState<Principal[]>([])
  const [roles, setRoles] = useState<Principal[]>([])
  const [selected, setSelected] = useState('')
  const [tier, setTier] = useState<Tier>('viewer')
  // Grant add/remove run on the shared action path: a refusal pins beside
  // the panel until the next action AND toasts (no dismiss), and busy always
  // releases. The grants load below stays hand-rolled: it already pins with
  // a retry, which is the load equivalent of this contract.
  const { busy, refusal, execute, clearRefusal } = useAppAction()
  const [loadError, setLoadError] = useState(false)

  const base = `/api/file-cabinet/${resourceType === 'folder' ? 'folders' : 'files'}/${resourceId}/grants`

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body. The loading reset lives
  // with the triggers (below, and the mutation reloads) instead of a mount
  // effect.
  function load() {
    return Promise.all([fetch(base), fetch('/api/file-cabinet/principals')])
      .then(([g, p]) => {
        if (!g.ok || !p.ok) throw new Error('SHARING_LOAD_FAILED')
        return Promise.all([g.json(), p.json()]).then(([grantsPayload, principalsPayload]) => {
          if (
            !grantsPayload ||
            !Array.isArray(grantsPayload.grants) ||
            !principalsPayload ||
            !Array.isArray(principalsPayload.users) ||
            !Array.isArray(principalsPayload.roles)
          ) {
            throw new Error('SHARING_LOAD_FAILED')
          }
          setGrants(grantsPayload.grants as Grant[])
          setUsers(principalsPayload.users as Principal[])
          setRoles(principalsPayload.roles as Principal[])
        })
      })
      .catch(() => {
        // An unavailable grants endpoint must never look like an empty grants list.
        setGrants(null)
        setLoadError(true)
      })
  }

  // Reset the lists while reloading for another resource, during render (same
  // committed values, no extra render). Keyed on resourceId alone, mirroring
  // the fetch below.
  const [prevResourceId, setPrevResourceId] = useState(resourceId)
  if (prevResourceId !== resourceId) {
    setPrevResourceId(resourceId)
    setLoadError(false)
    setGrants(null)
    setUsers([])
    setRoles([])
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resourceId])

  function resetGrantsForReload() {
    setLoadError(false)
    setGrants(null)
    setUsers([])
    setRoles([])
  }

  const granted = new Set((grants ?? []).map((g) => `${g.principalType}:${g.principalId}`))

  async function post(principalType: string, principalId: string, access: Tier) {
    return execute(
      () =>
        fetchAction(base, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ principalType, principalId, access }),
        }),
      {
        fallbackMessage: tt('shareFailed'),
        successMessage: tt('shareUpdated'),
        onOk: () => {
          resetGrantsForReload()
          void load()
        },
      },
    )
  }

  async function addGrant() {
    if (!selected) return
    const [pType, pId] = selected.split(':')
    const ok = await post(pType!, pId!, tier)
    if (ok) {
      setSelected('')
      setTier('viewer')
    }
  }

  async function remove(g: Grant) {
    await execute(() => fetchAction(`${base}/${g.id}`, { method: 'DELETE' }), {
      fallbackMessage: tt('shareFailed'),
      successMessage: tt('shareRemoved'),
      onOk: () => {
        resetGrantsForReload()
        void load()
      },
    })
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

      {/* A refused grant pins here until the next action — the toast catches
          the eye, this survives it. No dismiss: erasing the only record of
          why the grant failed must not be one stray click. */}
      <ActionAlert error={refusal} fallbackMessage={tt('shareFailed')} />

      {/* Add grant — kept at the top so the principal dropdown always has room
          to open below it inside the drawer. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={selected}
          disabled={busy || loadError || grants == null}
          searchable
          sheetTitle={t('addPrincipal')}
          placeholder={t('selectPrincipal')}
          className="h-9 min-w-[12rem] flex-1"
          onChange={(e) => {
            clearRefusal()
            setSelected(e.target.value)
          }}
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
          disabled={busy || loadError || grants == null || !selected}
          className="h-9 w-28"
          onChange={(e) => {
            clearRefusal()
            setTier(e.target.value as Tier)
          }}
        >
          {TIERS.map((tr) => (
            <option key={tr} value={tr}>
              {t(`tiers.${tr}`)}
            </option>
          ))}
        </Select>
        <Button size="sm" disabled={busy || loadError || grants == null || !selected} onClick={addGrant}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {t('add')}
        </Button>
      </div>
      {resourceType === 'folder' ? (
        <p className="text-xs text-slate-400 dark:text-slate-500">{t('inheritedHint')}</p>
      ) : null}

      {loadError ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          <span>{tc('feedback.loadFailed')}</span>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>
            {tc('actions.retry')}
          </Button>
        </div>
      ) : grants == null ? (
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
                disabled={busy || loadError}
                className="h-8 w-28 shrink-0"
                onChange={(e) => {
                  clearRefusal()
                  void post(g.principalType, g.principalId, e.target.value as Tier)
                }}
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
                disabled={busy || loadError}
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
