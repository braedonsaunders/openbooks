'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Drawer, Input, Label, SearchSelect, Select, Textarea } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { promptDialog } from '../../../../lib/prompt'
import { useDirtyClose } from '../../../../lib/use-dirty-close'
import { useBusinessToday } from '../../../../components/business-date-provider'

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
  canManage,
  onClose,
}: {
  qualificationId: string | null
  recordOpen: boolean
  /** Loader-resolved manage grant: Verify, Renew and Revoke render
   * only with it, never on stored status alone. */
  canManage: boolean
  onClose: () => void
}) {
  const t = useTranslations('hrm')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  // The renewal default is the org's business day from the server, never
  // the browser's UTC day (tomorrow after 5pm Pacific).
  const today = useBusinessToday()
  // Whose detail the loaded row belongs to is part of the state, so
  // switching records shows nothing rather than the previous person's
  // credential for one frame. Clearing by deriving instead of by
  // setState-in-effect also keeps the open to one render pass.
  const [loaded, setLoaded] = useState<{ id: string; detail: Detail } | null>(null)
  const detail = loaded && loaded.id === qualificationId ? loaded.detail : null
  const [types, setTypes] = useState<QualificationType[]>([])
  const [typesError, setTypesError] = useState<string | null>(null)
  const typeRequestId = useRef(0)
  // The record form names the worker through the employments picker (ids,
  // never free-text uuids): a searchable server-backed page, since the
  // options contract refuses limits above 100 and a fixed 200 always 422s.
  // A picker failure is an error with retry, never a silent empty list.
  const [employments, setEmployments] = useState<{ value: string; label: string }[]>([])
  const [employmentsError, setEmploymentsError] = useState<string | null>(null)
  const [employmentQuery, setEmploymentQuery] = useState('')
  // Loading is a fact about the state, not a second copy of it (the drawer
  // derives its own loading the same way): settled flips only in the async
  // continuations below, so no setState-in-effect is needed.
  const [employmentsReady, setEmploymentsReady] = useState(false)
  const [employmentRetry, setEmploymentRetry] = useState(0)
  const employmentRequestId = useRef(0)
  const employmentsLoading = recordOpen && !employmentsReady
  const [evidenceFileId, setEvidenceFileId] = useState('')
  const [evidenceQuery, setEvidenceQuery] = useState('')
  const [evidenceFiles, setEvidenceFiles] = useState<{ value: string; label: string }[]>([])
  const [evidenceError, setEvidenceError] = useState<string | null>(null)
  const [evidenceLoading, setEvidenceLoading] = useState(false)
  const [status, setStatus] = useState<string | undefined>(undefined)
  // Loading is a fact about the state, not a second copy of it: the
  // drawer is loading while an id is open, its row has not arrived, and
  // nothing has failed.
  const loading = qualificationId !== null && loaded?.id !== qualificationId && status === undefined
  const [form, setForm] = useState({ employmentId: '', typeId: '', issuedOn: '', expiresOn: '', identifier: '', notes: '' })
  const selectedType = types.find((type) => type.id === form.typeId)

  useEffect(() => {
    if (!selectedType?.requiresEvidence || evidenceQuery.trim().length < 2) return
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const query = evidenceQuery.trim()
        const res = await fetch(`/api/file-cabinet/files?q=${encodeURIComponent(query)}&perPage=20`)
        if (!res.ok) {
          if (!cancelled) setEvidenceError(t('qualifications.recordForm.evidenceSearchFailed'))
          return
        }
        const payload = (await res.json().catch(() => ({}))) as { files?: unknown }
        if (!Array.isArray(payload.files)) {
          if (!cancelled) setEvidenceError(t('qualifications.recordForm.evidenceSearchFailed'))
          return
        }
        if (!cancelled) {
          setEvidenceFiles(payload.files.flatMap((file) => {
            if (!file || typeof file !== 'object') return []
            const row = file as { id?: unknown; name?: unknown }
            return typeof row.id === 'string'
              ? [{ value: row.id, label: typeof row.name === 'string' ? row.name : row.id }]
              : []
          }))
        }
      } catch {
        if (!cancelled) setEvidenceError(t('qualifications.recordForm.evidenceSearchFailed'))
      } finally {
        if (!cancelled) setEvidenceLoading(false)
      }
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [evidenceQuery, selectedType?.requiresEvidence, t])

  // A half-typed record form is unsaved work: drawer-level dismiss asks
  // before abandoning it. Detail mode edits nothing in place (verify,
  // renew, revoke act immediately), so only the record form guards — its
  // fields plus a picked-but-unsaved evidence file.
  const recordClose = useDirtyClose({
    dirty: recordOpen && (Object.values(form).some((value) => value.trim().length > 0) || evidenceFileId !== ''),
    onClose,
    message: tCommon('feedback.unsavedChanges'),
    confirmLabel: tCommon('confirm.discardChanges'),
  })

  const loadTypes = useCallback(async (): Promise<void> => {
    const requestId = ++typeRequestId.current
    setTypesError(null)
    try {
      const res = await fetch('/api/hrm/qualification-types')
      if (!res.ok) {
        const message = await readApiErrorMessage(res, t('qualifications.recordForm.typesFailed'))
        if (requestId === typeRequestId.current) setTypesError(message)
        return
      }
      const payload = (await res.json()) as { types?: unknown }
      if (!Array.isArray(payload.types)) {
        if (requestId === typeRequestId.current) setTypesError(t('qualifications.recordForm.typesFailed'))
        return
      }
      if (requestId === typeRequestId.current) setTypes(payload.types as QualificationType[])
    } catch {
      if (requestId === typeRequestId.current) {
        setTypesError(t('qualifications.recordForm.typesFailed'))
      }
    }
  }, [t])

  useEffect(() => {
    let cancelled = false
    const openedId = qualificationId
    if (openedId) {
      ;(async () => {
        try {
          const res = await fetch(`/api/hrm/qualifications/${openedId}`)
          if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed to load the qualification'))
          const j = (await res.json()) as Detail
          if (!cancelled) {
            setLoaded({ id: openedId, detail: j })
            setStatus(undefined)
          }
        } catch (e) {
          if (!cancelled) setStatus((e as Error).message)
        }
      })()
    }
    void Promise.resolve().then(loadTypes)
    return () => {
      cancelled = true
      typeRequestId.current += 1
    }
  }, [qualificationId, loadTypes])

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
        if (qualificationId) setLoaded({ id: qualificationId, detail: (await reread.json()) as Detail })
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
    const issuedOn = window.prompt(t('qualifications.renewPrompt'), today)
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
      if (nextId) {
        // Renewal writes a new row, so the drawer navigates to the
        // new id (the `qualification` entry-point param, other params
        // preserved) instead of showing the new row under the old id. The
        // dialog remounts on the new key and loads the row fresh.
        const next = new URLSearchParams(searchParams.toString())
        next.set('qualification', nextId)
        router.push(`${pathname}?${next.toString()}` as never)
        router.refresh()
      } else {
        router.refresh()
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
      evidenceFileId: evidenceFileId || undefined,
    }, t('qualifications.recordForm.recordFailed'))
  }

  // The employment picker loads with the record form, not with the drawer:
  // detail never needs it. The query forwards server-side (remote) so any
  // worker stays selectable beyond the page.
  useEffect(() => {
    if (!recordOpen) return
    const id = (employmentRequestId.current += 1)
    const selectedId = form.employmentId
    const params = new URLSearchParams({ source: 'employments', limit: '25' })
    if (employmentQuery.trim()) params.set('q', employmentQuery.trim())
    if (selectedId) params.set('include', selectedId)
    fetch(`/api/hrm/options?${params.toString()}`, { method: 'GET' })
      .then(async (res) => {
        if (id !== employmentRequestId.current) return
        // res.ok first, always: the refusal names the missing grant.
        if (!res.ok) throw new Error(await readApiErrorMessage(res, t('qualifications.recordForm.employmentsFailed')))
        const payload = (await res.json().catch(() => ({}))) as {
          options?: { employmentId?: unknown; label?: unknown }[]
        }
        if (id !== employmentRequestId.current) return
        const page = Array.isArray(payload.options) ? payload.options : []
        const next = page.flatMap((row) =>
          typeof row.employmentId === 'string' && typeof row.label === 'string'
            ? [{ value: row.employmentId, label: row.label }]
            : [],
        )
        if (selectedId && !next.some((option) => option.value === selectedId)) {
          next.push({ value: selectedId, label: selectedId })
        }
        setEmployments(next)
        setEmploymentsError(null)
        setEmploymentsReady(true)
      })
      .catch((e) => {
        if (id !== employmentRequestId.current) return
        setEmploymentsError(e instanceof Error ? e.message : t('qualifications.recordForm.employmentsFailed'))
        setEmploymentsReady(true)
      })
    return () => {
      employmentRequestId.current += 1
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordOpen, employmentQuery, form.employmentId, employmentRetry])

  const q = detail?.qualification
  const isPending = q?.storedStatus === 'pending_verification'
  const isRevoked = q?.storedStatus === 'revoked'

  return (
    <Drawer open onClose={() => void recordClose.close()} size="md" title={q ? t('qualifications.drawerTitle') : t('qualifications.recordTitle')}>
      {loading ? <p className="text-sm text-slate-500">{tCommon('feedback.loading')}</p> : null}
      {status ? <p className="mb-3 text-sm text-red-700 dark:text-red-300">{status}</p> : null}
      {q ? (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-slate-500">{t('qualifications.columns.type')}</dt>
            <dd className="font-medium">{q.type.code} · {q.type.name}</dd>
            <dt className="text-slate-500">{t('qualifications.columns.status')}</dt>
            <dd className="font-medium">
              {t.has(`qualifications.statusNames.${q.status}`)
                ? t(`qualifications.statusNames.${q.status}`)
                : q.status}
            </dd>
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
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              {isPending ? <Button onClick={verify}>{t('qualifications.verify')}</Button> : null}
              {!isRevoked ? <Button variant="outline" onClick={renew}>{t('qualifications.renew')}</Button> : null}
              {!isRevoked ? <Button variant="outline" onClick={revoke}>{t('qualifications.revoke')}</Button> : null}
            </div>
          ) : null}
          <section aria-label={t('qualifications.drawer.events')}>
            <h3 className="mb-1 text-sm font-semibold">{t('qualifications.drawer.events')}</h3>
            <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
              {(detail?.events ?? []).map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
                  <span className="font-medium">
                    {t.has(`qualifications.drawer.eventKinds.${e.kind}`)
                      ? t(`qualifications.drawer.eventKinds.${e.kind}`)
                      : e.kind}
                  </span>
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
            <SearchSelect
              id="q-employment"
              value={form.employmentId}
              onChange={(next) => setForm({ ...form, employmentId: next })}
              options={employments}
              ariaLabel={t('qualifications.recordForm.employment')}
              sheetTitle={t('qualifications.recordForm.employment')}
              emptyLabel={t('qualifications.recordForm.employmentPlaceholder')}
              placeholder={t('qualifications.recordForm.employmentPlaceholder')}
              remote
              loading={employmentsLoading}
              onSearchChange={(next) => {
                setEmploymentQuery(next)
                setEmploymentsReady(false)
              }}
            />
            {employmentsError ? (
              <p role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">
                {employmentsError}{' '}
                <Button variant="ghost" size="sm" onClick={() => {
                  setEmploymentsReady(false)
                  setEmploymentRetry((n) => n + 1)
                }}>
                  {tCommon('actions.retry')}
                </Button>
              </p>
            ) : null}
          </div>
          <div>
            <Label htmlFor="q-type">{t('qualifications.recordForm.type')}</Label>
            <Select id="q-type" value={form.typeId} onChange={(e) => {
              setForm({ ...form, typeId: e.target.value })
              setEvidenceFileId('')
              setEvidenceQuery('')
              setEvidenceFiles([])
              setEvidenceError(null)
              setEvidenceLoading(false)
            }}>
              <option value="">{tCommon('actions.select')}</option>
              {types.map((type) => (
                <option key={type.id} value={type.id}>{type.code} · {type.name}</option>
              ))}
            </Select>
            {typesError ? (
              <p role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">
                {typesError}{' '}
                <Button variant="ghost" size="sm" onClick={() => void loadTypes()}>
                  {tCommon('actions.retry')}
                </Button>
              </p>
            ) : null}
          </div>
          {selectedType?.requiresEvidence ? (
            <div>
              <Label htmlFor="q-evidence">{t('qualifications.recordForm.evidence')}</Label>
              <p className="mb-1 text-sm text-amber-700 dark:text-amber-300">{t('qualifications.recordForm.evidenceRequired')}</p>
              <SearchSelect
                id="q-evidence"
                ariaLabel={t('qualifications.recordForm.evidence')}
                value={evidenceFileId}
                onChange={setEvidenceFileId}
                options={evidenceFiles}
                placeholder={t('qualifications.recordForm.evidencePlaceholder')}
                searchPlaceholder={t('qualifications.recordForm.evidenceSearchPlaceholder')}
                emptyLabel={t('qualifications.recordForm.evidenceSearchHint')}
                statusMessage={evidenceError ?? (evidenceQuery.trim().length < 2 ? t('qualifications.recordForm.evidenceSearchHint') : undefined)}
                statusTone={evidenceError ? 'error' : 'muted'}
                loading={evidenceLoading}
                remote
                searchable
                onSearchChange={(query) => {
                  setEvidenceQuery(query)
                  setEvidenceFiles([])
                  setEvidenceError(null)
                  setEvidenceLoading(Boolean(selectedType?.requiresEvidence && query.trim().length >= 2))
                }}
              />
            </div>
          ) : null}
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
            <Button onClick={record} disabled={!form.employmentId || !form.typeId || !form.issuedOn || Boolean(selectedType?.requiresEvidence && !evidenceFileId)}>
              {t('qualifications.record')}
            </Button>
          </div>
        </div>
      ) : null}
    </Drawer>
  )
}
