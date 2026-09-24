'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { MoneyInput, moneyFieldError } from '../../../../components/money-input'

/**
 * Pack-declared certificate answers — the entry surface for every row-backed
 * withholding form any payroll pack declares (the NL opgaaf and SV facts,
 * the DE ELStAM, the FR PAS option).
 *
 * Everything renders from the declarations served by
 * GET /api/payroll/certificates: no country, form number or field key is
 * named in this file. Field kinds map to inputs (choice → select,
 * count → number, amount → decimal text, flag → checkbox, code → text);
 * saves validate server-side against the same declarations. Column-backed
 * certificates are edited in the payroll profile, never here.
 */

export interface DeclaredCertificateField {
  key: string
  label: string
  kind: 'choice' | 'count' | 'amount' | 'flag' | 'code'
  choices?: readonly { value: string; label: string; help?: string }[]
  decimals?: number
  min?: string
  max?: string
  default?: string
  required?: boolean
  help: string
}

export interface DeclaredRowCertificate {
  key: string
  form: string
  label: string
  scope: { level: string; region?: string; subRegion?: string }
  citation: string
  summary: string
  fields: readonly DeclaredCertificateField[]
}

export interface StoredCertificateRow {
  certificate_key: string
  country: string
  region: string | null
  sub_region: string | null
  answers: Record<string, string>
  effective_from: string | null
  superseded_on: string | null
}

/** The latest row in force per certificate key (current first, then history). */
export function latestCertificateRow(stored: readonly StoredCertificateRow[], key: string): StoredCertificateRow | null {
  const rows = stored
    .filter((row) => row.certificate_key === key)
    .sort((a, b) => (a.effective_from ?? '').localeCompare(b.effective_from ?? ''))
  return rows.find((row) => row.superseded_on === null) ?? rows[rows.length - 1] ?? null
}

function FieldInput(props: {
  field: DeclaredCertificateField
  value: string
  onChange: (value: string) => void
}) {
  const { field, value, onChange } = props
  const id = `cert-${field.key}`
  if (field.kind === 'flag') {
    return (
      <label htmlFor={id} className="flex items-center gap-2 text-sm">
        <input
          id={id}
          type="checkbox"
          checked={value === 'true'}
          onChange={(event) => onChange(event.target.checked ? 'true' : 'false')}
        />
        <span>{field.label}{field.required ? ' *' : ''}</span>
      </label>
    )
  }
  if (field.kind === 'choice') {
    return (
      <label htmlFor={id} className="block text-sm">
        <span className="mb-1 block font-medium">{field.label}{field.required ? ' *' : ''}</span>
        <select
          id={id}
          className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">—</option>
          {(field.choices ?? []).map((choice) => (
            <option key={choice.value} value={choice.value}>{choice.label}</option>
          ))}
        </select>
      </label>
    )
  }
  if (field.kind === 'count') {
    return (
      <label htmlFor={id} className="block text-sm">
        <span className="mb-1 block font-medium">{field.label}{field.required ? ' *' : ''}</span>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={field.min}
          max={field.max}
          className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    )
  }
  if (field.kind === 'amount') {
    return (
      <label htmlFor={id} className="block text-sm">
        <span className="mb-1 block font-medium">{field.label}{field.required ? ' *' : ''}</span>
        <MoneyInput
          id={id}
          ariaLabel={field.label}
          value={value}
          onChange={onChange}
          field={field.label}
          noun="a money amount"
          maxScale={4}
          placeholder={field.default ?? ''}
          className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
        />
      </label>
    )
  }
  return (
    <label htmlFor={id} className="block text-sm">
      <span className="mb-1 block font-medium">{field.label}{field.required ? ' *' : ''}</span>
      <input
        id={id}
        type="text"
        inputMode="text"
        placeholder={field.default ?? ''}
        className="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  )
}

export function CertificateForm(props: {
  partyId: string
  country: string
  certificate: DeclaredRowCertificate
  stored: readonly StoredCertificateRow[]
  onSaved?: () => void
  /** Values only: no inputs, no save. The employee drawer read mode. */
  readOnly?: boolean
}) {
  const { partyId, country, certificate, stored, onSaved, readOnly } = props
  const tc = useTranslations('common')
  const tp = useTranslations('payroll.profiles.certificates')
  // The parent remounts this form (via `key`) whenever the underlying row
  // changes, so the draft below is always seeded from the latest answers and
  // no effect has to sync props into state.
  const row = latestCertificateRow(stored, certificate.key)
  const [answers, setAnswers] = useState<Record<string, string>>(
    Object.fromEntries(certificate.fields.map((field) => [field.key, row?.answers[field.key] ?? ''])),
  )
  const [effectiveFrom, setEffectiveFrom] = useState(row?.effective_from ?? '')
  const [busy, setBusy] = useState(false)

  // Certificate amounts are classified before the save posts: an unreadable
  // value names its cause and remedy under the field, and the save stays
  // disabled until every amount reads. Blank means unanswered, as before.
  const amountRefusal = certificate.fields
    .filter((field) => field.kind === 'amount')
    .map((field) => moneyFieldError(field.label, 'a money amount', answers[field.key] ?? '', 4))
    .find((refusal) => refusal !== null) ?? null

  const save = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/payroll/certificates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          employeePartyId: partyId,
          country,
          certificateKey: certificate.key,
          answers,
          effectiveFrom: effectiveFrom || null,
        }),
      })
      // The status is checked before the body is parsed: a non-JSON error body
      // must surface the failure, never a SyntaxError from res.json().
      if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed to save the certificate'))
      toast.success(tp('saved'))
      onSaved?.()
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Read mode serves the latest filing as values: the pack's own labels with
  // the stored answers, the yes/no words from the shared catalog (this file
  // otherwise carries no translations), and no inputs or save button.
  if (readOnly) {
    const latest = latestCertificateRow(stored, certificate.key)
    const display = (field: DeclaredCertificateField): string => {
      const raw = latest?.answers[field.key] ?? ''
      if (field.kind === 'flag') return raw === 'true' ? tc('labels.yes') : tc('labels.no')
      if (field.kind === 'choice') {
        if (!raw) return '—'
        return field.choices?.find((choice) => choice.value === raw)?.label ?? raw
      }
      return raw === '' ? '—' : raw
    }
    return (
      <section className="rounded border border-slate-200 p-4 dark:border-slate-700">
        <h4 className="text-sm font-semibold">{certificate.label}</h4>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{certificate.form}</p>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{certificate.summary}</p>
        <div className="mt-3 grid gap-3">
          {certificate.fields.map((field) => (
            <div key={field.key}>
              <p className="block text-sm font-medium">{field.label}{field.required ? ' *' : ''}</p>
              <p className="text-sm text-slate-800 dark:text-slate-200">{display(field)}</p>
            </div>
          ))}
          <div>
            <p className="block text-sm font-medium">{tp('effectiveFrom')}</p>
            <p className="text-sm text-slate-800 dark:text-slate-200">{latest?.effective_from ?? '—'}</p>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className="rounded border border-slate-200 p-4 dark:border-slate-700">
      <h4 className="text-sm font-semibold">{certificate.label}</h4>
      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{certificate.form}</p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{certificate.summary}</p>
      <div className="mt-3 grid gap-3">
        {certificate.fields.map((field) => (
          <div key={field.key}>
            <FieldInput
              field={field}
              value={answers[field.key] ?? ''}
              onChange={(value) => setAnswers((prev) => ({ ...prev, [field.key]: value }))}
            />
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{field.help}</p>
          </div>
        ))}
        <label htmlFor={`cert-effective-${certificate.key}`} className="block text-sm">
          <span className="mb-1 block font-medium">{tp('effectiveFrom')}</span>
          <input
            id={`cert-effective-${certificate.key}`}
            type="date"
            className="rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-800"
            value={effectiveFrom}
            onChange={(event) => setEffectiveFrom(event.target.value)}
          />
        </label>
      </div>
      <button
        type="button"
        disabled={busy || amountRefusal !== null}
        onClick={save}
        className="mt-3 rounded bg-teal-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? tp('saving') : tp('save')}
      </button>
    </section>
  )
}

