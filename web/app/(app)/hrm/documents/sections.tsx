'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge, Button, Input, Label, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, UrlDrawer } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { promptDialog } from '../../../../lib/prompt'
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

async function post(url: string, body: unknown, failed: string): Promise<boolean> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    toast.error(await readApiErrorMessage(res, failed))
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
  const labels = drawer.labels
  const document = drawer.document
  if (!document) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">{drawer.missingDetail}</p>
  }
  const actionable = ['draft', 'sent', 'viewed', 'partially_signed'].includes(document.status)
  const base = `/api/hrm/documents/${document.id}`
  const held = document.legalHold

  async function send() {
    if (await post(`${base}/send`, {}, msg(labels, 'actionFailed'))) router.refresh()
  }

  async function remind() {
    if (await post(`${base}/remind`, {}, msg(labels, 'actionFailed'))) router.refresh()
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
        {canAct && actionable && (
          <Button onClick={send}>{msg(labels, 'send')}</Button>
        )}
        {canAct && document.status !== 'draft' && <Button variant="outline" onClick={remind}>{msg(labels, 'remind')}</Button>}
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
                <span className="text-slate-500">{event.recordedAt}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {document.fileId && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{msg(labels, 'versions')}</h3>
          <p className="text-sm text-slate-500">{document.fileId}</p>
        </section>
      )}
      {(document.retainUntil || document.retentionAction) && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{msg(labels, 'retention')}</h3>
          <p className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
            <span>{document.retentionAction ?? '—'}{document.retainUntil ? ` · ${document.retainUntil}` : ''}</span>
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
  const router = useRouter()
  const [templateId, setTemplateId] = useState('')
  const [partyId, setPartyId] = useState('')
  const [title, setTitle] = useState('')
  const [preview, setPreview] = useState<Record<string, string> | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  if (!generate) return null
  const labels = generate.labels
  const template = generate.templates.find((t) => t.value === templateId) ?? null

  async function loadPreview() {
    setFailed(null)
    if (!partyId) return
    const res = await fetch('/api/hrm/documents?mode=preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ partyId }),
    })
    if (!res.ok) {
      setFailed(await readApiErrorMessage(res, msg(labels, 'failed')))
      return
    }
    setPreview((await res.json()).mergeValues as Record<string, string>)
  }

  async function submit() {
    setFailed(null)
    const ok = await post(
      '/api/hrm/documents?mode=generate',
      { templateId, partyId, title },
      msg(labels, 'failed'),
    )
    if (!ok) {
      setFailed(msg(labels, 'failed'))
      return
    }
    router.push('/hrm/documents')
    router.refresh()
  }

  return (
    <UrlDrawer open closeHref={generate.closeHref} title={msg(labels, 'title')}>
      <div className="flex flex-col gap-4">
        {generate.templates.length === 0 ? (
          <p className="text-sm text-slate-500">{msg(labels, 'noTemplates')}</p>
        ) : (
          <>
            <div>
              <Label>{msg(labels, 'template')}</Label>
              <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                {generate.templates.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label} — {t.category}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>{msg(labels, 'person')}</Label>
              <Select value={partyId} onChange={(e) => setPartyId(e.target.value)}>
                {generate.people.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>{msg(labels, 'docTitle')}</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
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
              <Button onClick={submit} disabled={!templateId || !partyId || !title.trim()}>
                {msg(labels, 'submit')}
              </Button>
            </div>
            {preview && (
              <Table>
                <TableBody>
                  {Object.entries(preview).map(([key, value]) => (
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
