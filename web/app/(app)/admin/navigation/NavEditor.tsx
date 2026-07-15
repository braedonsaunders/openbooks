'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowDown, ArrowUp, Eye, EyeOff, Plus, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Card, CardContent, Input, cn } from '@openbooks/ui'
import { MODULE_BY_KEY, defaultNavConfig, type NavGroupConfig, type NavItemConfig, type OrgNavConfig } from '../../../../lib/nav/registry'

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
    setConfig((c) => ({ ...c, groups: c.groups.map((g, i) => (i === gi ? { ...g, ...patch } : g)) }))

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
              <Button variant="ghost" size="icon" aria-label={t('moveGroupUp')}
                onClick={() => setConfig((c) => ({ ...c, groups: move(c.groups, gi, -1) }))}>
                <ArrowUp size={14} />
              </Button>
              <Button variant="ghost" size="icon" aria-label={t('moveGroupDown')}
                onClick={() => setConfig((c) => ({ ...c, groups: move(c.groups, gi, 1) }))}>
                <ArrowDown size={14} />
              </Button>
            </div>

            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {g.items.map((item, ii) => (
                <li key={ii} className={cn('flex items-center gap-2 py-1.5', item.hidden && 'opacity-45')}>
                  <Input
                    value={itemLabel(item)}
                    onChange={(e) =>
                      setGroup(gi, {
                        items: g.items.map((x, k) => (k === ii ? { ...x, label: e.target.value } : x)),
                      })
                    }
                    className="max-w-64"
                    aria-label={t('itemLabelAria')}
                  />
                  {item.kind === 'module' ? (
                    <span className="font-mono text-xs text-slate-400">{item.moduleKey}</span>
                  ) : (
                    <span className="truncate font-mono text-xs text-slate-400">{item.href}</span>
                  )}
                  <span className="flex-1" />
                  <Button variant="ghost" size="icon" aria-label={item.hidden ? t('showItem') : t('hideItem')}
                    onClick={() =>
                      setGroup(gi, { items: g.items.map((x, k) => (k === ii ? { ...x, hidden: !x.hidden } : x)) })
                    }>
                    {item.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={t('moveItemUp')}
                    onClick={() => setGroup(gi, { items: move(g.items, ii, -1) })}>
                    <ArrowUp size={14} />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={t('moveItemDown')}
                    onClick={() => setGroup(gi, { items: move(g.items, ii, 1) })}>
                    <ArrowDown size={14} />
                  </Button>
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
                setGroup(gi, { items: [...g.items, { kind: 'link', href, label }] })
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
      </div>
    </div>
  )
}
