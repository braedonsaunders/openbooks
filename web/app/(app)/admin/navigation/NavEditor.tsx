'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowDown, ArrowUp, Eye, EyeOff, FolderPlus, Pin, PinOff, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Card, CardContent, Input, Select, cn } from '@openbooks/ui'
import {
  MODULE_BY_KEY,
  NAV_GROUP_BY_KEY,
  defaultNavConfig,
  type NavGroupConfig,
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
  return item.label ?? MODULE_BY_KEY.get(item.moduleKey)?.label ?? item.moduleKey
}

export function NavEditor({ initial }: { initial: OrgNavConfig }) {
  const t = useTranslations('admin.navigation')
  const tCommon = useTranslations('common')
  const [config, setConfig] = useState<OrgNavConfig>(initial)
  const [busy, setBusy] = useState(false)
  const router = useRouter()

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
      groups[targetGroup]!.items.push(item)
      return { ...current, groups }
    })
  }

  function addGroup() {
    const label = prompt(t('newGroupPrompt'))?.trim()
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
    const res = await fetch('/api/admin/navigation', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    })
    if (res.ok) {
      toast.success(t('saved'))
      router.refresh()
    } else {
      toast.error((await res.json()).error ?? t('saveFailed'))
    }
    setBusy(false)
  }

  return (
    <div className="space-y-4">
      {config.groups.map((g, gi) => (
        <Card key={g.id}>
          <CardContent className="space-y-2 p-4">
            <div className="flex items-center gap-2">
              <Input
                value={g.label}
                onChange={(e) => setGroup(gi, { label: e.target.value })}
                className="max-w-56 font-semibold"
                aria-label={t('groupLabelAria')}
              />
              <span className="flex-1" />
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('moveGroupUp')}
                onClick={() => setConfig((c) => ({ ...c, groups: move(c.groups, gi, -1) }))}
              >
                <ArrowUp size={14} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('moveGroupDown')}
                onClick={() => setConfig((c) => ({ ...c, groups: move(c.groups, gi, 1) }))}
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
                >
                  <Trash2 size={14} />
                </Button>
              ) : null}
            </div>

            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {g.items.map((item, ii) => (
                <li
                  key={`${item.kind === 'module' ? item.moduleKey : item.href}-${ii}`}
                  className={cn('flex flex-wrap items-center gap-2 py-1.5', item.hidden && 'opacity-45')}
                >
                  <Input
                    value={itemLabel(item)}
                    onChange={(e) =>
                      setGroup(gi, {
                        items: g.items.map((x, k) => (k === ii ? { ...x, label: e.target.value } : x)),
                      })
                    }
                    className="min-w-48 max-w-64 flex-1"
                    aria-label={t('itemLabelAria')}
                  />
                  {item.kind === 'module' ? (
                    <span className="font-mono text-xs text-slate-400">{item.moduleKey}</span>
                  ) : (
                    <span className="truncate font-mono text-xs text-slate-400">{item.href}</span>
                  )}
                  <Select
                    value={g.id}
                    onChange={(event) => moveItemToGroup(gi, ii, event.currentTarget.value)}
                    aria-label={t('moveToGroup')}
                    className="w-44"
                    triggerClassName="h-9 text-xs"
                  >
                    {config.groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.label}
                      </option>
                    ))}
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={item.mobile ? t('unpinMobile') : t('pinMobile')}
                    title={item.mobile ? t('unpinMobile') : t('pinMobile')}
                    onClick={() => toggleMobile(gi, ii)}
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
                  >
                    {item.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('moveItemUp')}
                    onClick={() => setGroup(gi, { items: move(g.items, ii, -1) })}
                  >
                    <ArrowUp size={14} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('moveItemDown')}
                    onClick={() => setGroup(gi, { items: move(g.items, ii, 1) })}
                  >
                    <ArrowDown size={14} />
                  </Button>
                  {item.kind === 'link' ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('deleteLink')}
                      onClick={() =>
                        setGroup(gi, {
                          items: g.items.filter((_, index) => index !== ii),
                        })
                      }
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
              onClick={() => {
                const href = prompt(t('linkUrlPrompt'))
                if (!href) return
                const label = prompt(t('linkLabelPrompt')) ?? href
                setGroup(gi, {
                  items: [...g.items, { kind: 'link', href, label }],
                })
              }}
            >
              <Plus size={13} /> {t('addLink')}
            </Button>
          </CardContent>
        </Card>
      ))}

      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={busy}>
          {busy ? tCommon('actions.saving') : t('save')}
        </Button>
        <Button variant="outline" onClick={() => setConfig(defaultNavConfig())}>
          <RotateCcw size={14} /> {t('resetDefaults')}
        </Button>
        <Button variant="outline" onClick={addGroup}>
          <FolderPlus size={14} /> {t('addGroup')}
        </Button>
      </div>
    </div>
  )
}
