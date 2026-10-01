'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowDown, ArrowUp, Eye, EyeOff, FolderPlus, Pin, PinOff, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Card, CardContent, Input, Select, cn } from '@openbooks/ui'
import { promptDialog } from '../../../../lib/prompt'
import type { LocalNavigationPreference } from '@openbooks/engine/navigation'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { useUnsavedNavigationGuard } from '../../../../lib/use-unsaved-navigation-guard'
import { LOCAL_NAVIGATION } from '@openbooks/engine/navigation'
import type { NavigationEditorWorkspace } from '../../../../lib/nav/catalog'
import {
  MODULE_BY_KEY,
  NAV_GROUP_BY_KEY,
  defaultNavConfig,
  type NavGroupConfig,
  type NavAppOption,
  type NavGroupKey,
  type NavItemConfig,
  type OrgNavConfig,
} from '../../../../lib/nav/registry'

function move<T>(arr: T[], i: number, delta: number): T[] {
  const j = i + delta
  if (j < 0 || j >= arr.length) return arr
  const next = [...arr]
  const [x] = next.splice(i, 1)
  next.splice(j, 0, x!)
  return next
}

function itemLabel(item: NavItemConfig): string {
  if (item.kind === 'link') return item.label
  if (item.kind === 'app') return item.label ?? item.appKey
  return item.label ?? MODULE_BY_KEY.get(item.moduleKey)?.label ?? item.moduleKey
}

