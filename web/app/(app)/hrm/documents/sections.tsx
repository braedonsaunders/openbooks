'use client'

import { useId, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, UrlDrawer } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { confirmDialog } from '../../../../lib/confirm'
import { promptDialog } from '../../../../lib/prompt'
import { useViewerFormat } from '../../../../lib/viewer-format'
import type { loadDocumentsHome } from '../../../../lib/hrm/documents-home'

/**
 * Documents drawer + generate dialog islands (0230, HR-19).
 *
 * The drawer shows the signers timeline (ordered, with per-signer
 * status), the append-only events, and the file versions, with HR
 * actions (send, remind, void with reason, legal hold toggle, download)
 * that POST the matching API route and refresh the list. The generate
 * dialog resolves merge values through ?mode=preview before submitting,
 * so HR sees what the template will say. Every fetch branches on
 * res.ok FIRST — the refusal message lives in the error body.
 */

type Home = NonNullable<Awaited<ReturnType<typeof loadDocumentsHome>>>
type Drawer = NonNullable<Home['drawer']>

function msg(labels: Record<string, string>, key: string): string {
  return labels[key] ?? key
}

async function post(url: string, body: unknown, failed: string, onRefusal?: (message: string) => void, headers?: Record<string, string>): Promise<boolean> {
  // A transport failure rejects instead of resolving: without the catch
  // the caller's await throws past its reset and the operator gets an
  // unhandled rejection instead of the failure copy.
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  } catch {
    toast.error(failed)
    onRefusal?.(failed)
    return false
  }
  if (!res.ok) {
    const message = await readApiErrorMessage(res, failed)
    toast.error(message)
    onRefusal?.(message)
    return false
  }
  return true
}

function signerStatusLabel(status: string, labels: Record<string, string>): string {
  switch (status) {
    case 'signed':
      return msg(labels, 'signed')
    case 'declined':
      return msg(labels, 'declined')
    case 'viewed':
      return msg(labels, 'viewed')
    default:
      return msg(labels, 'pending')
  }
}

/**
 * Document timeline event kinds arrive as stored codes; the drawer shows
 * the translated event label. An unrecognized kind falls back to the raw
 * code (the same unknown-code rule as signer statuses) so a new engine
 * event never renders blank.
 */
function eventKindLabel(kind: string, labels: Record<string, string>): string {
  switch (kind) {
    case 'created':
      return msg(labels, 'eventCreated')
    case 'sent':
      return msg(labels, 'eventSent')
    case 'viewed':
      return msg(labels, 'eventViewed')
    case 'signed':
      return msg(labels, 'eventSigned')
    case 'declined':
      return msg(labels, 'eventDeclined')
    case 'acknowledged':
      return msg(labels, 'eventAcknowledged')
    case 'voided':
      return msg(labels, 'eventVoided')
    case 'reminded':
      return msg(labels, 'eventReminded')
    case 'expired':
      return msg(labels, 'eventExpired')
    case 'retention_flagged':
      return msg(labels, 'eventRetentionFlagged')
    case 'deleted':
      return msg(labels, 'eventDeleted')
    default:
      return kind
  }
}

