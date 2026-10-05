'use client'

import Link from 'next/link'
import { FormSteps, InspectorPanel } from '@/components/builder/builder-kit'

import { SwitchField } from '@/components/switch'
import { RecordTabs } from '@/components/module-home/record-tabs'

import { NetInvestmentButton } from '@/app/(app)/accounting/changes/NetInvestmentButton'

import { LossOfControlButton } from '@/app/(app)/accounting/changes/LossOfControlButton'
import { Fragment, useMemo, useRef, useState, type ReactNode } from 'react'
import { setupNavigationKeys, setupTabParams } from '../../../../../lib/setup/navigation'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Banknote, Building2, CircleMinus, Gift, HandCoins, PiggyBank, Plus, Receipt, Shapes, Trash2, Upload, type LucideIcon } from 'lucide-react'
import { RecordKindCards } from '@/components/record-kind-cards'
import {
  Button,
  Input,
  Label,
  SearchSelect,
  Select,
  TagInput,
  Textarea,
  UrlDrawer,
  cn,
  type SelectOption,
} from '@openbooks/ui'
import { setupFieldOptions, setupFieldVisible, setupOptionLabel, toSnake, type SetupEntity, type SetupField } from '../../../../../lib/setup/registry'
import { setupDomainPayload } from '../../../../../lib/setup/domain-payload'
import { confirmDialog } from '../../../../../lib/confirm'
import { coerceField, SETUP_DECIMAL_SCALE } from '../../../../../lib/setup/coerce'
import { majorToMinor, minorToMajor } from '../../../../../lib/setup/money-fields'
import { moneyRefusal } from '@openbooks/engine/money/decimal-refusal'
import { canonicalDecimal } from '@openbooks/engine/money/decimal'
import { formatDecimal } from '../../../../../lib/money-format'
import { countryOptions } from '../../../../../lib/countries'

type RefOption = { value: string; label: string; scopeValue?: string | null; accountType?: string; minorUnits?: number }

/** Icons a registry `createChooser` card may name. */
const CHOOSER_ICONS: Record<string, LucideIcon> = {
  banknote: Banknote,
  building: Building2,
  'circle-minus': CircleMinus,
  gift: Gift,
  'hand-coins': HandCoins,
  'piggy-bank': PiggyBank,
  receipt: Receipt,
}

/** Bound for one setup save before the drawer surfaces a timeout. */
const SAVE_TIMEOUT_MS = 30_000