export function NavEditor({ initial, apps, initialRevision, localCatalog }: { initial: OrgNavConfig; apps: NavAppOption[]; initialRevision?: string | null; localCatalog?: NavigationEditorWorkspace[] }) {
  const t = useTranslations('admin.navigation')
  const tAll = useTranslations()
  const tCommon = useTranslations('common')
  const [config, setConfig] = useState<OrgNavConfig>(initial)
  const [savedConfig, setSavedConfig] = useState<OrgNavConfig>(initial)
  // Save fence token: the row version this editor loaded. Undefined (legacy
  // embeds and tests) sends no expectation; null expects no saved row.
  const revisionRef = useRef<string | null | undefined>(initialRevision)
  const [busy, setBusy] = useState(false)
  const [localWorkspace, setLocalWorkspace] = useState(LOCAL_NAVIGATION[0]!.id)
  const router = useRouter()
  const dirty = JSON.stringify(config) !== JSON.stringify(savedConfig)
  useUnsavedNavigationGuard(dirty, tCommon('feedback.unsavedChanges'), tCommon('confirm.discardChanges'))
  const appByKey = new Map(apps.map((app) => [app.key, app]))
  const placedApps = new Set(
    config.groups.flatMap((group) => group.items.flatMap((item) => (item.kind === 'app' ? [item.appKey] : []))),
  )
  const availableApps = apps.filter((app) => !placedApps.has(app.key))
  const workspaces = localCatalog ?? LOCAL_NAVIGATION.map((set) => ({
    id: set.id, label: tAll(`nav.localWorkspaces.${set.id}` as never),
    tabs: set.tabs.map((tab) => ({ href: tab.href, label: tAll(`${tab.ns}.${tab.key}` as never) })),
  }))
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === localWorkspace)
  const savedLocal = config.localNavigation?.[localWorkspace]?.items ?? []
  const configuredHrefs = new Set(savedLocal.map((item) => item.href))
  const localItems: LocalNavigationPreference['items'] = [
    ...savedLocal.filter((item) => selectedWorkspace?.tabs.some((tab) => tab.href === item.href)),
    ...(selectedWorkspace?.tabs.filter((tab) => !configuredHrefs.has(tab.href)).map((tab) => ({ href: tab.href })) ?? []),
  ]

  function changeLocal(items: typeof localItems) {
    setConfig((current) => ({ ...current, localNavigation: { ...current.localNavigation, [localWorkspace]: { items } } }))
  }

  function renameLocal(href: string, label: string) {
    const module = [...MODULE_BY_KEY.values()].find((entry) => entry.href === href)
    const canonicalItem = module && config.groups.flatMap((group) => group.items).some((item) => item.kind === 'module' && item.moduleKey === module.key)
    if (module && canonicalItem) {
      setConfig((current) => ({ ...current, groups: current.groups.map((group) => ({ ...group, items: group.items.map((item) => item.kind === 'module' && item.moduleKey === module.key ? { ...item, label: label || undefined } : item) })) }))
    } else {
      changeLocal(localItems.map((item) => item.href === href ? { ...item, label: label || undefined } : item))
    }
  }

  const setGroup = (gi: number, patch: Partial<NavGroupConfig>) =>
    setConfig((c) => ({
      ...c,
      groups: c.groups.map((g, i) => (i === gi ? { ...g, ...patch } : g)),
    }))

  function moveItemToGroup(fromGroup: number, itemIndex: number, targetId: string) {
    setConfig((current) => {
      const targetGroup = current.groups.findIndex((group) => group.id === targetId)
      if (targetGroup < 0 || targetGroup === fromGroup) return current
      const groups = current.groups.map((group) => ({
        ...group,
        items: [...group.items],
      }))
      const [item] = groups[fromGroup]!.items.splice(itemIndex, 1)
      if (!item) return current
      if (item.kind === 'module') item.placement = 'custom'
      groups[targetGroup]!.items.push(item)
      return { ...current, groups }
    })
  }

  async function addGroup() {
    const label = await promptDialog({ title: t('newGroupPrompt') })
    if (!label) return
    setConfig((current) => ({
      ...current,
      groups: [...current.groups, { id: `custom-${crypto.randomUUID()}`, label, items: [] }],
    }))
  }

  function toggleMobile(gi: number, ii: number) {
    const item = config.groups[gi]?.items[ii]
    if (!item) return
    const pinnedCount = config.groups.flatMap((group) => group.items).filter((candidate) => candidate.mobile).length
    if (!item.mobile && pinnedCount >= 4) {
      toast.error(t('mobileLimit'))
      return
    }
    setGroup(gi, {
      items: config.groups[gi]!.items.map((candidate, index) =>
        index === ii ? { ...candidate, mobile: !candidate.mobile } : candidate,
      ),
    })
  }

  async function save() {
    setBusy(true)
    try {
      const res = await fetch('/api/admin/navigation', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config,
          ...(revisionRef.current !== undefined ? { expectedUpdatedAt: revisionRef.current } : {}),
        }),
      })
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as { revision?: unknown } | null
        if (typeof data?.revision === 'string') revisionRef.current = data.revision
        setSavedConfig(config)
        toast.success(t('saved'))
        router.refresh()
      } else {
        // The status is checked first: a non-JSON 500 (proxy page, empty
        // body) must toast the named refusal or the translated fallback,
        // never a SyntaxError out of res.json() that hides it. Known server
        // refusals map to catalog copy; a 409 is always a stale write.
        const message = await readApiErrorMessage(res, t('saveFailed'))
        if (message === 'invalid nav config') toast.error(t('invalidConfig'))
        else if (message === 'navigation references an unknown app') toast.error(t('unknownApp'))
        else if (res.status === 409) toast.error(t('saveConflict'))
        else toast.error(message)
      }
    } catch {
      // A dead network must toast and release busy, never wedge the editor.
      toast.error(t('saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600 dark:text-slate-400">{t('workspaceHelp')}</p>
      {config.groups.map((g, gi) => (
        <Card key={g.id}>
          <CardContent className="space-y-2 p-4">
            <div className="flex items-center gap-2">
              <Input
                value={NAV_GROUP_BY_KEY.get(g.id as NavGroupKey)?.label === g.label ? tAll(`nav.groups.${g.id}` as never) : g.label}
                onChange={(e) => setGroup(gi, { label: e.target.value })}
                className="max-w-56 font-semibold"
                aria-label={t('groupLabelAria')}
                disabled={busy}
              />
              <span className="flex-1" />
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('moveGroupUp')}
                onClick={() => setConfig((c) => ({ ...c, groups: move(c.groups, gi, -1) }))}
                disabled={busy}
              >
                <ArrowUp size={14} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('moveGroupDown')}
                onClick={() => setConfig((c) => ({ ...c, groups: move(c.groups, gi, 1) }))}
                disabled={busy}
              >
                <ArrowDown size={14} />
              </Button>
              {!NAV_GROUP_BY_KEY.has(g.id as NavGroupKey) && g.items.length === 0 ? (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('deleteGroup')}
                  onClick={() =>
                    setConfig((current) => ({
                      ...current,
                      groups: current.groups.filter((_, index) => index !== gi),
                    }))
                  }
                  disabled={busy}
                >
                  <Trash2 size={14} />
                </Button>
              ) : null}
            </div>

            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {g.items.map((item, ii) => (
                <li
                  key={`${item.kind === 'module' ? item.moduleKey : item.kind === 'app' ? `app:${item.appKey}` : item.href}-${ii}`}
                  className={cn('flex flex-wrap items-center gap-2 py-1.5', item.hidden && 'opacity-45')}
                >
                  <Input
                    value={
                      item.kind === 'app'
                        ? item.label ?? appByKey.get(item.appKey)?.name ?? item.appKey
                        : item.kind === 'module' && (!item.label || item.label === MODULE_BY_KEY.get(item.moduleKey)?.label)
                          ? tAll(`nav.modules.${item.moduleKey}` as never) : itemLabel(item)
                    }
                    onChange={(e) =>
                      setGroup(gi, {
                        items: g.items.map((x, k) => (k === ii ? { ...x, label: e.target.value } : x)),
                      })
                    }
                    className="min-w-48 max-w-64 flex-1"
                    aria-label={t('itemLabelAria')}
                    disabled={busy}
                  />
                  {item.kind === 'module' ? (
                    <span className="font-mono text-xs text-slate-400">{item.moduleKey}</span>
                  ) : item.kind === 'app' ? (
                    <span className="font-mono text-xs text-slate-400">
                      app:{appByKey.get(item.appKey)?.name ?? item.appKey}
                    </span>
                  ) : (
                    <span className="truncate font-mono text-xs text-slate-400">{item.href}</span>
                  )}
                  <Select
                    value={g.id}
                    onChange={(event) => moveItemToGroup(gi, ii, event.currentTarget.value)}
                    aria-label={t('moveToGroup')}
                    className="w-44"
                    triggerClassName="h-9 text-xs"
                    disabled={busy}
                  >
                    {config.groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {NAV_GROUP_BY_KEY.get(group.id as NavGroupKey)?.label === group.label ? tAll(`nav.groups.${group.id}` as never) : group.label}
                      </option>
                    ))}
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={item.mobile ? t('unpinMobile') : t('pinMobile')}
                    title={item.mobile ? t('unpinMobile') : t('pinMobile')}
                    onClick={() => toggleMobile(gi, ii)}
                    disabled={busy}
                  >
                    {item.mobile ? <PinOff size={14} /> : <Pin size={14} />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={item.hidden ? t('showItem') : t('hideItem')}
                    onClick={() =>
                      setGroup(gi, {
                        items: g.items.map((x, k) => (k === ii ? { ...x, hidden: !x.hidden } : x)),
                      })
                    }
                    disabled={busy}
                  >
                    {item.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('moveItemUp')}
                    onClick={() => setGroup(gi, { items: move(g.items, ii, -1) })}
                    disabled={busy}
                  >
                    <ArrowUp size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('moveItemDown')}
                    onClick={() => setGroup(gi, { items: move(g.items, ii, 1) })}
                    disabled={busy}
                  >
                    <ArrowDown size={14} />
                  </Button>
                  {item.kind === 'link' || item.kind === 'app' ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={item.kind === 'app' ? t('removeApp') : t('deleteLink')}
                      title={item.kind === 'app' ? t('removeApp') : t('deleteLink')}
                      onClick={() =>
                        setGroup(gi, {
                          items: g.items.filter((_, index) => index !== ii),
                        })
                      }
                      disabled={busy}
                    >
                      <Trash2 size={14} />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>

            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={async () => {
                const href = await promptDialog({ title: t('linkUrlPrompt') })
                if (!href) return
                const label = await promptDialog({ title: t('linkLabelPrompt'), initialValue: href })
                if (!label) return
                setGroup(gi, {
                  items: [...g.items, { kind: 'link', href, label }],
                })
              }}
            >
              <Plus size={13} /> {t('addLink')}
            </Button>
            {availableApps.length > 0 ? (
              <Select
                value=""
                onChange={(event) => {
                  const appKey = event.currentTarget.value
                  if (!appKey) return
                  setGroup(gi, { items: [...g.items, { kind: 'app', appKey }] })
                }}
                aria-label={t('addApp')}
                className="w-52"
                triggerClassName="h-9 text-xs"
                disabled={busy}
              >
                <option value="">{t('addApp')}</option>
                {availableApps.map((app) => (
                  <option key={app.key} value={app.key}>
                    {app.name}
                  </option>
                ))}
              </Select>
            ) : null}
          </CardContent>
        </Card>
      ))}

      <Card>
        <CardContent className="space-y-3 p-4">
          <h2 className="font-semibold">{t('localTitle')}</h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">{t('localHelp')}</p>
          <Select value={localWorkspace} onChange={(event) => setLocalWorkspace(event.currentTarget.value)} aria-label={t('localWorkspace')} disabled={busy}>
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.label}</option>)}
          </Select>
          <ul className="space-y-2">
            {localItems.map((item, index) => {
              const destination = selectedWorkspace?.tabs.find((tab) => tab.href === item.href)
              const module = [...MODULE_BY_KEY.values()].find((entry) => entry.href === item.href)
              const native = module && config.groups.flatMap((group) => group.items).find((entry) => entry.kind === 'module' && entry.moduleKey === module.key)
              return <li key={item.href} className={cn('flex items-center gap-2', item.hidden && 'opacity-50')}>
                <Input value={(native?.label && native.label !== module?.label ? native.label : undefined) ?? item.label ?? destination?.label ?? item.href} onChange={(event) => renameLocal(item.href, event.target.value)} aria-label={t('localLabel')} disabled={busy} />
                <Button variant="ghost" size="icon" aria-label={item.hidden ? t('showItem') : t('hideItem')} onClick={() => changeLocal(localItems.map((entry, i) => i === index ? { ...entry, hidden: !entry.hidden } : entry))} disabled={busy}>{item.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</Button>
                <Button variant="ghost" size="icon" aria-label={t('moveItemUp')} onClick={() => changeLocal(move(localItems, index, -1))} disabled={busy || index === 0}><ArrowUp size={14} /></Button>
                <Button variant="ghost" size="icon" aria-label={t('moveItemDown')} onClick={() => changeLocal(move(localItems, index, 1))} disabled={busy || index === localItems.length - 1}><ArrowDown size={14} /></Button>
              </li>
            })}
          </ul>
          <Button variant="outline" disabled={busy} onClick={() => setConfig((current) => {
            const localNavigation = { ...current.localNavigation }
            const labels = (current.localNavigation?.[localWorkspace]?.items ?? []).filter((item) => item.label)
            if (labels.length) localNavigation[localWorkspace] = { items: selectedWorkspace?.tabs.map((tab) => {
              const saved = labels.find((item) => item.href === tab.href)
              return { href: tab.href, ...(saved?.label ? { label: saved.label } : {}) }
            }) ?? [] }
            else delete localNavigation[localWorkspace]
            return { ...current, localNavigation }
          })}><RotateCcw size={14} /> {t('resetLocal')}</Button>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={save} disabled={busy}>
          {busy ? tCommon('actions.saving') : t('save')}
        </Button>
        <Button variant="outline" onClick={() => setConfig(defaultNavConfig())} disabled={busy}>
          <RotateCcw size={14} /> {t('resetDefaults')}
        </Button>
        <Button variant="outline" onClick={addGroup} disabled={busy}>
          <FolderPlus size={14} /> {t('addGroup')}
        </Button>
      </div>
    </div>
  )
}
