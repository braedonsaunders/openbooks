'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input, Label, Select, Textarea } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'

/**
 * HR-17 continuous-performance client islands. Every action posts to the
 * governed API routes; refusals render as the error. Each island checks
 * res.ok before parsing the body — an error body is never parsed as data.
 */

export function SessionActions({
  sessionId,
  status,
  openLabel,
  closeLabel,
  failed,
}: {
  sessionId: string
  status: string
  openLabel: string
  closeLabel: string
  failed: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function act(action: 'open' | 'close') {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/hrm/calibration-sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, failed))
        setBusy(false)
        return
      }
      router.refresh()
    } catch {
      setError(failed)
      setBusy(false)
    }
  }

  if (status !== 'draft' && status !== 'open') return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === 'draft' ? (
        <Button type="button" disabled={busy} onClick={() => act('open')}>
          {openLabel}
        </Button>
      ) : null}
      {status === 'open' ? (
        <Button type="button" disabled={busy} onClick={() => act('close')}>
          {closeLabel}
        </Button>
      ) : null}
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  )
}

export function SessionCreateForm({
  cycles,
  nameLabel,
  cycleLabel,
  submitLabel,
  cancelLabel,
  closeHref,
  failed,
}: {
  cycles: { value: string; label: string }[]
  nameLabel: string
  cycleLabel: string
  submitLabel: string
  cancelLabel: string
  closeHref: string
  failed: string
}) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [cycleId, setCycleId] = useState(cycles[0]?.value ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/hrm/calibration-sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cycleId, name }),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, failed))
        setBusy(false)
        return
      }
      const j = await res.json()
      router.push(`/hrm/performance?tab=calibration&session=${j.session.id}`)
      router.refresh()
    } catch {
      setError(failed)
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="cal-session-name">{nameLabel}</Label>
        <Input id="cal-session-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="cal-session-cycle">{cycleLabel}</Label>
        <Select id="cal-session-cycle" value={cycleId} onChange={(e) => setCycleId(e.target.value)}>
          {cycles.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      </div>
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="button" disabled={busy || !name.trim() || !cycleId} onClick={submit}>
          {submitLabel}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.push(closeHref)}>
          {cancelLabel}
        </Button>
      </div>
    </div>
  )
}

/** One calibration grid row: proposed beside the inline calibrated rating, potential, and justification editors. */
export function CalibrationEntryEditor({
  entryId,
  calibratedRating,
  potentialKey,
  potentialOptions,
  justification,
  ratingLabel,
  potentialLabel,
  justificationLabel,
  saveLabel,
  revertLabel,
  revertReasonLabel,
  failed,
}: {
  entryId: string
  calibratedRating: string | null
  potentialKey: string | null
  potentialOptions: string[]
  justification: string | null
  ratingLabel: string
  potentialLabel: string
  justificationLabel: string
  saveLabel: string
  revertLabel: string
  revertReasonLabel: string
  failed: string
}) {
  const router = useRouter()
  const [rating, setRating] = useState(calibratedRating ?? '')
  const [potential, setPotential] = useState(potentialKey ?? '')
  const [note, setNote] = useState(justification ?? '')
  const [revertReason, setRevertReason] = useState('')
  const [reverting, setReverting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function patch(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/hrm/calibration-entries/${entryId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, failed))
        setBusy(false)
        return
      }
      setReverting(false)
      router.refresh()
    } catch {
      setError(failed)
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor={`cal-rating-${entryId}`}>{ratingLabel}</Label>
          <Input
            id={`cal-rating-${entryId}`}
            value={rating}
            onChange={(e) => setRating(e.target.value)}
            placeholder="3.0"
          />
        </div>
        <div>
          <Label htmlFor={`cal-potential-${entryId}`}>{potentialLabel}</Label>
          <Select id={`cal-potential-${entryId}`} value={potential} onChange={(e) => setPotential(e.target.value)}>
            <option value="">—</option>
            {potentialOptions.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </div>
        <Button
          type="button"
          disabled={busy || !rating.trim() || !note.trim()}
          onClick={() => patch({ action: 'rate', calibratedRating: rating.trim(), justification: note.trim() })}
        >
          {saveLabel}
        </Button>
        {potential.trim() ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => patch({ action: 'potential', potentialKey: potential.trim() })}
          >
            {potentialLabel}
          </Button>
        ) : null}
        {calibratedRating !== null ? (
          <Button type="button" variant="outline" disabled={busy} onClick={() => setReverting((v) => !v)}>
            {revertLabel}
          </Button>
        ) : null}
      </div>
      <div>
        <Label htmlFor={`cal-note-${entryId}`}>{justificationLabel}</Label>
        <Input id={`cal-note-${entryId}`} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {reverting ? (
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor={`cal-revert-${entryId}`}>{revertReasonLabel}</Label>
            <Input id={`cal-revert-${entryId}`} value={revertReason} onChange={(e) => setRevertReason(e.target.value)} />
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !revertReason.trim()}
            onClick={() => patch({ action: 'revert', reason: revertReason.trim() })}
          >
            {revertLabel}
          </Button>
        </div>
      ) : null}
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  )
}

