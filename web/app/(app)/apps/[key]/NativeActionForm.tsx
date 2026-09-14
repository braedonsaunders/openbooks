'use client'
import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Alert, AlertDescription, Button } from '@openbooks/ui'
import type { FieldValueMap } from '@openbooks/forms-core'
import type { NativeExtension } from '@/lib/apps/native-ui'
import { RecordFields } from '@/components/record-fields'
import { validateRecordData, withComputedFormulas } from '@/lib/record-schema'
import { confirmDialog } from '@/lib/confirm'

type ActionScreen = Extract<NativeExtension['screens'][number], { kind: 'action' }>
/** The same form editor and validation as RecordDrawer; only submission goes
 * through the installed package's governed backend instead of record CRUD. */
export function NativeActionForm({ appKey, versionId, screen, preview }: {
  appKey: string; versionId?: string; screen: ActionScreen; preview: boolean
}) {
  const t = useTranslations('admin.extensions.native')
  const [values, setValues] = useState<FieldValueMap>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const invocation = useRef<string | null>(null)
  const submitting = useRef(false)
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (preview || !versionId || submitting.current) return
    const input = withComputedFormulas(screen.fields, values)
    const errors = validateRecordData(screen.fields, input, 'submit')
    if (errors.length) { setError(errors.map(item => item.message).join('; ')); return }
    submitting.current = true
    setBusy(true)
    try {
      if (screen.confirmation && !(await confirmDialog({ title: screen.title, message: screen.confirmation }))) return
      setError(''); setMessage('')
      invocation.current ??= crypto.randomUUID()
      const response = await fetch(`/api/apps/${encodeURIComponent(appKey)}/actions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ screenKey: screen.key, versionId, invocationId: invocation.current, input }),
      })
      const result = await response.json() as { ok?: boolean; error?: string; result?: { status: number; body: unknown } }
      if (!response.ok || !result.ok) throw new Error(result.error || t('actionFailed'))
      const body = result.result?.body
      const text = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string' ? body.message : ''
      if ((result.result?.status ?? 500) >= 400) throw new Error(text || t('actionFailed'))
      setMessage(text || t('actionComplete'))
      invocation.current = null
    } catch (failure) {
      // Keep the invocation ID after an uncertain response: retry must replay.
      setError(failure instanceof Error ? failure.message : t('actionFailed'))
    } finally { submitting.current = false; setBusy(false) }
  }
  return <form onSubmit={submit} className="space-y-6">
    {preview && <Alert variant="info"><AlertDescription>{t('previewAction')}</AlertDescription></Alert>}
    <fieldset disabled={busy} className="min-w-0">
      <RecordFields sections={screen.fields} values={values} disabled={preview} onChange={(field, value) => {
        setValues(current => ({ ...current, [field]: value })); invocation.current = null; setError(''); setMessage('')
      }} />
    </fieldset>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {message && <p role="status">{message}</p>}
    <Button type="submit" disabled={preview || !versionId || busy}>{busy ? t('actionRunning') : screen.submitLabel}</Button>
  </form>
}
