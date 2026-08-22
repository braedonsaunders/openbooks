'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  TabContent,
  Textarea,
  UrlDrawer,
} from '@openbooks/ui'
import type { RequirementPolicy } from '@openbooks/engine/src/compliance.ts'
import { useBusinessToday } from '../../../../components/business-date-provider'
import { AttachmentPanel } from '../../../../components/attachment-panel'
import { promptDialog } from '../../../../lib/prompt'
import type {
  CertificateRow,
  ComplianceClassRow,
  ExceptionRow,
  MatrixRow,
} from '../../../../lib/compliance'

export interface VendorDrawerData {
  vendor: {
    id: string
    name: string
    legalName: string | null
    complianceClassId: string | null
    informationReturnForm: string | null
    informationReturnBox: string | null
    taxClassification: string | null
    tinLast4: string | null
    tinType: string | null
    backupWithholding: boolean
    reportable: boolean
  }
  certificates: CertificateRow[]
  exceptions: ExceptionRow[]
  policies: RequirementPolicy[]
  classes: ComplianceClassRow[]
  projects: { id: string; label: string }[]
  status: MatrixRow | null
}

type Tab = 'certificates' | 'identification' | 'exceptions'

const TAX_CLASSIFICATIONS = [
  'individual',
  'sole_proprietor',
  'partnership',
  'c_corp',
  's_corp',
  'llc',
  'trust_estate',
  'government',
  'nonprofit',
  'other',
] as const

const TIN_TYPES = ['ein', 'ssn', 'itin', 'atin', 'sin', 'bn', 'unknown'] as const

/**
 * One subcontractor's compliance file: the certificates on file, the taxpayer
 * identification the 1099 needs, and any standing exception.
 *
 * The three duties are deliberately visible as three different affordances —
 * recording a certificate, verifying it, and waiving a requirement are three
 * permissions, and the drawer only shows what the signed-in user actually holds.
 */