export function NewSetupButton({
  entityKey,
  label,
  basePath,
  rowParam = 'row',
}: {
  entityKey: string
  label: string
  /** Host path to open the create drawer under. Defaults to the setup workspace.
   *  When mounted elsewhere (e.g. /inventory), existing query params such as the
   *  active `view` are preserved so the section stays selected. */
  basePath?: string
  /** URL key this section's New/edit drawer reads. Hosts rendering several
   *  setup sections pass a distinct key per section so one URL opens exactly
   *  one drawer; single-section surfaces keep the default `row`. */
  rowParam?: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  function open() {
    if (basePath) {
      const next = new URLSearchParams(searchParams.toString())
      next.set(rowParam, 'new')
      router.push(`${pathname}?${next.toString()}`)
    } else {
      router.push(`/admin/setup/${entityKey}?row=new`)
    }
  }
  return (
    <Button onClick={open}>
      <Plus size={15} /> {label}
    </Button>
  )
}

/** Initial form value for one field, read from the (snake-keyed) row. */
function initialValue(field: SetupField, row: Record<string, unknown> | null): unknown {
  const raw = row ? row[toSnake(field.key)] : undefined
  if (!row && field.defaultValue !== undefined) return field.defaultValue
  switch (field.kind) {
    case 'boolean':
      if (field.nullable) return raw == null ? '' : Boolean(raw)
      // New records default to active/true for the common isActive flag.
      return row ? Boolean(raw) : field.key === 'isActive' || field.key === 'isBillableDefault'
    case 'date':
      return raw ? String(raw).slice(0, 10) : ''
    case 'multiref':
      return [] as string[]
    case 'stringArray':
      return Array.isArray(raw) ? raw.map(String) : ([] as string[])
    case 'object':
      return raw == null ? (row ? null : {}) : raw
    case 'objectArray':
      return raw == null ? (row ? null : []) : raw
    case 'json':
      return raw == null ? '' : JSON.stringify(raw, null, 2)
    default:
      return raw == null ? '' : String(raw)
  }
}

export function SetupDrawer({
  entity,
  row,
  members,
  refOptions,
  closeHref: closeHrefProp,
  initialValues,
  fixedValues,
  nestedTab,
  nestedTabs = [],
  ruleTabs = [],
  detailsLabel,
  ruleDetailsLabel,
  recordTitle,
  stacked = false,
  mutationBasePath = '/api/admin/setup',
  onSaved,
  navigationPrefix,
}: {
  entity: SetupEntity
  row: Record<string, unknown> | null
  members: string[]
  refOptions: Record<string, RefOption[]>
  closeHref?: string
  initialValues?: Record<string, unknown>
  fixedValues?: Record<string, unknown>
  nestedTab?: { key: string; label: string; content: ReactNode }
  nestedTabs?: { key: string; label: string; content: ReactNode }[]
  /** A rehomed record names its native configuration section. */
  detailsLabel?: string
  ruleDetailsLabel?: string
  ruleTabs?: { key: string; label: string; content: ReactNode }[]
  recordTitle?: string
  stacked?: boolean
  /** Refresh the host record after a successful native save. */
  onSaved?: () => void
  /** Scope nested tabs independently from their owning record. */
  navigationPrefix?: string
  /** Host-specific authorized adapter, sharing native setup commands. */
  mutationBasePath?: string
}) {
  const t = useTranslations('admin.setup')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const creating = !row
  const [editing, setEditing] = useState(creating)
  const idColumn = entity.idColumn ?? 'id'
  const closeHref = closeHrefProp ?? `/admin/setup/${entity.key}`

  // Authoritative minor-unit precisions for money fields, from the currency
  // options the server resolved beside the form — never a client guess.
  const minorUnits: Record<string, number> = {}
  for (const option of refOptions.currencies ?? []) {
    if (typeof option.minorUnits === 'number') minorUnits[option.value] = option.minorUnits
  }
  // A stored minor that cannot be read as majors is never shown as
  // majors: showing 12050 where 120.50 belongs would bank a 100x figure the
  // moment the operator saves. Such a field opens blank and locked with the
  // stored figure named as minor units, and only deliberate re-entry in a
  // known currency unlocks it.
  const moneyLabel = (f: SetupField) => t(f.labelKey ?? `fields.${f.key}`)
  const initialMoneyLocks: Record<string, string> = {}
  const initialMoneyMajors: Record<string, string> = {}
  if (row) {
    for (const f of entity.fields) {
      if (f.kind !== 'money') continue
      const raw = initialValue(f, row)
      if (raw === '' || raw == null) continue
      const currency = String(row[toSnake(f.currencyField ?? 'currency')] ?? '').toUpperCase()
      const exponent = minorUnits[currency]
      const major = exponent === undefined ? null : minorToMajor(raw as string | number, exponent)
      if (major == null) {
        initialMoneyLocks[f.key] = t('validation.moneyUnknownPrecision', {
          field: moneyLabel(f),
          raw: String(raw),
          currency: currency || '—',
        })
      } else {
        initialMoneyMajors[f.key] = major
      }
    }
  }
  const [moneyLocked, setMoneyLocked] = useState(initialMoneyLocks)
  const [form, setForm] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {}
    for (const f of entity.fields) {
      if (f.kind === 'multiref') {
        init[f.key] = members
        continue
      }
      // Money fields hold operator majors in the form; storage minors stay
      // on the row. A locked field opens blank (see above), never as minors.
      if (f.kind === 'money') {
        init[f.key] = initialMoneyLocks[f.key] ? '' : (initialMoneyMajors[f.key] ?? initialValue(f, row))
        continue
      }
      init[f.key] = initialValue(f, row)
    }
    return { ...init, ...initialValues, ...fixedValues }
  })
  // The pristine form advances after a successful save; Cancel restores
  // this baseline and the close guard compares unsaved changes against it.
  const [initialForm, setInitialForm] = useState(form)
  const [busy, setBusy] = useState(false)
  const [officialBusy, setOfficialBusy] = useState(false)
  // One idempotency key per mounted create session (POST /api/accounts
  // pattern): assigned once, reused across retries and timeouts so a retried
  // save replays instead of duplicating. Never sent on PATCH.
  const createRequestIdRef = useRef<string | null>(null)
  // A blocked save that only fires a transient toast reads as "nothing
  // happened" once it dismisses: the failure also persists as a
  // form-level alert naming the field, cleared on the next edit.
  const [fieldError, setFieldError] = useState<string | null>(null)

  const entityTitle = entity.singularTitleKey
    ? t(entity.singularTitleKey)
    : t(`entities.${entity.key}.title`)
  const set = (key: string, value: unknown) => {
    setFieldError(null)
    // Deliberate re-entry unlocks a precision-locked money field; anything
    // else keeps its lock until the operator types a fresh amount.
    setMoneyLocked((current) => {
      if (!(key in current)) return current
      const next = { ...current }
      delete next[key]
      return next
    })
    setForm((current) => {
      const next = { ...current, [key]: value }
      for (const field of entity.fields) {
        if (field.refScopeField !== key || !field.ref) continue
        if (!(refOptions[field.ref] ?? []).some((option) => option.value === next[field.key] && (option.scopeValue == null || option.scopeValue === String(value ?? '')))) next[field.key] = ''
      }
      return next
    })
  }
  // A kind chooser opens the create drawer on cards; the form appears once a
  // card pre-fills the values that decide which fields apply.
  const chooser = creating ? entity.createChooser : undefined
  const [choosing, setChoosing] = useState(Boolean(chooser))
  function choose(key: string) {
    const choice = chooser?.options.find((option) => option.key === key)
    if (!choice) return
    setFieldError(null)
    setForm((current) => ({ ...current, ...choice.values }))
    setChoosing(false)
  }
  const tabParam = setupNavigationKeys(navigationPrefix).tab
  const recordTabs = nestedTab ? [nestedTab, ...nestedTabs] : nestedTabs
  const activeNestedTab = !creating ? recordTabs.find((tab) => searchParams.get(tabParam) === tab.key) : undefined
  const nestedTabActive = activeNestedTab !== undefined
  const activeRuleTab = !creating ? ruleTabs.find(tab => searchParams.get(tabParam) === tab.key) : undefined

  function selectTab(key: 'details' | string) {
    const next = setupTabParams(new URLSearchParams(searchParams.toString()), key, navigationPrefix)
    const query = next.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  // Conditional fields are evaluated against the live form, so switching a
  // component from a deduction to an earning drops its protection settings
  // from view (and from the required-field check) as the choice is made.
  const visibleFields = entity.fields.filter((field) => setupFieldVisible(field, form))
  const steps = creating ? entity.creationSteps ?? [] : []
  const [stepIndex, setStepIndex] = useState(0)
  const currentStep = steps[stepIndex]
  const reviewing = steps.length > 0 && stepIndex === steps.length
  const displayedFields = currentStep ? visibleFields.filter((field) => currentStep.fields.includes(field.key)) : visibleFields
  function nextStep() {
    const error = validate(displayedFields)
    if (error) { setFieldError(error); toast.error(error); return }
    setFieldError(null)
    setStepIndex((index) => index + 1)
  }

  function validate(fields = visibleFields): string | null {
    for (const f of fields) {
      if (f.kind === 'object' || f.kind === 'objectArray') {
        const result = coerceField(f, form[f.key])
        if ('error' in result) return result.error
      }
      if (!f.required || (f.kind === 'boolean' && !f.nullable) || f.kind === 'multiref') continue
      if (!creating && f.lockedOnEdit) continue
      // A precision-locked money field opens blank by design; the save loop
      // refuses it with the remedy naming the stored figure, never a bare
      // "required" that hides why a kept value cannot stay.
      if (moneyLocked[f.key]) continue
      const v = form[f.key]
      // keepDefault columns carry a DB default the server applies to blanks
      // An empty ownership acquisitionRate/nciMeasurement is
      // legal input, never a missing requirement.
      if (f.keepDefault && (v === undefined || v === null || String(v).trim() === '')) continue
      if (v === undefined || v === null || String(v).trim() === '') {
        return t('validation.required', { field: t(f.labelKey ?? `fields.${f.key}`) })
      }
    }
    return null
  }

  async function save() {
    if (busy || entity.readOnly || (!creating && entity.allowUpdate === false) || !editing) return
    const err = validate()
    if (err) {
      setFieldError(err)
      toast.error(err)
      return
    }
    setBusy(true)
    // A response that never arrives wedges the drawer open with zero feedback
    // and invites blind duplicate retries: bound the request and
    // surface a timeout as a persistent error. The row may already exist, so
    // the copy points at the table instead of inviting a retry.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SAVE_TIMEOUT_MS)
    try {
      let body: Record<string, unknown> = { ...form, ...fixedValues }
      // Money fields arrive as operator majors and post as storage minors, so
      // the conversion runs before the domain payload: the shared coerce
      // grammar reads whole minor units and would refuse a majors figure.
      // The sibling currency names the precision; anything the shared
      // decimal grammar refuses renders the engine classifier's precise
      // remedy, and nothing rounds or coerces.
      for (const field of entity.fields) {
        if (field.kind !== 'money') continue
        // The precision lock is checked before the empty skip: a locked
        // field opens blank, so an untouched save would otherwise sail past
        // the guard and clear the stored amount instead of refusing.
        const precisionLock = moneyLocked[field.key]
        if (precisionLock) {
          setFieldError(precisionLock); toast.error(precisionLock); setBusy(false); return
        }
        if (typeof body[field.key] !== 'string' || String(body[field.key]).trim() === '') continue
        const currency = String(body[field.currencyField ?? 'currency'] ?? '').toUpperCase()
        const exponent = minorUnits[currency]
        const label = t(field.labelKey ?? `fields.${field.key}`)
        if (exponent === undefined) {
          const error = t('validation.moneyUnknownCurrency', { field: label, currency: currency || '—' })
          setFieldError(error); toast.error(error); setBusy(false); return
        }
        const minorText = majorToMinor(String(body[field.key]), exponent)
        const minor = minorText == null ? NaN : Number(minorText)
        if (minorText == null) {
          const error = moneyRefusal(label, String(body[field.key]), 'an amount', exponent)
          setFieldError(error); toast.error(error); setBusy(false); return
        }
        if (minor < 0 || !Number.isSafeInteger(minor)) {
          const error = t('validation.moneyAmount', { field: label, currency })
          setFieldError(error); toast.error(error); setBusy(false); return
        }
        body[field.key] = minor
      }
      if (entity.mutationPath) {
        const payload = setupDomainPayload(entity, body)
        if (!payload.ok) { setFieldError(payload.error); toast.error(payload.error); return }
        body = { ...payload.body, ...fixedValues }
      }
      // Decimal inputs arrive as raw operator text; canonicalize them through
      // the same exact-decimal grammar the server coerces with, so a
      // band min typed as ".5" posts as "0.5" instead of round-tripping raw.
      // Unparseable text posts untouched for the server to refuse by name.
      for (const field of entity.fields) {
        if (field.clearWhenHidden && !setupFieldVisible(field, body)) body[field.key] = null
        if ((field.kind === 'decimal' || field.kind === 'percent') && typeof body[field.key] === 'string') {
          body[field.key] = canonicalDecimal(body[field.key], field.decimalScale ?? SETUP_DECIMAL_SCALE) ?? body[field.key]
        }
      }
      // A field the form stopped showing must not persist behind the UI: a pay
      // component switched from a deduction to an earning gives its protection
      // settings back to their defaults, exactly as the CHECK constraint expects.
      for (const field of entity.fields) {
        if (field.showWhen && !setupFieldVisible(field, form)) {
          body[field.key] = field.clearWhenHidden ? null : field.defaultValue ?? ''
        }
      }
      if (!creating) body.id = row![idColumn]
      if (!creating && entity.dataSource === 'extension-settings') {
        body.expectedValue = row!.value
        body.expectedExtensionVersionId = row!.extension_version_id
      }
      // Command-owned entities save through their domain command, never the
      // generic endpoint (which refuses them with a remedy naming the command
      // endpoint): the domain owns the write the row endpoint cannot make.
      // Every command is an upsert, so creates and edits both POST the
      // payload — and both mint the stable session key, because the command
      // endpoint fences on it: without a key the save is refused, never
      // silently unguarded.
      const commanded = entity.command
      if ((creating || commanded) && !createRequestIdRef.current) createRequestIdRef.current = crypto.randomUUID()
      const endpoint = entity.mutationPath
        ? creating ? entity.mutationPath : `${entity.mutationPath}/${encodeURIComponent(String(row![idColumn]))}`
        : commanded ? `${mutationBasePath}/${entity.key}/command` : `${mutationBasePath}/${entity.key}`
      const res = await fetch(endpoint, {
        method: commanded ? 'POST' : creating ? 'POST' : 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...((creating || commanded) ? { 'Idempotency-Key': createRequestIdRef.current! } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setFieldError(errorMessage(data))
        toast.error(errorMessage(data))
        return
      }
      let destination = closeHref
      if (creating && entity.createDestination) {
        const saved = await res.json() as { id?: unknown }
        if (typeof saved.id !== 'string' || !saved.id) throw new Error(tCommon('feedback.saveFailed'))
        const target = new URL(closeHref, window.location.origin)
        target.searchParams.set(entity.createDestination.rowParam, saved.id)
        if (entity.createDestination.tabKey) target.searchParams.set('setupTab', entity.createDestination.tabKey)
        destination = `${target.pathname}${target.search}`
      }
      toast.success(creating ? t('created') : t('updated'))
      if (creating) router.push(destination)
      else { setInitialForm(form); setEditing(false); setFieldError(null) }
      onSaved?.()
      router.refresh()
    } catch (e) {
      // A rejected transport previously escaped with zero feedback:
      // drawer open, no toast, button wedged until remount. Name it inline.
      const timedOut = e instanceof DOMException && e.name === 'AbortError'
      const message = timedOut ? t('errors.saveTimedOut') : tCommon('feedback.saveFailed')
      setFieldError(message)
      toast.error(message)
    } finally {
      clearTimeout(timer)
      // A rejected transport must not wedge the button on: without this,
      // every later click silently dies on the stuck disabled button.
      setBusy(false)
    }
  }

  async function remove() {
    if (!row) return
    if (!(await confirmDialog(t('confirmDelete')))) return
    setBusy(true)
    try {
      const res = await fetch(entity.mutationPath
        ? `${entity.mutationPath}/${encodeURIComponent(String(row[idColumn]))}`
        : `${mutationBasePath}/${entity.key}?id=${encodeURIComponent(String(row[idColumn]))}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast.error(errorMessage(data))
        return
      }
      toast.success(t('deleted'))
      router.push(closeHref)
      router.refresh()
    } catch {
      // A rejected transport shares the save path's handling: name the
      // failure and always release busy so the operator can retry.
      toast.error(tCommon('feedback.deleteFailed'))
    } finally {
      setBusy(false)
    }
  }

  function errorMessage(body: unknown): string {
    // Typed server bodies: the code maps stably to
    // localized copy while a user-language message renders verbatim, so an
    // 'invalid' 400 names its fix instead of echoing a code.
    const record = body as { code?: unknown; error?: unknown } | null | undefined
    const code = record?.code
    const message = record?.error
    if (code === 'duplicate') return t('errors.duplicate')
    if (code === 'overlap') return t('errors.overlap')
    if (code === 'in-use') return t('errors.inUse')
    if (code === 'primary-required') return t('errors.primaryRequired')
    if (code === 'primary-active-required') return t('errors.primaryActiveRequired')
    if (code === 'archive-only') return t('errors.archiveOnly')
    if (code === 'invalid-url') return t('errors.invalidUrl')
    if (code === 'invalid-depreciation-formula') return t('errors.invalidDepreciationFormula')
    if (code === 'invalid' && message === 'invalid-recoverable-percent') return t('errors.invalidRecoverablePercent')
    // A server-side required-field refusal still names the registry key
    // Render it through the field label — exactly as
    // client-side validate() does — instead of leaking camelCase into the
    // dialog.
    const missingField = code === 'invalid' && typeof message === 'string'
      ? /^([A-Za-z][A-Za-z0-9]*) is required$/.exec(message)?.[1]
      : undefined
    if (missingField) return t('validation.required', { field: t(entity.fields.find((field) => field.key === missingField)?.labelKey ?? `fields.${missingField}`) })
    if (typeof message === 'string' && message) return message
    if (typeof code === 'string' && code) return code
    return tCommon('feedback.saveFailed')
  }

  // Unsaved setup edits never close silently: every UrlDrawer close path
  // (Escape, backdrop, X) asks first. An in-flight save or official-PDF
  // upload cannot be dismissed, even with a discard confirmation.
  async function confirmDiscard() {
    if (busy || officialBusy) return false
    if (JSON.stringify(form) === JSON.stringify(initialForm)) return true
    return confirmDialog({
      message: tCommon('feedback.unsavedChanges'),
      confirmLabel: tCommon('confirm.discardChanges'),
      tone: 'danger',
    })
  }

  async function cancelEditing() {
    if (!await confirmDiscard()) return
    setForm(initialForm); setFieldError(null); setEditing(false)
  }

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size={entity.drawerSize ?? 'lg'}
      description={choosing && chooser ? t(chooser.descriptionKey) : entity.formDescriptionKey ? t(entity.formDescriptionKey) : undefined}
      beforeClose={confirmDiscard}
      stacked={stacked}
      title={choosing && chooser ? t(chooser.titleKey) : creating ? t('drawer.newTitle', { name: entityTitle }) : editing ? t('drawer.editTitle', { name: entityTitle }) : recordTitle ?? entityTitle}
      subtabs={!creating && (recordTabs.length > 0 || ruleTabs.length > 0) ? (
        <>
          {recordTabs.length > 0 ? (
            <RecordTabs label={t('drawer.tabs.ariaLabel')} tabs={[{ key: 'details', label: detailsLabel ?? t('drawer.tabs.details') }, ...recordTabs]} active={activeNestedTab?.key ?? 'details'} onChange={selectTab} />
          ) : null}
          {!nestedTabActive && ruleTabs.length > 0 ? (
            <RecordTabs label={detailsLabel ?? t('drawer.tabs.ariaLabel')} tabs={[{ key: 'details', label: ruleDetailsLabel ?? t('drawer.tabs.details') }, ...ruleTabs]} active={activeRuleTab?.key ?? 'details'} onChange={selectTab} />
          ) : null}
        </>
      ) : undefined}
      headerActions={<>
        {!creating && entity.recordLinks?.map((action) => <Button asChild key={action.href} variant="outline"><Link href={action.href}>{action.label}</Link></Button>)}
        {!creating && !entity.readOnly && entity.allowUpdate !== false && !editing ? <Button variant="outline" disabled={busy} onClick={() => { setEditing(true); if (nestedTabActive || activeRuleTab) selectTab('details') }}>{tCommon('actions.edit')}</Button> : null}
        {chooser && !choosing ? <Button variant="outline" disabled={busy} onClick={() => setChoosing(true)}>{tCommon('actions.back')}</Button> : null}
        {!choosing && !nestedTabActive && !entity.readOnly && (creating || entity.allowUpdate !== false) && editing && (!steps.length || reviewing) ? <Button disabled={busy} onClick={save}>
          {busy ? tCommon('actions.saving') : creating ? tCommon('actions.create') : tCommon('actions.save')}
        </Button> : null}
        {!creating && editing ? <Button variant="outline" disabled={busy} onClick={() => void cancelEditing()}>{tCommon('actions.cancel')}</Button> : null}
      </>}
      footer={
        steps.length ? <div className="flex w-full justify-between gap-2">
          <Button variant="outline" disabled={busy || stepIndex === 0} onClick={() => { setFieldError(null); setStepIndex((index) => index - 1) }}>{tCommon('actions.back')}</Button>
          {!reviewing ? <Button disabled={busy} onClick={nextStep}>{tCommon('actions.next')}</Button> : null}
        </div> : nestedTabActive ? undefined : !entity.readOnly && !creating && !entity.hasActive && entity.allowDelete !== false ? (
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="flex items-center gap-1.5 text-sm text-red-600 hover:text-red-700 disabled:opacity-50 dark:text-red-400"
          >
            <Trash2 size={14} /> {tCommon('actions.delete')}
          </button>
        ) : (
          <span />
        )
      }
    >
      {choosing && chooser ? (
        <RecordKindCards
          options={chooser.options.map((option) => {
            const Icon = CHOOSER_ICONS[option.iconKey] ?? Shapes
            return { value: option.key, label: t(option.labelKey), description: t(option.descriptionKey), icon: <Icon size={22} /> }
          })}
          onChoose={choose}
        />
      ) : nestedTabActive ? activeNestedTab?.content : <>
      {activeRuleTab ? activeRuleTab.content : <>
      {entity.key === "subsidiary-ownership-interests" && row && row.method === "full" ? <div className="mb-4"><LossOfControlButton interestId={String(row.id)} /><NetInvestmentButton interestId={String(row.id)} /></div> : null}
      {fieldError ? (
        <p role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {fieldError}
        </p>
      ) : null}
      {steps.length ? <div className="mb-5 space-y-3">
        <FormSteps steps={[...steps.map((step) => ({ key: step.key, label: t(step.titleKey) })), { key: 'review', label: t('benefitBuilder.review') }]} current={stepIndex} onChange={setStepIndex} label={entityTitle} />
        {currentStep ? <div><h2 className="text-base font-semibold">{t(currentStep.titleKey)}</h2><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t(currentStep.descriptionKey)}</p></div> : null}
      </div> : null}
      <div className={entity.formSections ? "space-y-5" : undefined}>
      {entity.formSections?.map((section) => {
        const fields = displayedFields.filter((field) => section.fields.includes(field.key))
        if (!fields.length) return null
        return <InspectorPanel key={section.titleKey} title={t(section.titleKey)} description={section.descriptionKey ? t(section.descriptionKey) : undefined}>
          <div className="grid gap-5 sm:grid-cols-2">
            {fields.map((field) => <FieldControl key={field.key} field={field} value={form[field.key]} onChange={(value) => set(field.key, value)} creating={creating} forceLocked={!editing || Boolean(entity.readOnly) || Object.hasOwn(fixedValues ?? {}, field.key)} refOptions={field.ref ? (refOptions[field.ref] ?? []) : []} formValues={form} t={t} moneyLocked={moneyLocked[field.key]} />)}
          </div>
        </InspectorPanel>
      })}
      <div className="grid gap-4 p-1 sm:grid-cols-2">
        {displayedFields.filter((field) => !entity.formSections?.some((section) => section.fields.includes(field.key))).map((field, index) => (
          <Fragment key={field.key}>
            {field.sectionKey && field.sectionKey !== displayedFields[index - 1]?.sectionKey ? (
              <h3 className="border-t border-slate-200 pt-4 text-sm font-semibold text-slate-800 sm:col-span-2 dark:border-slate-800 dark:text-slate-100">
                {t(field.sectionKey)}
              </h3>
            ) : null}
            <FieldControl
              field={field}
              value={form[field.key]}
              onChange={(v) => set(field.key, v)}
              creating={creating}
              forceLocked={reviewing || !editing || Boolean(entity.readOnly) || Object.hasOwn(fixedValues ?? {}, field.key)}
              refOptions={field.ref ? (refOptions[field.ref] ?? []) : []}
              formValues={form}
              t={t}
              moneyLocked={moneyLocked[field.key]}
            />
          </Fragment>
        ))}
        {!creating && entity.key === 'tax-return-forms' ? (
          <div className="space-y-2 border-t border-slate-200 pt-4 sm:col-span-2 dark:border-slate-800">
            <Label help={t('taxOfficial.description')}>{t('taxOfficial.title')}</Label>
            <div className="flex flex-wrap items-center gap-2">
              <label className="cursor-pointer">
                <input
                  type="file"
                  accept="application/pdf,.pdf"
                  className="hidden"
                  disabled={officialBusy}
                  onChange={async (event) => {
                    const file = event.target.files?.[0]
                    event.target.value = ''
                    if (!file) return
                    setOfficialBusy(true)
                    try {
                      const body = new FormData()
                      body.set('file', file)
                      const response = await fetch(`/api/tax/returns/${encodeURIComponent(String(row?.code))}/official-pdf`, { method: 'POST', body })
                      if (!response.ok) throw new Error()
                      toast.success(t('taxOfficial.uploaded'))
                      router.refresh()
                    } catch {
                      toast.error(tCommon('feedback.saveFailed'))
                    } finally {
                      setOfficialBusy(false)
                    }
                  }}
                />
                <span className="inline-flex h-9 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900">
                  <Upload size={14} />
                  {officialBusy ? t('taxOfficial.uploading') : t('taxOfficial.upload')}
                </span>
              </label>
              {row?.official_pdf_file_id ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={officialBusy}
                  onClick={async () => {
                    setOfficialBusy(true)
                    try {
                      const response = await fetch(`/api/tax/returns/${encodeURIComponent(String(row.code))}/official-pdf`, { method: 'DELETE' })
                      if (!response.ok) throw new Error()
                      toast.success(t('taxOfficial.removed'))
                      router.refresh()
                    } catch {
                      toast.error(tCommon('feedback.saveFailed'))
                    } finally {
                      setOfficialBusy(false)
                    }
                  }}
                >
                  {t('taxOfficial.remove')}
                </Button>
              ) : (
                <span className="text-xs text-slate-500 dark:text-slate-400">{t('taxOfficial.none')}</span>
              )}
            </div>
          </div>
        ) : null}
      </div>
      </div></>}
      </>}
    </UrlDrawer>
  )
}

export function FieldControl({
  field,
  value,
  onChange,
  creating,
  forceLocked,
  refOptions,
  formValues,
  t,
  moneyLocked,
}: {
  field: SetupField
  value: unknown
  onChange: (v: unknown) => void
  creating: boolean
  forceLocked: boolean
  refOptions: RefOption[]
  /** Live drawer values, so a scoped select follows its scope field. */
  formValues: Record<string, unknown>
  t: ReturnType<typeof useTranslations>
  /** Precision-lock remedy for a money field; the input opens blank until deliberate re-entry. */
  moneyLocked?: string | null
}) {
  const locale = useLocale()
  const common = useTranslations('common')
  const countries = useMemo(() => countryOptions(locale), [locale])
  const label = t(field.labelKey ?? `fields.${field.key}`)
  // Authored help renders as the `?` popover on the field label (FieldLabel);
  // without it the label falls back to its generic explanation. Inline text
  // below a control is reserved for validation/state messages only.
  const help = field.helpTextKey ? t(field.helpTextKey) : undefined
  const locked = forceLocked || (!creating && field.lockedOnEdit)
  // Registry-required fields show a marker — exactly the set
  // validate() enforces (checkboxes/multirefs/locked keys are never required,
  // and blank keepDefault fields are legal input), so the mark
  // cannot lie about what blocks saving.
  const requiredMark = field.required && !locked && (field.kind !== 'boolean' || field.nullable) && field.kind !== 'multiref' && !field.keepDefault
    ? <span className="text-red-500" aria-hidden="true"> *</span>
    : null
  const full = field.fullWidth ||
    field.kind === 'multiref' || field.kind === 'textarea' || field.kind === 'json' || field.kind === 'stringArray' || field.kind === 'object' || field.kind === 'objectArray'
  const wrap = full ? 'min-w-0 space-y-1.5 sm:col-span-2' : 'min-w-0 space-y-1.5'
  const selectedOption = field.kind === 'select' ? setupFieldOptions(field, formValues).find(option => option.value === String(value)) : undefined
  const lockedDisplay = field.kind === 'ref'
    ? (refOptions.find((option) => option.value === String(value))?.label ?? value)
    : selectedOption ? setupOptionLabel(selectedOption, t)
      : field.kind === 'boolean' && value !== null && value !== undefined && value !== '' ? common(value === true || value === 'true' ? 'labels.yes' : 'labels.no')
        : ['decimal', 'percent', 'integer', 'money'].includes(field.kind) && value !== null && value !== undefined && value !== '' ? formatDecimal(locale, String(value), { maximumFractionDigits: field.decimalScale ?? SETUP_DECIMAL_SCALE })
          : Array.isArray(value) ? value.join(', ') : value


  // Locked natural keys are shown read-only when editing.
  if (locked && field.kind !== 'object' && field.kind !== 'objectArray') {
    return (
      <div className={wrap}>
        <Label help={help}>{label}</Label>
        <div className={cn('min-h-10 w-full whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 [overflow-wrap:anywhere] dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300', field.kind !== 'ref' && 'font-mono')}>
          {String(lockedDisplay ?? '') || '—'}
        </div>
      </div>
    )
  }

  if (field.kind === 'object' || field.kind === 'objectArray') {
    const array = field.kind === 'objectArray'
    const validObject = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item)
    const entries = array ? (value == null ? [] : Array.isArray(value) ? value : null) : value == null ? [{}] : [value]
    if (entries === null || entries.some((entry) => !validObject(entry))) {
      return <div className={wrap}><Label help={help}>{label}</Label><p role="alert" className="text-sm text-red-600">{t('validation.invalidStructuredValue', { field: label })}</p></div>
    }
    function changeEntry(index: number, childKey: string, childValue: unknown) {
      const next = entries!.map((entry, position) => position === index ? { ...entry as Record<string, unknown>, [childKey]: childValue } : entry)
      onChange(array ? next : next[0])
    }
    return <div className={wrap}>
      <Label help={help}>{label}{requiredMark}</Label>
      <div className="space-y-3">
        {entries.map((entry, index) => {
          const controls = <div className={field.itemTitleKey ? "grid gap-5 sm:grid-cols-2" : "grid gap-4 sm:grid-cols-2"}>
            {(field.fields ?? []).filter((child) => setupFieldVisible(child, entry as Record<string, unknown>)).map((child) => <FieldControl key={child.key} field={child} value={(entry as Record<string, unknown>)[child.key]} onChange={(next) => changeEntry(index, child.key, next)} creating={creating} forceLocked={Boolean(locked)} refOptions={child.ref === 'countries' ? countries : []} formValues={entry as Record<string, unknown>} t={t} />)}
          </div>
          const remove = array && !locked ? <Button type="button" variant={field.itemTitleKey ? "ghost" : "outline"} size="sm" onClick={() => onChange(entries.filter((_, position) => position !== index))}><Trash2 size={14} />{t('structuredFields.removeRow')}</Button> : null
          if (field.itemTitleKey) return <InspectorPanel key={index} title={t(field.itemTitleKey, { number: index + 1 })} description={field.itemTitleField ? String((entry as Record<string, unknown>)[field.itemTitleField] ?? '') : undefined} actions={remove}>{controls}</InspectorPanel>
          return <fieldset key={index} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            {array ? <legend className="px-1 text-sm font-medium">{t('structuredFields.row', { number: index + 1 })}</legend> : null}
            {controls}
            {remove ? <div className="mt-3 flex justify-end">{remove}</div> : null}
          </fieldset>
        })}
        {array && !locked ? <Button type="button" variant="outline" size="sm" onClick={() => onChange([...entries, Object.fromEntries((field.fields ?? []).map((child) => [child.key, child.key === field.itemSequenceKey ? entries.reduce((highest, entry) => { const sequence = Number((entry as Record<string, unknown>)[child.key]); return Number.isSafeInteger(sequence) && sequence > highest ? sequence : highest }, 0) + 1 : child.defaultValue ?? (child.kind === 'boolean' ? false : child.kind === 'stringArray' ? [] : '')]))])}><Plus size={14} />{t(field.addLabelKey ?? 'structuredFields.addRow')}</Button> : null}
      </div>
    </div>
  }

  if (field.kind === 'boolean' && field.nullable) {
    return <div className={wrap}><Label help={help}>{label}{requiredMark}</Label>
      <Select disabled={Boolean(locked)} aria-label={label} value={value === true ? 'true' : value === false ? 'false' : ''} onChange={(event) => onChange(event.target.value === '' ? null : event.target.value === 'true')}>
        <option value="">{t('selectPlaceholder')}</option><option value="true">{t('yes')}</option><option value="false">{t('no')}</option>
      </Select>
    </div>
  }

  if (field.kind === 'boolean' && field.booleanStyle === 'switch') {
    return <div className={wrap}><SwitchField label={label} on={Boolean(value)} disabled={Boolean(locked)} onToggle={() => onChange(!value)} /></div>
  }

  if (field.kind === 'boolean') {
    return (
      <div className="self-end pb-2">
        <Label
          help={help}
          fieldName={label}
          className="flex items-center gap-2 text-sm font-normal text-slate-700 dark:text-slate-200"
        >
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => onChange(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
          />
          {label}
        </Label>
      </div>
    )
  }

  if (field.kind === 'multiref') {
    const selected: string[] = Array.isArray(value) ? value : []
    return (
      <div className={wrap}>
        <Label help={help}>{label}</Label>
        {refOptions.length === 0 ? (
          <p className="text-xs text-slate-400">{t('empty')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {refOptions.map((o) => {
              const on = selected.includes(o.value)
              return (
                <label
                  key={o.value}
                  className="flex items-center gap-1.5 rounded border border-slate-200 px-2 py-1 text-xs dark:border-slate-800"
                >
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) =>
                      onChange(e.target.checked ? [...selected, o.value] : selected.filter((x) => x !== o.value))
                    }
                    className="h-3.5 w-3.5 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                  />
                  {o.label}
                </label>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  if (field.kind === 'stringArray') {
    // Chip input with type-ahead over the field's ref source — raw JSON is
    // never an acceptable UI for a list of text values.
    const selected: string[] = Array.isArray(value) ? value.map(String) : []
    return (
      <div className={wrap}>
        <Label help={help}>{label}{requiredMark}</Label>
        <TagInput
          value={selected}
          onChange={onChange}
          options={refOptions.map((o) => ({ value: o.value, label: o.label }))}
          ariaLabel={label}
        />
      </div>
    )
  }

  if (field.kind === 'ref') {
    const options: SelectOption[] = refOptions.filter((option) => !field.refScopeField || option.scopeValue == null || option.scopeValue === String(formValues[field.refScopeField] ?? '')).filter((option) => !field.refAccountTypes || option.value === String(value ?? '') || (option.accountType !== undefined && field.refAccountTypes.includes(option.accountType))).map((o) => ({ value: o.value, label: o.label }))
    return (
      <div className={wrap}>
        <Label help={help}>{label}{requiredMark}</Label>
        <SearchSelect
          value={String(value ?? '')}
          onChange={onChange}
          options={options}
          placeholder={t('selectPlaceholder')}
          searchPlaceholder={t('searchPlaceholder')}
          sheetTitle={label}
          clearable={!field.required}
          ariaLabel={label}
        />
      </div>
    )
  }

  if (field.kind === 'country') {
    return (
      <div className={wrap}>
        <Label help={help}>{label}{requiredMark}</Label>
        <SearchSelect
          value={String(value ?? '')}
          onChange={onChange}
          options={countries}
          placeholder={t('selectPlaceholder')}
          searchPlaceholder={t('searchPlaceholder')}
          sheetTitle={label}
          clearable={!field.required}
          ariaLabel={label}
        />
      </div>
    )
  }

  if (field.kind === 'select') {
    // Scoped selects (pay-component treatments scoped by the component's
    // country) follow the live scope value — the same setupFieldOptions the
    // write path validates against, so the drawer offers exactly what saves.
    const options = setupFieldOptions(field, formValues)
    return (
      <div className={wrap}>
        <Label help={help}>{label}{requiredMark}</Label>
        <Select aria-label={label} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {!field.required ? <option value="">—</option> : value === undefined || value === null || value === '' ? <option value="" disabled>{t('selectPlaceholder')}</option> : null}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {setupOptionLabel(o, t)}
            </option>
          ))}
        </Select>
      </div>
    )
  }

  if (field.kind === 'textarea' || field.kind === 'json') {
    return (
      <div className={wrap}>
        <Label help={help}>{label}{requiredMark}</Label>
        <Textarea aria-label={label} className={field.kind === 'json' ? 'min-h-40 font-mono text-xs' : undefined} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      </div>
    )
  }

  // Money fields hold operator majors in the form state (converted at init
  // and save); the control is the shared decimal input, never a minor-units box.
  const numeric = field.kind === 'integer' || field.kind === 'decimal' || field.kind === 'percent' || field.kind === 'money'
  if (field.kind === 'money' && moneyLocked) {
    // Blank and editable, never disabled: typing a deliberate fresh amount
    // is the re-entry that clears the lock. Saving untouched still refuses
    // (the save loop checks the lock before its empty skip). Read-only stays
    // read-only: the `locked` early return above owns forceLocked and
    // lockedOnEdit, so this branch only renders for an editable field.
    return (
      <div className={wrap}>
        <Label help={help}>{label}{requiredMark}</Label>
        <Input aria-label={label} type="text" inputMode="decimal" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
        <p role="alert" className="mt-1 text-sm text-red-600 dark:text-red-400">{moneyLocked}</p>
      </div>
    )
  }
  return (
    <div className={wrap}>
      <Label help={help}>{label}{requiredMark}</Label>
      <Input
        aria-label={label}
        type={field.kind === 'date' ? 'date' : 'text'}
        inputMode={numeric ? 'decimal' : undefined}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}
