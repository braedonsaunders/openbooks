'use client'
import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Alert, AlertDescription, Button, Drawer } from '@openbooks/ui'
import type { FieldValueMap } from '@openbooks/forms-core'
import type { NativeExtension } from '@/lib/apps/native-ui'
import { RecordFields, RecordPreviewOptions } from '@/components/record-fields'
import { validateRecordData, withComputedFormulas } from '@/lib/record-schema'
import { confirmDialog } from '@/lib/confirm'
import { readApiErrorMessage } from '@/lib/api-error'

type ActionScreen = Extract<NativeExtension['screens'][number], { kind: 'action' }>
/** The same form editor and validation as RecordDrawer; only submission goes
 * through the installed package's governed backend instead of record CRUD. */
export function NativeActionForm({ appKey, versionId, screen, preview }: {
  appKey: string; versionId?: string; screen: ActionScreen; preview: boolean
}) {
  const t = useTranslations('admin.extensions.native')
  const [open, setOpen] = useState(false)
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
      // The status is checked before the body is parsed: a non-JSON error
      // body must surface the actions-route refusal, never a SyntaxError
      // from response.json() that hides the named remedy.
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t('actionFailed')))
      const result = await response.json() as { ok?: boolean; error?: string; result?: { status: number; body: unknown } }
      if (!result.ok) throw new Error(result.error || t('actionFailed'))
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
  return <>
    <Button onClick={() => setOpen(true)}>{screen.title}</Button>
    <Drawer open={open} onClose={() => setOpen(false)} title={screen.title} description={screen.description} size="lg"
      footer={<Button type="submit" form={`action-${screen.key}`} disabled={preview || !versionId || busy}>{busy ? t('actionRunning') : screen.submitLabel}</Button>}>
    <form id={`action-${screen.key}`} onSubmit={submit} className="space-y-6">
    <fieldset disabled={busy} className="min-w-0">
      <RecordPreviewOptions.Provider value={preview ? [{ value: 'preview-reference', label: t('sampleReference') }] : null}>
      <RecordFields sections={screen.fields} values={values} onChange={(field, value) => {
        setValues(current => ({ ...current, [field]: value })); invocation.current = null; setError(''); setMessage('')
      }} />
      </RecordPreviewOptions.Provider>
    </fieldset>
    {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
    {message && <p role="status">{message}</p>}
  </form>
  </Drawer>
  </>
}
