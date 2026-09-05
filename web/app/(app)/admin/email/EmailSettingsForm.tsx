'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, Select, cn } from '@openbooks/ui'
import { EMAIL_PROVIDER_SPECS, type EmailProvider } from '@openbooks/emails/providers'

type View = {
  enabled?: boolean
  provider?: EmailProvider
  fromName?: string
  fromEmail?: string
  replyTo?: string
  mailgunDomain?: string
  mailgunRegion?: 'us' | 'eu'
  smtpHost?: string
  smtpPort?: number
  smtpSecure?: boolean
  smtpUsername?: string
  hasSecret: boolean
  updatedAt: string | null
}

export function EmailSettingsForm({ initial }: { initial: View }) {
  const router = useRouter()
  const [v, setV] = useState<View>(initial)
  const [secret, setSecret] = useState('') // new plaintext; '' = keep existing
  const [replaceSecret, setReplaceSecret] = useState(!initial.hasSecret)
  const [saving, setSaving] = useState(false)
  const [testTo, setTestTo] = useState('')
  const [testing, setTesting] = useState(false)

  const spec = useMemo(() => EMAIL_PROVIDER_SPECS.find((s) => s.value === v.provider), [v.provider])
  const set = (patch: Partial<View>) => setV((prev) => ({ ...prev, ...patch }))

  async function save() {
    setSaving(true)
    try {
      // `hasSecret` is a read-only flag the API reports back; never send it.
      const { hasSecret: _hasSecret, updatedAt, ...rest } = v
      const body: Record<string, unknown> = { ...rest, expectedUpdatedAt: updatedAt }
      if (replaceSecret) body.secret = secret.trim() ? secret.trim() : null
      const res = await fetch('/api/admin/email', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Save failed')
      setV(data)
      setSecret('')
      setReplaceSecret(!data.hasSecret)
      toast.success('Email settings saved')
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function sendTest() {
    setTesting(true)
    try {
      const res = await fetch('/api/admin/email/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: testTo.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Test failed')
      toast.success(`Test sent via ${data.provider} (${data.messageId})`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Test failed')
    } finally {
      setTesting(false)
    }
  }

  const field = 'space-y-1.5'

  return (
    <div className="max-w-2xl space-y-6">
      {/* enable */}
      <label className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
        <input type="checkbox" checked={!!v.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="h-4 w-4" />
        <div>
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Enable email delivery</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">Scheduled reports and test sends use the provider below.</div>
        </div>
      </label>

      <div className={field}>
        <Label>Provider</Label>
        <Select value={v.provider ?? ''} onChange={(e) => set({ provider: (e.target.value || undefined) as EmailProvider })}>
          <option value="">Select a provider…</option>
          {EMAIL_PROVIDER_SPECS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </Select>
        {spec?.docsHint ? <p className="text-xs text-slate-500 dark:text-slate-400">{spec.docsHint}</p> : null}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className={field}>
          <Label>From name</Label>
          <Input value={v.fromName ?? ''} onChange={(e) => set({ fromName: e.target.value })} placeholder="Acme Accounting" />
        </div>
        <div className={field}>
          <Label>From email</Label>
          <Input value={v.fromEmail ?? ''} onChange={(e) => set({ fromEmail: e.target.value })} placeholder="reports@acme.com" />
        </div>
        <div className={field}>
          <Label>Reply-to (optional)</Label>
          <Input value={v.replyTo ?? ''} onChange={(e) => set({ replyTo: e.target.value })} placeholder="ap@acme.com" />
        </div>
      </div>

      {/* provider-specific non-secret fields */}
      {spec && spec.fields.length > 0 ? (
        <div className="grid grid-cols-2 gap-3">
          {spec.fields.map((f) => (
            <div key={f.key} className={field}>
              <Label>{f.label}</Label>
              {f.kind === 'select' ? (
                <Select
                  value={(v as Record<string, unknown>)[f.key] as string | undefined ?? ''}
                  onChange={(e) => set({ [f.key]: e.target.value || undefined } as Partial<View>)}
                >
                  {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              ) : f.kind === 'boolean' ? (
                <label className="flex h-9 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={Boolean((v as Record<string, unknown>)[f.key])}
                    onChange={(e) => set({ [f.key]: e.target.checked } as Partial<View>)}
                    className="h-4 w-4"
                  />
                  {f.label}
                </label>
              ) : (
                <Input
                  type={f.kind === 'number' ? 'number' : 'text'}
                  value={(v as Record<string, unknown>)[f.key] as string | number | undefined ?? ''}
                  onChange={(e) => set({ [f.key]: f.kind === 'number' ? (e.target.value ? Number(e.target.value) : undefined) : e.target.value || undefined } as Partial<View>)}
                  placeholder={f.placeholder}
                />
              )}
              {f.help ? <p className="text-xs text-slate-500 dark:text-slate-400">{f.help}</p> : null}
            </div>
          ))}
        </div>
      ) : null}

      {/* secret */}
      {spec?.hasSecret ? (
        <div className={field}>
          <Label>
            {spec.secretLabel}
            {v.hasSecret && !replaceSecret ? <Badge variant="secondary" className="ml-2">set</Badge> : null}
          </Label>
          {v.hasSecret && !replaceSecret ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-500 dark:text-slate-400">•••••••••• stored</span>
              <Button variant="outline" size="sm" onClick={() => setReplaceSecret(true)}>Replace</Button>
            </div>
          ) : (
            <>
              <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={spec.keyHint} autoComplete="off" />
              {v.hasSecret ? (
                <button type="button" className="text-xs text-slate-500 hover:underline" onClick={() => { setReplaceSecret(false); setSecret('') }}>
                  Keep existing credential
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</Button>
      </div>

      {/* test */}
      <div className={cn('space-y-2 rounded-lg border border-slate-200 p-4 dark:border-slate-800')}>
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">Send a test email</div>
        <div className="flex items-center gap-2">
          <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" className="max-w-xs" />
          <Button variant="outline" onClick={sendTest} disabled={testing || !testTo.trim()}>{testing ? 'Sending…' : 'Send test'}</Button>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">Save your settings first — the test uses the stored provider.</p>
      </div>
    </div>
  )
}