export type AgendaItem = {
  id: string
  kind: string
  kindLabel: string
  authorMine: boolean
  body: string
  visibility: string
  visibilityLabel: string
  status: string
  carriedLabel: string | null
  doneLabel: string
  reopenLabel: string
}

/** The 1:1 agenda drawer body: talking points, action items with done toggles, the private notes area, and hold/skip/cancel. */
export function OneOnOneAgenda({
  oneOnOneId,
  status,
  items,
  canWrite,
  newKinds,
  newKindLabel,
  bodyLabel,
  bodyPlaceholder,
  privateLabel,
  sharedLabel,
  addLabel,
  holdLabel,
  skipLabel,
  skipReasonLabel,
  cancelLabel,
  carryNote,
  failed,
}: {
  oneOnOneId: string
  status: string
  items: AgendaItem[]
  canWrite: boolean
  newKinds: { value: string; label: string }[]
  newKindLabel: string
  bodyLabel: string
  bodyPlaceholder: string
  privateLabel: string
  sharedLabel: string
  addLabel: string
  holdLabel: string
  skipLabel: string
  skipReasonLabel: string
  cancelLabel: string
  carryNote: string | null
  failed: string
}) {
  const router = useRouter()
  const [kind, setKind] = useState(newKinds[0]?.value ?? 'talking_point')
  const [body, setBody] = useState('')
  const [visibility, setVisibility] = useState('shared')
  const [skipReason, setSkipReason] = useState('')
  const [skipping, setSkipping] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function call(url: string, method: string, payload: Record<string, unknown>, done?: () => void) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, failed))
        setBusy(false)
        return
      }
      setBody('')
      setSkipReason('')
      setSkipping(false)
      done?.()
      router.refresh()
    } catch {
      setError(failed)
      setBusy(false)
    }
  }

  const open = items.filter((i) => i.status === 'open')
  const doneItems = items.filter((i) => i.status !== 'open')
  return (
    <div className="space-y-6">
      {carryNote ? <p className="text-xs text-slate-500 dark:text-slate-400">{carryNote}</p> : null}
      <div>
        {open.length === 0 ? null : (
          <ul className="mt-1 space-y-2">
            {open.map((item) => (
              <li key={item.id} className="text-sm text-slate-700 dark:text-slate-200">
                <span className="font-medium">{item.kindLabel}</span> · {item.body}{' '}
                <span className="text-xs text-slate-500">({item.visibilityLabel})</span>
                {canWrite && status === 'scheduled' ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => call(`/api/hrm/one-on-ones/${oneOnOneId}/items`, 'PATCH', { itemId: item.id, done: true })}
                  >
                    {item.doneLabel}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {doneItems.length > 0 ? (
          <ul className="mt-2 space-y-1.5">
            {doneItems.map((item) => (
              <li key={item.id} className="text-sm text-slate-500 dark:text-slate-400">
                <span className="font-medium">{item.kindLabel}</span> · {item.body}{' '}
                {item.status === 'carried' && item.carriedLabel ? (
                  <span className="text-xs">({item.carriedLabel})</span>
                ) : canWrite && status === 'scheduled' ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => call(`/api/hrm/one-on-ones/${oneOnOneId}/items`, 'PATCH', { itemId: item.id, done: false })}
                  >
                    {item.reopenLabel}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {canWrite && status === 'scheduled' ? (
        <div className="space-y-3">
          <div>
            <Label htmlFor={`ooo-kind-${oneOnOneId}`}>{newKindLabel}</Label>
            <Select id={`ooo-kind-${oneOnOneId}`} value={kind} onChange={(e) => setKind(e.target.value)}>
              {newKinds.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor={`ooo-body-${oneOnOneId}`}>{bodyLabel}</Label>
            <Textarea
              id={`ooo-body-${oneOnOneId}`}
              value={body}
              placeholder={bodyPlaceholder}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor={`ooo-vis-${oneOnOneId}`}>{visibility === 'private' ? privateLabel : sharedLabel}</Label>
            <Select id={`ooo-vis-${oneOnOneId}`} value={visibility} onChange={(e) => setVisibility(e.target.value)}>
              <option value="shared">{sharedLabel}</option>
              <option value="private">{privateLabel}</option>
            </Select>
          </div>
          <Button
            type="button"
            disabled={busy || !body.trim()}
            onClick={() => call(`/api/hrm/one-on-ones/${oneOnOneId}/items`, 'POST', { kind, body: body.trim(), visibility })}
          >
            {addLabel}
          </Button>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={busy}
              onClick={() => call(`/api/hrm/one-on-ones/${oneOnOneId}`, 'PATCH', { action: 'hold' })}
            >
              {holdLabel}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setSkipping((v) => !v)}>
              {skipLabel}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => call(`/api/hrm/one-on-ones/${oneOnOneId}`, 'PATCH', { action: 'cancel' })}
            >
              {cancelLabel}
            </Button>
          </div>
          {skipping ? (
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <Label htmlFor={`ooo-skip-${oneOnOneId}`}>{skipReasonLabel}</Label>
                <Input id={`ooo-skip-${oneOnOneId}`} value={skipReason} onChange={(e) => setSkipReason(e.target.value)} />
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={busy || !skipReason.trim()}
                onClick={() => call(`/api/hrm/one-on-ones/${oneOnOneId}`, 'PATCH', { action: 'skip', reason: skipReason.trim() })}
              >
                {skipLabel}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  )
}

/** Give praise / request feedback, or fulfil an open request, from Me and Team surfaces. */
export function FeedbackDialog({
  subjectEmploymentId,
  subjectLabel,
  requestId,
  requestedFromPartyId,
  kinds,
  kindLabel,
  visibilities,
  visibilityLabel,
  bodyLabel,
  bodyPlaceholder,
  submitLabel,
  cancelLabel,
  closeHref,
  failed,
  openLabel,
}: {
  subjectEmploymentId: string
  subjectLabel: string
  requestId: string | null
  requestedFromPartyId?: string | null
  kinds: { value: string; label: string }[]
  kindLabel: string
  visibilities: { value: string; label: string }[]
  visibilityLabel: string
  bodyLabel: string
  bodyPlaceholder: string
  submitLabel: string
  cancelLabel: string
  closeHref: string
  failed: string
  openLabel: string
}) {
  const router = useRouter()
  // Asking for feedback needs someone to ask. The drawer binds that
  // person when it opens from their record; opened from anywhere else
  // there is nobody to name and no field to name them in, so the kind is
  // not offered rather than offered and refused on submit.
  const offeredKinds = requestedFromPartyId ? kinds : kinds.filter((k) => k.value !== 'request')
  const [open, setOpen] = useState(requestId !== null)
  const [kind, setKind] = useState(offeredKinds[0]?.value ?? 'praise')
  const [visibility, setVisibility] = useState(visibilities[0]?.value ?? 'manager_and_subject')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const url = requestId ? '/api/hrm/feedback/requests' : '/api/hrm/feedback'
      const payload = requestId
        ? { requestId, visibility, body: body.trim() }
        : {
            subjectEmploymentId,
            kind,
            visibility,
            body: body.trim(),
            ...(kind === 'request'
              ? { requestedFromPartyId }
              : {}),
          }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, failed))
        setBusy(false)
        return
      }
      setOpen(false)
      router.push(closeHref)
      router.refresh()
    } catch {
      setError(failed)
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        {openLabel}
      </Button>
    )
  }
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{subjectLabel}</p>
      {!requestId ? (
        <div>
          <Label htmlFor="fb-kind">{kindLabel}</Label>
          <Select id="fb-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {offeredKinds.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      <div>
        <Label htmlFor="fb-vis">{visibilityLabel}</Label>
        <Select id="fb-vis" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
          {visibilities.map((v) => (
            <option key={v.value} value={v.value}>
              {v.label}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="fb-body">{bodyLabel}</Label>
        <Textarea id="fb-body" value={body} placeholder={bodyPlaceholder} onChange={(e) => setBody(e.target.value)} />
      </div>
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="button" disabled={busy || !body.trim()} onClick={submit}>
          {submitLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setOpen(requestId !== null)
            router.push(closeHref)
          }}
        >
          {cancelLabel}
        </Button>
      </div>
    </div>
  )
}

/** Record a talent review or a succession plan with its first candidate (HR). */
export function TalentDialog({
  employments,
  positions,
  perfOptions,
  potOptions,
  perfLabel,
  potLabel,
  impactLabel,
  riskLabel,
  lossOptions,
  promotionLabel,
  notesLabel,
  submitLabel,
  cancelLabel,
  closeHref,
  failed,
  openLabel,
  modeLabel,
  modeTalentLabel,
  modeSuccessionLabel,
  employeeLabel,
  positionLabel,
}: {
  employments: { value: string; label: string }[]
  positions: { value: string; label: string }[]
  perfOptions: string[]
  potOptions: string[]
  perfLabel: string
  potLabel: string
  impactLabel: string
  riskLabel: string
  lossOptions: { value: string; label: string }[]
  promotionLabel: string
  notesLabel: string
  submitLabel: string
  cancelLabel: string
  closeHref: string
  failed: string
  openLabel: string
  modeLabel: string
  modeTalentLabel: string
  modeSuccessionLabel: string
  employeeLabel: string
  positionLabel: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'talent' | 'succession'>('talent')
  const [employmentId, setEmploymentId] = useState(employments[0]?.value ?? '')
  const [positionId, setPositionId] = useState(positions[0]?.value ?? '')
  const [perf, setPerf] = useState(perfOptions[0] ?? '')
  const [pot, setPot] = useState(potOptions[0] ?? '')
  const [impact, setImpact] = useState('medium')
  const [risk, setRisk] = useState('medium')
  const [promotion, setPromotion] = useState(false)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const url = mode === 'talent' ? '/api/hrm/talent-reviews' : '/api/hrm/succession-plans'
      const payload =
        mode === 'talent'
          ? {
              employmentId,
              performanceKey: perf,
              potentialKey: pot,
              impactOfLoss: impact,
              riskOfLoss: risk,
              promotionReady: promotion,
              notes: notes.trim() || null,
            }
          : { positionId, incumbentEmploymentId: employmentId || null, notes: notes.trim() || null }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, failed))
        setBusy(false)
        return
      }
      setOpen(false)
      router.push(closeHref)
      router.refresh()
    } catch {
      setError(failed)
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)}>
        {openLabel}
      </Button>
    )
  }
  return (
    <div className="space-y-3">
      <div>
        <Label htmlFor="tal-mode">{modeLabel}</Label>
        <Select id="tal-mode" value={mode} onChange={(e) => setMode(e.target.value as 'talent' | 'succession')}>
          <option value="talent">{modeTalentLabel}</option>
          <option value="succession">{modeSuccessionLabel}</option>
        </Select>
      </div>
      {mode === 'talent' ? (
        <div>
          <Label htmlFor="tal-emp">{employeeLabel}</Label>
          <Select id="tal-emp" value={employmentId} onChange={(e) => setEmploymentId(e.target.value)}>
            {employments.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <div>
          <Label htmlFor="tal-pos">{positionLabel}</Label>
          <Select id="tal-pos" value={positionId} onChange={(e) => setPositionId(e.target.value)}>
            {positions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      )}
      {mode === 'talent' ? (
        <>
          <div>
            <Label htmlFor="tal-perf">{perfLabel}</Label>
            <Select id="tal-perf" value={perf} onChange={(e) => setPerf(e.target.value)}>
              {perfOptions.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="tal-pot">{potLabel}</Label>
            <Select id="tal-pot" value={pot} onChange={(e) => setPot(e.target.value)}>
              {potOptions.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="tal-impact">{impactLabel}</Label>
            <Select id="tal-impact" value={impact} onChange={(e) => setImpact(e.target.value)}>
              {lossOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="tal-risk">{riskLabel}</Label>
            <Select id="tal-risk" value={risk} onChange={(e) => setRisk(e.target.value)}>
              {lossOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input type="checkbox" checked={promotion} onChange={(e) => setPromotion(e.target.checked)} />
            {promotionLabel}
          </label>
        </>
      ) : null}
      <div>
        <Label htmlFor="tal-notes">{notesLabel}</Label>
        <Textarea id="tal-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
      <div className="flex gap-2">
        <Button type="button" disabled={busy} onClick={submit}>
          {submitLabel}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setOpen(false)
            router.push(closeHref)
          }}
        >
          {cancelLabel}
        </Button>
      </div>
    </div>
  )
}

/** HR-owned feedback settings: who may praise publicly. */
export function FeedbackSettingsForm({
  current,
  anyoneLabel,
  managersLabel,
  saveLabel,
  failed,
}: {
  current: string
  anyoneLabel: string
  managersLabel: string
  saveLabel: string
  failed: string
}) {
  const router = useRouter()
  const [value, setValue] = useState(current)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/hrm/feedback/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicPraiseBy: value }),
      })
      if (!res.ok) {
        setError(await readApiErrorMessage(res, failed))
        setBusy(false)
        return
      }
      router.refresh()
    } catch {
      setError(failed)
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <Select value={value} onChange={(e) => setValue(e.target.value)} aria-label={saveLabel}>
        <option value="anyone">{anyoneLabel}</option>
        <option value="managers_and_hr">{managersLabel}</option>
      </Select>
      <Button type="button" disabled={busy || value === current} onClick={save}>
        {saveLabel}
      </Button>
      {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  )
}
