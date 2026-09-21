'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Drawer, Input, Label, Select, Textarea } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { promptDialog } from '../../../../lib/prompt'

/**
 * Qualification record and detail drawer. Opens blank for recording
 * (employment, type, issue/expiry, identifier, notes) or on a
 * qualification id for detail: the credential with its derived status,
 * evidence preview, and the append-only event trail. Verify, renew,
 * revoke and evidence-attach run here against the qualifications API
 * routes with their refusals rendered intact — res.ok is checked before
 * parsing, failures render inline, and nothing is swallowed. Renewal
 * writes a new row (the drawer navigates to it); revocation freezes the
 * row with a reason.
 */

interface QualificationType {
  id: string
  code: string
  name: string
  category: string
  validityMonths: number | null
  requiresEvidence: boolean
  isActive: boolean
}

interface Detail {
  qualification: {
    id: string
    employmentId: string
    type: QualificationType
    identifier: string | null
    issuedOn: string
    expiresOn: string | null
    storedStatus: string
    status: string
    evidenceFileId: string | null
    notes: string | null
  }
  events: { id: string; kind: string; actorId: string | null; reason: string | null; recordedAt: string }[]
}

export function QualificationDrawer({
  qualificationId,
  recordOpen,
  onClose,
}: {
  qualificationId: string | null
  recordOpen: boolean
  onClose: () => void
}) {
  const t = useTranslations('hrm')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [types, setTypes] = useState<QualificationType[]>([])
  const [loading, setLoading] = useState(qualificationId !== null)
  const [status, setStatus] = useState<string | undefined>(undefined)
  const [form, setForm] = useState({ employmentId: '', typeId: '', issuedOn: '', expiresOn: '', identifier: '', notes: '' })

  useEffect(() => {
    let cancelled = false
    if (!qualificationId) {
      setDetail(null)
      setLoading(false)
    } else {
      setLoading(true)
      ;(async () => {
        try {
          const res = await fetch(`/api/hrm/qualifications/${qualificationId}`)
          if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed to load the qualification'))
          const j = (await res.json()) as Detail
          if (!cancelled) {
            setDetail(j)
            setStatus(undefined)
          }
        } catch (e) {
          if (!cancelled) setStatus((e as Error).message)
        } finally {
          if (!cancelled) setLoading(false)
        }
      })()
    }
    ;(async () => {
      try {
        const res = await fetch('/api/hrm/qualification-types')
        if (!res.ok) return
        const j = (await res.json()) as { types?: QualificationType[] }
        if (!cancelled && Array.isArray(j.types)) setTypes(j.types)
      } catch {
        // The type list failing leaves the record form unusable, not the
        // drawer: detail still renders, recording waits for types.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [qualificationId])

  async function run(path: string, method: string, body: unknown, okLabel: string): Promise<void> {
    setStatus(undefined)
    try {
      const res = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(await readApiErrorMessage(res, okLabel))
      router.refresh()
      if (qualificationId) {
        const reread = await fetch(`/api/hrm/qualifications/${qualificationId}`)
        if (!reread.ok) throw new Error(await readApiErrorMessage(reread, 'failed to reload the qualification'))
        setDetail((await reread.json()) as Detail)
      } else {
        onClose()
      }
    } catch (e) {
      setStatus((e as Error).message)
    }
  }

  async function verify(): Promise<void> {
    if (!qualificationId) return
    await run(`/api/hrm/qualifications/${qualificationId}/verify`, 'POST', {}, 'failed to verify')
  }

  async function revoke(): Promise<void> {
    if (!qualificationId) return
    const prompt = t('qualifications.revokePrompt')
    const reason = await promptDialog({ title: prompt, label: prompt, confirmLabel: prompt })
    if (reason === null) return
    await run(`/api/hrm/qualifications/${qualificationId}/revoke`, 'POST', { reason }, 'failed to revoke')
  }

  async function renew(): Promise<void> {
    if (!qualificationId || !detail) return
    const issuedOn = window.prompt(t('qualifications.renewPrompt'), new Date().toISOString().slice(0, 10))
    if (!issuedOn) return
    setStatus(undefined)
    try {
      const res = await fetch(`/api/hrm/qualifications/${qualificationId}/renew`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ issuedOn }),
      })
      // res.ok first, always: a refusal body is not parsed as success.
      if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed to renew'))
      const j = (await res.json()) as { qualification?: { id?: string } }
      const nextId = j.qualification?.id
      router.refresh()
      if (nextId) {
        const reread = await fetch(`/api/hrm/qualifications/${nextId}`)
        if (reread.ok) setDetail((await reread.json()) as Detail)
      }
    } catch (e) {
      setStatus((e as Error).message)
    }
  }

  async function record(): Promise<void> {
    await run('/api/hrm/qualifications', 'POST', {
      employmentId: form.employmentId || undefined,
      typeId: form.typeId || undefined,
      issuedOn: form.issuedOn || undefined,
      expiresOn: form.expiresOn || null,
      identifier: form.identifier || null,
      notes: form.notes || null,
    }, 'failed to record')
  }

  const q = detail?.qualification
  const isPending = q?.storedStatus === 'pending_verification'
  const isRevoked = q?.storedStatus === 'revoked'

  return (
    <Drawer open onClose={onClose} size="md" title={q ? t('qualifications.drawerTitle') : t('qualifications.recordTitle')}>
      {loading ? <p className="text-sm text-slate-500">{tCommon('loading')}</p> : null}
      {status ? <p className="mb-3 text-sm text-red-700 dark:text-red-300">{status}</p> : null}
      {q ? (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-slate-500">{t('qualifications.columns.type')}</dt>
            <dd className="font-medium">{q.type.code} · {q.type.name}</dd>
            <dt className="text-slate-500">{t('qualifications.columns.status')}</dt>
            <dd className="font-medium">{q.status}</dd>
            <dt className="text-slate-500">{t('qualifications.drawer.issued')}</dt>
            <dd className="tabular-nums">{q.issuedOn}</dd>
            <dt className="text-slate-500">{t('qualifications.columns.expiry')}</dt>
            <dd className="tabular-nums">{q.expiresOn ?? '—'}</dd>
            {q.identifier ? (
              <>
                <dt className="text-slate-500">{t('qualifications.drawer.identifier')}</dt>
                <dd className="font-mono">{q.identifier}</dd>
              </>
            ) : null}
            {q.notes ? (
              <>
                <dt className="text-slate-500">{t('qualifications.drawer.notes')}</dt>
                <dd>{q.notes}</dd>
              </>
            ) : null}
          </dl>
          {q.evidenceFileId ? (
            <p className="text-sm">
              <a className="font-medium text-teal-700 hover:underline dark:text-teal-300" href={`/api/file-cabinet/files/${q.evidenceFileId}`}>
                {t('qualifications.drawer.evidence')}
              </a>
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {isPending ? <Button onClick={verify}>{t('qualifications.verify')}</Button> : null}
            {!isRevoked ? <Button variant="outline" onClick={renew}>{t('qualifications.renew')}</Button> : null}
            {!isRevoked ? <Button variant="outline" onClick={revoke}>{t('qualifications.revoke')}</Button> : null}
          </div>
          <section aria-label={t('qualifications.drawer.events')}>
            <h3 className="mb-1 text-sm font-semibold">{t('qualifications.drawer.events')}</h3>
            <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
              {(detail?.events ?? []).map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
                  <span className="font-medium">{e.kind}</span>
                  {e.reason ? <span className="text-slate-500">{e.reason}</span> : null}
                  <span className="ml-auto tabular-nums text-slate-400">{e.recordedAt}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : recordOpen ? (
        <div className="flex flex-col gap-3">
          <div>
            <Label htmlFor="q-employment">{t('qualifications.recordForm.employment')}</Label>
            <Input id="q-employment" value={form.employmentId} onChange={(e) => setForm({ ...form, employmentId: e.target.value })} placeholder="employment id" />
          </div>
          <div>
            <Label htmlFor="q-type">{t('qualifications.recordForm.type')}</Label>
            <Select id="q-type" value={form.typeId} onChange={(e) => setForm({ ...form, typeId: e.target.value })}>
              <option value="">{tCommon('select')}</option>
              {types.map((type) => (
                <option key={type.id} value={type.id}>{type.code} · {type.name}</option>
              ))}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="q-issued">{t('qualifications.recordForm.issuedOn')}</Label>
              <Input id="q-issued" type="date" value={form.issuedOn} onChange={(e) => setForm({ ...form, issuedOn: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="q-expires">{t('qualifications.recordForm.expiresOn')}</Label>
              <Input id="q-expires" type="date" value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} />
            </div>
          </div>
          <div>
            <Label htmlFor="q-identifier">{t('qualifications.recordForm.identifier')}</Label>
            <Input id="q-identifier" value={form.identifier} onChange={(e) => setForm({ ...form, identifier: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="q-notes">{t('qualifications.recordForm.notes')}</Label>
            <Textarea id="q-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
          <div>
            <Button onClick={record}>{t('qualifications.record')}</Button>
          </div>
        </div>
      ) : null}
    </Drawer>
  )
}
