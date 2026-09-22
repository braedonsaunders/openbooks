'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Drawer, Input, Label } from '@openbooks/ui'

/**
 * Unsaved create: opens a local dialog (name + description, zero writes) and
 * POSTs /api/insights/dashboards only on explicit Save, then routes to the
 * new board. Cancel/close writes nothing.
 */
export function NewDashboardButton() {
  const t = useTranslations('insights.dashboards')
  const tb = useTranslations('insights.builder')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  // One stable idempotency key per dialog session: a double-clicked Save (or
  // a retried request) resolves to the same dashboard instead of a duplicate.
  const requestIdRef = useRef<string | null>(null)

  async function save() {
    setBusy(true)
    if (!requestIdRef.current) requestIdRef.current = crypto.randomUUID()
    try {
      const res = await fetch('/api/insights/dashboards', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': requestIdRef.current,
        },
        body: JSON.stringify({
          name: name.trim() || tb('untitled'),
          description: description.trim() || null,
        }),
      })
      if (!res.ok) {
        const failure = (await res.json().catch(() => null)) as { error?: unknown } | null
        toast.error(
          typeof failure?.error === 'string' && failure.error
            ? failure.error
            : t('createDraftFailed'),
        )
        return
      }
      const data = (await res.json()) as { id?: unknown }
      if (typeof data.id !== 'string' || !data.id) {
        toast.error(t('createDraftFailed'))
        return
      }
      setOpen(false)
      router.push(`/insights/dashboards/${data.id}`)
      router.refresh()
    } catch {
      toast.error(t('createDraftFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus size={15} /> {t('newButton')}
      </Button>
      {open ? (
        <Drawer
          open
          onClose={() => setOpen(false)}
          size="md"
          title={t('newButton')}
          headerActions={
            <>
              <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
                {tCommon('actions.cancel')}
              </Button>
              <Button disabled={busy} onClick={save}>
                {busy ? tCommon('actions.creating') : tCommon('actions.create')}
              </Button>
            </>
          }
        >
          <div className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="new-dashboard-name">{tCommon('labels.name')}</Label>
              <Input
                id="new-dashboard-name"
                value={name}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
                placeholder={tb('namePlaceholder')}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="new-dashboard-description">{tCommon('labels.description')}</Label>
              <Input
                id="new-dashboard-description"
                value={description}
                disabled={busy}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={tCommon('labels.optional')}
              />
            </div>
          </div>
        </Drawer>
      ) : null}
    </>
  )
}