export function PackCertificateForms(props: { partyId: string; country: string; readOnly?: boolean }) {
  const { partyId, country, readOnly } = props
  const [state, setState] = useState<{
    status: 'loading' | 'ready' | 'error'
    certificates: DeclaredRowCertificate[]
    stored: StoredCertificateRow[]
  }>({ status: 'loading', certificates: [], stored: [] })
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    if (!country) return () => {}
    ;(async () => {
      try {
        const res = await fetch(`/api/payroll/certificates?employee=${partyId}`)
        // The status is checked before the body is parsed (see above).
        if (!res.ok) throw new Error(await readApiErrorMessage(res, 'failed to load certificates'))
        const body = (await res.json()) as {
          declarations?: Record<string, { certificates: DeclaredRowCertificate[] }>
          stored?: StoredCertificateRow[]
        }
        if (!cancelled) {
          setState({
            status: 'ready',
            certificates: body.declarations?.[country]?.certificates ?? [],
            stored: body.stored ?? [],
          })
        }
      } catch (error) {
        if (!cancelled) {
          toast.error((error as Error).message)
          setState({ status: 'ready', certificates: [], stored: [] })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [partyId, country, version])

  if (!country) return null
  if (state.status === 'loading') {
    return <p className="py-4 text-center text-sm text-slate-400">Loading certificates…</p>
  }
  if (state.certificates.length === 0) return null
  return (
    <div className="mt-6 grid gap-4">
      <h3 className="text-sm font-semibold">Tax certificates</h3>
      {state.certificates.map((certificate) => {
        const rows = state.stored.filter((row) => row.certificate_key === certificate.key)
        const latest = latestCertificateRow(rows, certificate.key)
        // Remount the draft when the underlying row changes (after a save),
        // so the form always seeds from the latest answers with no syncing
        // effect.
        const rowKey = `${latest?.effective_from ?? ''}:${latest?.superseded_on ?? ''}:${JSON.stringify(latest?.answers ?? {})}`
        return (
          <CertificateForm
            key={`${certificate.key}:${rowKey}`}
            partyId={partyId}
            country={country}
            certificate={certificate}
            stored={rows}
            readOnly={readOnly}
            onSaved={() => setVersion((v) => v + 1)}
          />
        )
      })}
    </div>
  )
}