export function DocumentDrawerBody({ drawer }: { drawer: Drawer }) {
  const router = useRouter()
  const [remindPending, setRemindPending] = useState(false)
  const remindPendingRef = useRef(false)
  const remindKey = useRef<{ documentId: string; value: string } | null>(null)
  const commonActions = useTranslations('common.actions')
  const viewer = useViewerFormat()
  const labels = drawer.labels
  const document = drawer.document
  if (!document) {
    return <div className="flex items-center gap-3">
      <p role={drawer.loadError ? 'alert' : undefined} className="text-sm text-slate-500 dark:text-slate-400">{drawer.missingDetail}</p>
      {drawer.loadError && <Button variant="outline" onClick={() => router.refresh()}>{commonActions('retry')}</Button>}
    </div>
  }
  const actionable = ['draft', 'sent', 'viewed', 'partially_signed'].includes(document.status)
  const canRemind = ['sent', 'viewed', 'partially_signed'].includes(document.status)
  // Hoisted beside base: tsc does not carry the early-return narrowing
  // into the async action closures below, so no closure reads document.id.
  const documentId = document.id
  const base = `/api/hrm/documents/${documentId}`
  const held = document.legalHold

  async function send() {
    if (await post(`${base}/send`, {}, msg(labels, 'actionFailed'))) router.refresh()
  }

  async function remind() {
    if (remindPendingRef.current) return
    remindPendingRef.current = true
    setRemindPending(true)
    if (remindKey.current?.documentId !== documentId) {
      remindKey.current = { documentId, value: crypto.randomUUID() }
    }
    const idempotencyKey = remindKey.current.value
    try {
      if (await post(`${base}/remind`, {}, msg(labels, 'actionFailed'), undefined, { 'idempotency-key': idempotencyKey })) {
        remindKey.current = null
        router.refresh()
      }
    } finally {
      remindPendingRef.current = false
      setRemindPending(false)
    }
  }

  async function voidDocument() {
    const reason = await promptDialog({ title: msg(labels, 'voidConfirm'), label: msg(labels, 'voidReason'), confirmLabel: msg(labels, 'voidConfirm') })
    if (!reason) return
    if (await post(`${base}/void`, { reason }, msg(labels, 'actionFailed'))) router.refresh()
  }

  async function toggleHold() {
    if (await post(`${base}/hold`, { hold: !held }, msg(labels, 'actionFailed'))) router.refresh()
  }

  // F3-38: Send, Remind, Void and Legal-hold are writes — they render
  // only with the manage grant, never on document status alone. Detail
  // and download stay readable without it.
  const canAct = drawer.canManage
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-2">
        {canAct && document.status === 'draft' && (
          <Button onClick={send}>{msg(labels, 'send')}</Button>
        )}
        {canAct && canRemind && <Button variant="outline" disabled={remindPending} onClick={remind}>{msg(labels, 'remind')}</Button>}
        {canAct && (
          <Button variant="outline" onClick={toggleHold}>
            {document.legalHold ? msg(labels, 'releaseHold') : msg(labels, 'hold')}
          </Button>
        )}
        {canAct && actionable && (
          <Button variant="outline" onClick={voidDocument}>{msg(labels, 'void')}</Button>
        )}
        {document.fileId && (
          <a href={`${base}/download`} className="inline-flex">
            <Button variant="outline">{msg(labels, 'download')}</Button>
          </a>
        )}
      </div>
      <section>
        <h3 className="mb-2 text-sm font-semibold">{msg(labels, 'signers')}</h3>
        {document.signers.length === 0 ? (
          <p className="text-sm text-slate-500">{msg(labels, 'noSigners')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>{msg(labels, 'signers')}</TableHead>
                <TableHead>{msg(labels, 'signed')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {document.signers.map((signer) => (
                <TableRow key={signer.id}>
                  <TableCell>{signer.ord}</TableCell>
                  <TableCell>{drawer.signerNames[signer.signerPartyId] ?? signer.role}</TableCell>
                  <TableCell>
                    <Badge variant={signer.status === 'signed' ? 'success' : signer.status === 'declined' ? 'destructive' : 'warning'}>
                      {signerStatusLabel(signer.status, labels)}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <section>
        <h3 className="mb-2 text-sm font-semibold">{msg(labels, 'events')}</h3>
        {document.events.length === 0 ? (
          <p className="text-sm text-slate-500">{msg(labels, 'noEvents')}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {document.events.map((event, index) => (
              <li key={index} className="flex justify-between gap-3">
                <span>{eventKindLabel(event.kind, labels)}</span>
                <span className="text-slate-500">{viewer.dateTime(event.recordedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {drawer.versions.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{msg(labels, 'versions')}</h3>
          <ul className="space-y-1">
            {drawer.versions.map((version) => (
              <li key={`${version.versionNumber}-${version.createdAt}`} className="text-sm text-slate-600 dark:text-slate-300">
                {version.filename} · #{version.versionNumber} · {viewer.date(version.createdAt, { dateStyle: 'medium', timeZone: 'UTC' })}
              </li>
            ))}
          </ul>
        </section>
      )}
      {(document.retainUntil || document.retentionAction) && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{msg(labels, 'retention')}</h3>
          <p className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
            <span>{document.retentionAction ? msg(labels, `retentionAction${document.retentionAction[0]?.toUpperCase()}${document.retentionAction.slice(1)}`) : '—'}{document.retainUntil ? ` · ${viewer.date(document.retainUntil, { dateStyle: 'medium', timeZone: 'UTC' })}` : ''}</span>
            {document.retentionUnverified ? (
              <Badge variant="warning">{msg(labels, 'retentionUnverified')}</Badge>
            ) : null}
          </p>
        </section>
      )}
    </div>
  )
}

export function DocumentsDrawer({ drawer }: { drawer: Home['drawer'] }) {
  if (!drawer) return null
  return (
    <UrlDrawer open closeHref={drawer.closeHref} title={drawer.title}>
      <DocumentDrawerBody drawer={drawer as Drawer} />
    </UrlDrawer>
  )
}

export function DocumentsGenerateDialog({ generate }: { generate: Home['generate'] }) {
  const fieldId = useId()
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [templateId, setTemplateId] = useState('')
  const [partyId, setPartyId] = useState('')
  const [title, setTitle] = useState('')
  // The preview is fingerprinted by the exact subject (and template) that
  // produced it (I4-webui-165): changing the person or template drops the
  // prior preview immediately, and a late response for a superseded subject
  // is discarded instead of rendering beside the new selection.
  const [preview, setPreview] = useState<{ partyId: string; templateId: string; values: Record<string, string> } | null>(null)
  const previewRequest = useRef(0)
  const [failed, setFailed] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const idempotencyKey = useRef<string | null>(null)
  // Merge inputs invalidate the preview: a preview for Ari must never stay
  // visible beside Bo's selection, and superseded fetches must not publish.
  const selectTemplate = (value: string) => {
    setTemplateId(value)
    setPreview(null)
    previewRequest.current += 1
  }
  const selectParty = (value: string) => {
    setPartyId(value)
    setPreview(null)
    previewRequest.current += 1
  }
  if (!generate) return null
  const labels = generate.labels
  const template = generate.templates.find((t) => t.value === templateId) ?? null

  async function loadPreview() {
    setFailed(null)
    if (!partyId) return
    const request = ++previewRequest.current
    const requestPartyId = partyId
    const requestTemplateId = templateId
    const res = await fetch('/api/hrm/documents?mode=preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ partyId }),
    })
    if (request !== previewRequest.current) return
    if (!res.ok) {
      setFailed(await readApiErrorMessage(res, msg(labels, 'failed')))
      return
    }
    setPreview({ partyId: requestPartyId, templateId: requestTemplateId, values: (await res.json()).mergeValues as Record<string, string> })
  }

  async function submit() {
    if (submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true)
    setFailed(null)
    idempotencyKey.current ??= crypto.randomUUID()
    try {
      const ok = await post(
        '/api/hrm/documents?mode=generate',
        { idempotencyKey: idempotencyKey.current, templateId, partyId, title },
        msg(labels, 'failed'),
        setFailed,
      )
      if (!ok) return
      router.push('/hrm/documents')
      router.refresh()
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  // A half-filled generate draft is unsaved work: drawer-level dismiss
  // (Escape, backdrop, X) asks before abandoning it. An in-flight generate
  // cannot be dismissed, even with a discard confirmation.
  async function confirmDiscard() {
    if (submitting) return false
    if (!templateId && !partyId && !title.trim()) return true
    return confirmDialog({
      message: tCommon('feedback.unsavedChanges'),
      confirmLabel: tCommon('confirm.discardChanges'),
      tone: 'danger',
    })
  }

  return (
    <UrlDrawer open closeHref={generate.closeHref} title={msg(labels, 'title')} beforeClose={confirmDiscard}>
      <div className="flex flex-col gap-4">
        {generate.templates.length === 0 ? (
          <p className="text-sm text-slate-500">{msg(labels, 'noTemplates')}</p>
        ) : (
          <>
            <div>
              <Label id={`${fieldId}-template-label`}>{msg(labels, 'template')}</Label>
              <Select id={`${fieldId}-template`} aria-labelledby={`${fieldId}-template-label`} aria-label={msg(labels, 'template')} value={templateId} onChange={(e) => { idempotencyKey.current = null; selectTemplate(e.target.value) }}>
                {generate.templates.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label} — {t.category}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label id={`${fieldId}-person-label`}>{msg(labels, 'person')}</Label>
              <Select id={`${fieldId}-person`} aria-labelledby={`${fieldId}-person-label`} aria-label={msg(labels, 'person')} value={partyId} onChange={(e) => { idempotencyKey.current = null; selectParty(e.target.value) }}>
                {generate.people.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label id={`${fieldId}-title-label`} htmlFor={`${fieldId}-title`}>{msg(labels, 'docTitle')}</Label>
              <Input id={`${fieldId}-title`} aria-labelledby={`${fieldId}-title-label`} aria-label={msg(labels, 'docTitle')} value={title} onChange={(e) => { idempotencyKey.current = null; setTitle(e.target.value) }} />
            </div>
            {template && (
              <p className="text-xs text-slate-500">
                {template.mergeFields.join(', ')}
              </p>
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={loadPreview} disabled={!partyId}>
                {msg(labels, 'preview')}
              </Button>
              <Button onClick={submit} disabled={submitting || !templateId || !partyId || !title.trim()}>
                {msg(labels, 'submit')}
              </Button>
            </div>
            {preview && preview.partyId === partyId && preview.templateId === templateId && (
              <Table>
                <TableBody>
                  {Object.entries(preview.values).map(([key, value]) => (
                    <TableRow key={key}>
                      <TableCell>{key}</TableCell>
                      <TableCell>{value}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {failed && <p className="text-sm text-red-600">{failed}</p>}
          </>
        )}
      </div>
    </UrlDrawer>
  )
}