export function VendorComplianceDrawer({
  data,
  closeHref,
  formTypes,
  canManage,
  canVerify,
  canWaive,
  currentUserId,
}: {
  data: VendorDrawerData
  closeHref: string
  formTypes: string[]
  canManage: boolean
  canVerify: boolean
  canWaive: boolean
  currentUserId: string
}) {
  const t = useTranslations('compliance')
  const router = useRouter()
  const today = useBusinessToday()
  const [tab, setTab] = useState<Tab>('certificates')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [newCert, setNewCert] = useState({
    requirementId: '',
    projectId: '',
    issuerName: '',
    policyNumber: '',
    effectiveFrom: today,
    expiresOn: '',
    coverageAmount: '',
    aggregateAmount: '',
    coverageCurrency: '',
    additionalInsured: false,
    waiverOfSubrogation: false,
    primaryNoncontributory: false,
    notes: '',
    supersedesId: '',
  })
  const [identity, setIdentity] = useState({
    complianceClassId: data.vendor.complianceClassId ?? '',
    reportable: data.vendor.reportable,
    informationReturnForm: data.vendor.informationReturnForm ?? '',
    informationReturnBox: data.vendor.informationReturnBox ?? '',
    taxClassification: data.vendor.taxClassification ?? '',
    tinType: data.vendor.tinType ?? '',
    tin: '',
    backupWithholding: data.vendor.backupWithholding,
  })
  const [exception, setException] = useState({
    requirementId: '',
    projectId: '',
    reason: '',
    expiresOn: '',
  })

  async function call(url: string, method: string, body: unknown): Promise<boolean> {
    setError(null)
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { error?: string }
      setError(payload.error ?? t('errors.saveFailed'))
      return false
    }
    startTransition(() => router.refresh())
    return true
  }

  const applicable = data.policies.filter(
    (policy) => policy.classId === null || policy.classId === identity.complianceClassId,
  )
  const selectedPolicy = applicable.find((policy) => policy.id === newCert.requirementId)

  async function recordCertificate() {
    if (!newCert.requirementId) {
      setError(t('errors.pickRequirement'))
      return
    }
    const ok = await call('/api/compliance/records', 'POST', {
      partyId: data.vendor.id,
      requirementId: newCert.requirementId,
      projectId: newCert.projectId || null,
      issuerName: newCert.issuerName || null,
      policyNumber: newCert.policyNumber || null,
      effectiveFrom: newCert.effectiveFrom,
      expiresOn: newCert.expiresOn || null,
      coverageAmount: newCert.coverageAmount || null,
      aggregateAmount: newCert.aggregateAmount || null,
      coverageCurrency: newCert.coverageCurrency || null,
      additionalInsured: newCert.additionalInsured,
      waiverOfSubrogation: newCert.waiverOfSubrogation,
      primaryNoncontributory: newCert.primaryNoncontributory,
      notes: newCert.notes || null,
      supersedesId: newCert.supersedesId || null,
    })
    if (ok) setNewCert({ ...newCert, requirementId: '', policyNumber: '', expiresOn: '', notes: '', supersedesId: '' })
  }

  async function verify(id: string) {
    await call(`/api/compliance/records/${id}`, 'PATCH', { action: 'verify' })
  }

  async function reject(id: string) {
    const reason = await promptDialog({ title: t('certificates.rejectTitle'), label: t('certificates.rejectReason') })
    if (!reason) return
    await call(`/api/compliance/records/${id}`, 'PATCH', { action: 'reject', reason })
  }

  async function grantException() {
    if (!exception.requirementId || !exception.expiresOn) {
      setError(t('errors.exceptionIncomplete'))
      return
    }
    const ok = await call('/api/compliance/waivers', 'POST', {
      partyId: data.vendor.id,
      requirementId: exception.requirementId,
      projectId: exception.projectId || null,
      reason: exception.reason,
      expiresOn: exception.expiresOn,
    })
    if (ok) setException({ requirementId: '', projectId: '', reason: '', expiresOn: '' })
  }

  async function revokeException(id: string) {
    const reason = await promptDialog({ title: t('exceptions.revokeTitle'), label: t('exceptions.revokeReason') })
    if (!reason) return
    await call(`/api/compliance/waivers/${id}`, 'DELETE', { reason })
  }

  async function saveIdentity() {
    await call(`/api/compliance/vendors/${data.vendor.id}`, 'PATCH', {
      complianceClassId: identity.complianceClassId || null,
      reportable: identity.reportable,
      informationReturnForm: identity.informationReturnForm || null,
      informationReturnBox: identity.informationReturnBox || null,
      taxClassification: identity.taxClassification || null,
      tinType: identity.tinType || null,
      // Only send the TIN when it was actually typed — an empty field means
      // "leave the sealed value alone", never "erase it".
      ...(identity.tin ? { tin: identity.tin } : {}),
      backupWithholding: identity.backupWithholding,
    })
    setIdentity({ ...identity, tin: '' })
  }

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'certificates', label: t('drawer.tabs.certificates'), count: data.certificates.length },
    { key: 'identification', label: t('drawer.tabs.identification') },
    { key: 'exceptions', label: t('drawer.tabs.exceptions'), count: data.exceptions.length },
  ]

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="2xl"
      title={data.vendor.name}
      description={data.vendor.legalName ?? undefined}
      headerActions={
        data.status ? (
          <Badge variant={data.status.blocksPayment ? 'destructive' : data.status.overall === 'compliant' ? 'success' : 'warning'}>
            {t(`states.${data.status.overall}`)}
          </Badge>
        ) : undefined
      }
    >
      {error ? (
        <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      ) : null}

      <nav className="mb-4 flex gap-1 border-b border-slate-200 dark:border-slate-800" aria-label={t('drawer.tabs.aria')}>
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            onClick={() => setTab(item.key)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === item.key
                ? 'border-teal-500 font-medium text-teal-700 dark:text-teal-300'
                : 'border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'
            }`}
          >
            {item.label}
            {item.count != null ? <span className="text-xs tabular-nums text-slate-400">{item.count}</span> : null}
          </button>
        ))}
      </nav>

      <TabContent tabKey={tab}>
        {tab === 'certificates' ? (
          <div className="space-y-5">
            {data.certificates.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">{t('certificates.empty')}</p>
            ) : (
              <ul className="space-y-3">
                {data.certificates.map((cert) => (
                  <li
                    key={cert.id}
                    className="rounded-lg border border-slate-200 p-3 dark:border-slate-800"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
                          {cert.requirementCode} · {cert.requirementName}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                          {[
                            cert.issuerName,
                            cert.policyNumber,
                            cert.projectName,
                            `${cert.effectiveFrom} → ${cert.expiresOn ?? t('certificates.noExpiry')}`,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                        {cert.coverageAmount ? (
                          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                            {t('certificates.limits', {
                              occurrence: `${cert.coverageCurrency ?? ''} ${cert.coverageAmount}`.trim(),
                              aggregate: cert.aggregateAmount ?? '—',
                            })}
                            {cert.additionalInsured ? ` · ${t('certificates.additionalInsured')}` : ''}
                            {cert.waiverOfSubrogation ? ` · ${t('certificates.waiverOfSubrogation')}` : ''}
                            {cert.primaryNoncontributory ? ` · ${t('certificates.primaryNoncontributory')}` : ''}
                          </p>
                        ) : null}
                        {cert.rejectedReason ? (
                          <p className="mt-1 text-xs text-red-600 dark:text-red-400">{cert.rejectedReason}</p>
                        ) : null}
                        {cert.verifiedAt ? (
                          <p className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">
                            {t('certificates.verifiedBy', {
                              who: cert.verifiedByName ?? '—',
                              when: cert.verifiedAt.slice(0, 10),
                            })}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge
                          variant={
                            cert.status === 'active' ? 'success' : cert.status === 'rejected' ? 'destructive' : 'warning'
                          }
                        >
                          {t(`certificateStatus.${cert.status}`)}
                        </Badge>
                        {canVerify && cert.status === 'pending_review' ? (
                          <>
                            <Button
                              size="sm"
                              // Separation of duties: the person who recorded the
                              // certificate cannot be the one who attests to it.
                              // Also refused server-side — this only avoids a
                              // button that is guaranteed to fail.
                              disabled={pending || cert.createdById === currentUserId}
                              title={cert.createdById === currentUserId ? t('certificates.selfVerifyBlocked') : undefined}
                              onClick={() => verify(cert.id)}
                            >
                              {t('certificates.verify')}
                            </Button>
                            <Button size="sm" variant="ghost" disabled={pending} onClick={() => reject(cert.id)}>
                              {t('certificates.reject')}
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
                      <AttachmentPanel targetTable="compliance_records" targetId={cert.id} canEdit={canManage} />
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {canManage ? (
              <section className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                <h4 className="mb-3 text-sm font-semibold text-slate-800 dark:text-slate-100">
                  {t('certificates.recordTitle')}
                </h4>
                {applicable.length === 0 ? (
                  <p className="text-sm text-slate-500 dark:text-slate-400">{t('certificates.noPolicies')}</p>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="sm:col-span-2">
                      <Label>{t('fields.requirement')}</Label>
                      <Select
                        value={newCert.requirementId}
                        onChange={(event) => setNewCert({ ...newCert, requirementId: event.target.value })}
                      >
                        <option value="">{t('fields.select')}</option>
                        {applicable.map((policy) => (
                          <option key={policy.id} value={policy.id}>
                            {policy.code} · {policy.name}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <Label>{t('fields.issuer')}</Label>
                      <Input
                        value={newCert.issuerName}
                        onChange={(event) => setNewCert({ ...newCert, issuerName: event.target.value })}
                      />
                    </div>
                    <div>
                      <Label>{t('fields.policyNumber')}</Label>
                      <Input
                        value={newCert.policyNumber}
                        onChange={(event) => setNewCert({ ...newCert, policyNumber: event.target.value })}
                      />
                    </div>
                    <div>
                      <Label>{t('fields.effectiveFrom')}</Label>
                      <Input
                        type="date"
                        value={newCert.effectiveFrom}
                        onChange={(event) => setNewCert({ ...newCert, effectiveFrom: event.target.value })}
                      />
                    </div>
                    <div>
                      <Label>{t('fields.expiresOn')}</Label>
                      <Input
                        type="date"
                        value={newCert.expiresOn}
                        onChange={(event) => setNewCert({ ...newCert, expiresOn: event.target.value })}
                      />
                      {selectedPolicy?.requiresExpiry ? (
                        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('fields.expiryRequired')}</p>
                      ) : null}
                    </div>
                    {selectedPolicy?.minCoverageAmount ? (
                      <>
                        <div>
                          <Label>{t('fields.coverageAmount')}</Label>
                          <Input
                            inputMode="decimal"
                            className="text-right tabular-nums"
                            placeholder={selectedPolicy.minCoverageAmount}
                            value={newCert.coverageAmount}
                            onChange={(event) => setNewCert({ ...newCert, coverageAmount: event.target.value })}
                          />
                        </div>
                        <div>
                          <Label>{t('fields.aggregateAmount')}</Label>
                          <Input
                            inputMode="decimal"
                            className="text-right tabular-nums"
                            placeholder={selectedPolicy.minAggregateAmount ?? ''}
                            value={newCert.aggregateAmount}
                            onChange={(event) => setNewCert({ ...newCert, aggregateAmount: event.target.value })}
                          />
                        </div>
                        <div>
                          <Label>{t('fields.coverageCurrency')}</Label>
                          <Input
                            maxLength={3}
                            placeholder={selectedPolicy.coverageCurrency ?? ''}
                            value={newCert.coverageCurrency}
                            onChange={(event) =>
                              setNewCert({ ...newCert, coverageCurrency: event.target.value.toUpperCase() })
                            }
                          />
                          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                            {t('fields.coverageCurrencyHint', { currency: selectedPolicy.coverageCurrency ?? '' })}
                          </p>
                        </div>
                      </>
                    ) : null}
                    <div>
                      <Label>{t('fields.project')}</Label>
                      <Select
                        value={newCert.projectId}
                        onChange={(event) => setNewCert({ ...newCert, projectId: event.target.value })}
                      >
                        <option value="">{t('fields.allProjects')}</option>
                        {data.projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                    <div>
                      <Label>{t('fields.supersedes')}</Label>
                      <Select
                        value={newCert.supersedesId}
                        onChange={(event) => setNewCert({ ...newCert, supersedesId: event.target.value })}
                      >
                        <option value="">{t('fields.none')}</option>
                        {data.certificates
                          .filter((cert) => cert.requirementId === newCert.requirementId && cert.status !== 'superseded')
                          .map((cert) => (
                            <option key={cert.id} value={cert.id}>
                              {cert.policyNumber ?? cert.effectiveFrom} → {cert.expiresOn ?? '—'}
                            </option>
                          ))}
                      </Select>
                    </div>
                    <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
                      {(
                        [
                          ['additionalInsured', t('certificates.additionalInsured')],
                          ['waiverOfSubrogation', t('certificates.waiverOfSubrogation')],
                          ['primaryNoncontributory', t('certificates.primaryNoncontributory')],
                        ] as const
                      ).map(([key, label]) => (
                        <label key={key} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={newCert[key]}
                            onChange={(event) => setNewCert({ ...newCert, [key]: event.target.checked })}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                    <div className="sm:col-span-2">
                      <Label>{t('fields.notes')}</Label>
                      <Textarea
                        rows={2}
                        value={newCert.notes}
                        onChange={(event) => setNewCert({ ...newCert, notes: event.target.value })}
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <Button disabled={pending} onClick={recordCertificate}>
                        {t('certificates.record')}
                      </Button>
                      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                        {t('certificates.recordHint')}
                      </p>
                    </div>
                  </div>
                )}
              </section>
            ) : null}
          </div>
        ) : null}

        {tab === 'identification' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>{t('fields.complianceClass')}</Label>
              <Select
                value={identity.complianceClassId}
                disabled={!canManage}
                onChange={(event) => setIdentity({ ...identity, complianceClassId: event.target.value })}
              >
                <option value="">{t('fields.notTracked')}</option>
                {data.classes.map((cls) => (
                  <option key={cls.id} value={cls.id}>
                    {cls.name}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('fields.complianceClassHint')}</p>
            </div>
            <div>
              <Label>{t('fields.taxClassification')}</Label>
              <Select
                value={identity.taxClassification}
                disabled={!canManage}
                onChange={(event) => setIdentity({ ...identity, taxClassification: event.target.value })}
              >
                <option value="">{t('fields.unknown')}</option>
                {TAX_CLASSIFICATIONS.map((value) => (
                  <option key={value} value={value}>
                    {t(`taxClassification.${value}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex items-center gap-2 pt-6">
              <input
                type="checkbox"
                checked={identity.reportable}
                disabled={!canManage}
                onChange={(event) => setIdentity({ ...identity, reportable: event.target.checked })}
              />
              <span className="text-sm">{t('fields.reportable')}</span>
            </div>
            <div>
              <Label>{t('fields.informationReturnForm')}</Label>
              <Select
                value={identity.informationReturnForm}
                disabled={!canManage || !identity.reportable}
                onChange={(event) => setIdentity({ ...identity, informationReturnForm: event.target.value })}
              >
                <option value="">{t('fields.inheritClass')}</option>
                <option value="none">{t('fields.notReportable')}</option>
                {formTypes.map((form) => (
                  <option key={form} value={form}>
                    {form}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>{t('fields.tinType')}</Label>
              <Select
                value={identity.tinType}
                disabled={!canManage}
                onChange={(event) => setIdentity({ ...identity, tinType: event.target.value })}
              >
                <option value="">{t('fields.select')}</option>
                {TIN_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {t(`tinType.${value}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>{t('fields.tin')}</Label>
              <Input
                value={identity.tin}
                disabled={!canManage}
                inputMode="numeric"
                placeholder={data.vendor.tinLast4 ? `•••••${data.vendor.tinLast4}` : t('fields.tinPlaceholder')}
                onChange={(event) => setIdentity({ ...identity, tin: event.target.value })}
              />
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t('fields.tinHint')}</p>
            </div>
            <div className="flex items-center gap-2 pt-6">
              <input
                type="checkbox"
                checked={identity.backupWithholding}
                disabled={!canManage}
                onChange={(event) => setIdentity({ ...identity, backupWithholding: event.target.checked })}
              />
              <span className="text-sm">{t('fields.backupWithholding')}</span>
            </div>
            <div>
              <Label>{t('fields.informationReturnBox')}</Label>
              <Input
                value={identity.informationReturnBox}
                disabled={!canManage}
                placeholder={t('fields.defaultBox')}
                onChange={(event) => setIdentity({ ...identity, informationReturnBox: event.target.value })}
              />
            </div>
            {canManage ? (
              <div className="sm:col-span-2">
                <Button disabled={pending} onClick={saveIdentity}>
                  {t('fields.save')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {tab === 'exceptions' ? (
          <div className="space-y-5">
            <p className="text-sm text-slate-500 dark:text-slate-400">{t('exceptions.intro')}</p>
            {data.exceptions.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">{t('exceptions.empty')}</p>
            ) : (
              <ul className="space-y-2">
                {data.exceptions.map((row) => (
                  <li
                    key={row.id}
                    className="flex items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900/60 dark:bg-amber-950/20"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
                        {row.requirementCode} · {row.requirementName}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">{row.reason}</p>
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        {t('exceptions.window', { from: row.effectiveFrom, to: row.expiresOn })}
                        {row.projectName ? ` · ${row.projectName}` : ''}
                        {row.approvedByName ? ` · ${row.approvedByName}` : ''}
                      </p>
                    </div>
                    {canWaive ? (
                      <Button size="sm" variant="ghost" disabled={pending} onClick={() => revokeException(row.id)}>
                        {t('exceptions.revoke')}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {canWaive ? (
              <section className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                <h4 className="mb-3 text-sm font-semibold text-slate-800 dark:text-slate-100">
                  {t('exceptions.grantTitle')}
                </h4>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <Label>{t('fields.requirement')}</Label>
                    <Select
                      value={exception.requirementId}
                      onChange={(event) => setException({ ...exception, requirementId: event.target.value })}
                    >
                      <option value="">{t('fields.select')}</option>
                      {applicable.map((policy) => (
                        <option key={policy.id} value={policy.id}>
                          {policy.code} · {policy.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label>{t('fields.project')}</Label>
                    <Select
                      value={exception.projectId}
                      onChange={(event) => setException({ ...exception, projectId: event.target.value })}
                    >
                      <option value="">{t('fields.allProjects')}</option>
                      {data.projects.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label>{t('fields.expiresOn')}</Label>
                    <Input
                      type="date"
                      value={exception.expiresOn}
                      onChange={(event) => setException({ ...exception, expiresOn: event.target.value })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Label>{t('fields.reason')}</Label>
                    <Textarea
                      rows={2}
                      value={exception.reason}
                      onChange={(event) => setException({ ...exception, reason: event.target.value })}
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Button disabled={pending} onClick={grantException}>
                      {t('exceptions.grant')}
                    </Button>
                    <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{t('exceptions.grantHint')}</p>
                  </div>
                </div>
              </section>
            ) : null}
          </div>
        ) : null}
      </TabContent>
    </UrlDrawer>
  )
}
