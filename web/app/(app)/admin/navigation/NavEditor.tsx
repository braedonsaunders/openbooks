'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
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
      toast.success('Navigation saved')
      router.refresh()
    } else {
      toast.error((await res.json()).error ?? 'Could not save')
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
                aria-label="Group label"
              />
              <span className="flex-1" />
              <Button variant="ghost" size="icon" aria-label="Move group up"
                onClick={() => setConfig((c) => ({ ...c, groups: move(c.groups, gi, -1) }))}>
                <ArrowUp size={14} />
              </Button>
              <Button variant="ghost" size="icon" aria-label="Move group down"
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
                    aria-label="Item label"
                  />
                  {item.kind === 'module' ? (
                    <span className="font-mono text-xs text-slate-400">{item.moduleKey}</span>
                  ) : (
                    <span className="truncate font-mono text-xs text-slate-400">{item.href}</span>
                  )}
                  <span className="flex-1" />
                  <Button variant="ghost" size="icon" aria-label={item.hidden ? 'Show item' : 'Hide item'}
                    onClick={() =>
                      setGroup(gi, { items: g.items.map((x, k) => (k === ii ? { ...x, hidden: !x.hidden } : x)) })
                    }>
                    {item.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                  </Button>
                  <Button variant="ghost" size="icon" aria-label="Move item up"
                    onClick={() => setGroup(gi, { items: move(g.items, ii, -1) })}>
                    <ArrowUp size={14} />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label="Move item down"
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
                const href = prompt('Link URL (internal route or https://…):')
                if (!href) return
                const label = prompt('Label:') ?? href
                setGroup(gi, { items: [...g.items, { kind: 'link', href, label }] })
              }}
            >
              <Plus size={13} /> Add link
            </Button>
          </CardContent>
        </Card>
      ))}

      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save navigation'}
        </Button>
        <Button variant="outline" onClick={() => setConfig(defaultNavConfig())}>
          <RotateCcw size={14} /> Reset to defaults
        </Button>
      </div>
    </div>
  )
}
