'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import { CreditCard, Repeat } from 'lucide-react'

import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { Badge, Button, Drawer, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@openbooks/ui'
import { Switch, SwitchField } from '../../../components/switch'
import { useAppAction } from '../../../lib/use-app-action'
import { readApiErrorMessage } from '../../../lib/api-error'
import { DrawerSublist, SublistAddButton, SublistEmpty, SublistLoadError, SublistLoading } from '../../../components/drawer-sublist'
import { AddPaymentMethodDrawer } from './PartyAddPaymentMethodDrawer'

interface EnrollmentRow {
  id: string
  subscriptionId: string | null
  subscriptionName: string | null
  status: 'active' | 'paused'
}

interface MethodRow {
  id: string
  status: string
}

interface AutopayState {
  enrollments: EnrollmentRow[]
  methods: MethodRow[]
}

/**
 * Autopay enrollments for one customer. Autopay charges the customer's
 * default active payment method, so a customer without one is an empty
 * state with its remedy — add a payment method — never an error. Only a
 * failed read is an error, and it names what failed.
 */
export function PartyAutopayPanel({
  partyId,
  canManageAutopay,
  canManageMethods = false,
  revision = 0,
  onChanged,
}: {
  partyId: string
  canManageAutopay: boolean
  /** Lets the empty state offer Add payment method. */
  canManageMethods?: boolean
  /** Bumped when payment methods change elsewhere in the drawer. */
  revision?: number
  /** Called after this panel adds a payment method. */
  onChanged?: () => void
}) {
  const t = useTranslations('parties.drawer.autopay')
  const tc = useTranslations('common')
  const { busy, refusal, execute, clearRefusal } = useAppAction()
  const [state, setState] = useState<AutopayState | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [enrolling, setEnrolling] = useState(false)
  const [chargeOnIssue, setChargeOnIssue] = useState(false)
  const [addingMethod, setAddingMethod] = useState(false)

  // The mount effect keeps its promise-chain shape, which never resets state
  // synchronously inside the effect body; mutations refresh through the
  // same reload and apply pair.
  const reload = useCallback(async (signal?: AbortSignal): Promise<AutopayState> => {
    const query = `partyId=${encodeURIComponent(partyId)}`
    const [enrollmentsRes, methodsRes] = await Promise.all([
      fetch(`/api/autopay/enrollments?${query}`, { signal }),
      fetch(`/api/autopay/methods?${query}`, { signal }),
    ])
    if (!enrollmentsRes.ok) throw new Error(await readApiErrorMessage(enrollmentsRes, t('enrollmentsLoadFailed')))
    if (!methodsRes.ok) throw new Error(await readApiErrorMessage(methodsRes, t('loadFailed')))
    const enrollmentsBody = (await enrollmentsRes.json()) as { enrollments?: EnrollmentRow[] }
    const methodsBody = (await methodsRes.json()) as { methods?: MethodRow[] }
    return { enrollments: enrollmentsBody.enrollments ?? [], methods: methodsBody.methods ?? [] }
  }, [partyId, t])

  const applyLoaded = useCallback((applied: AutopayState) => {
    setState(applied)
    setLoadError(null)
  }, [])

  const applyRefusal = useCallback((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') return
    setLoadError(error instanceof Error ? error.message : t('enrollmentsLoadFailed'))
    setState(null)
  }, [t])

  useEffect(() => {
    const controller = new AbortController()
    reload(controller.signal).then(applyLoaded, applyRefusal)
    return () => controller.abort()
  }, [reload, applyLoaded, applyRefusal, revision])

  function refresh(): void {
    void reload().then(applyLoaded, applyRefusal)
  }

  async function enroll() {
    const ok = await execute(() => fetchAction(`/api/autopay/enrollments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ partyId, chargeOnIssue }),
    }), {
      fallbackMessage: t('enrollFailed'),
    })
    if (ok) {
      setEnrolling(false)
      setChargeOnIssue(false)
      refresh()
    }
  }

  async function moveEnrollment(id: string, status: 'active' | 'paused') {
    await execute(() => fetchAction(`/api/autopay/enrollments/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    }), {
      fallbackMessage: t('updateFailed'),
      onOk: () => refresh(),
    })
  }

  const enrollments = state?.enrollments ?? []
  const customerEnrollment = enrollments.find((row) => row.subscriptionId === null)
  const hasMethod = (state?.methods.length ?? 0) > 0
  const hasActiveMethod = state?.methods.some((method) => method.status === 'active') ?? false
  const addMethodButton = canManageMethods
    ? <SublistAddButton label={t('addMethod')} onClick={() => setAddingMethod(true)} />
    : undefined

  return (
    <>
      <DrawerSublist
        title={t('enrollmentHeading')}
        description={t('enrollmentDescription')}
        icon={<Repeat size={16} />}
        action={state && hasActiveMethod && !customerEnrollment && canManageAutopay ? (
          <SublistAddButton label={t('enroll')} onClick={() => { clearRefusal(); setEnrolling(true) }} />
        ) : undefined}
        alert={!enrolling && refusal?.serverMessage ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">{refusal.serverMessage}</p>
        ) : null}
      >
        {state === null ? (
          loadError ? <SublistLoadError message={loadError} onRetry={refresh} /> : <SublistLoading />
        ) : !hasMethod ? (
          <SublistEmpty
            icon={<CreditCard size={22} />}
            text={t('needsMethodTitle')}
            hint={canManageMethods ? t('needsMethodHint') : t('needsMethodHintReadOnly')}
            action={addMethodButton}
          />
        ) : !hasActiveMethod && enrollments.length === 0 ? (
          <SublistEmpty icon={<CreditCard size={22} />} text={t('awaitingMethodTitle')} hint={t('awaitingMethodHint')} />
        ) : enrollments.length === 0 ? (
          <SublistEmpty icon={<Repeat size={22} />} text={t('notEnrolled')} />
        ) : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>{t('scope')}</TableHead>
              <TableHead>{tc('labels.status')}</TableHead>
              <TableHead className="text-right">{t('collect')}</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {enrollments.map((enrollment) => {
                const label = enrollment.subscriptionId === null
                  ? t('customerScope')
                  : t('subscriptionScope', { name: enrollment.subscriptionName ?? enrollment.subscriptionId ?? '' })
                return (
                  <TableRow key={enrollment.id}>
                    <TableCell className="font-medium text-slate-900 dark:text-slate-100">{label}</TableCell>
                    <TableCell>
                      <Badge variant={enrollment.status === 'active' ? 'success' : 'secondary'}>
                        {enrollment.status === 'active' ? t('active') : t('paused')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end">
                        <Switch
                          on={enrollment.status === 'active'}
                          disabled={busy || !canManageAutopay}
                          label={label}
                          onToggle={() => void moveEnrollment(enrollment.id, enrollment.status === 'active' ? 'paused' : 'active')}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </DrawerSublist>
      {canManageAutopay ? (
        <Drawer
          open={enrolling}
          onClose={() => { if (!busy) setEnrolling(false) }}
          stacked
          size="md"
          title={t('enroll')}
          description={t('enrollDescription')}
          footer={(
            <>
              <Button variant="outline" disabled={busy} onClick={() => setEnrolling(false)}>{tc('actions.cancel')}</Button>
              <Button disabled={busy} onClick={() => void enroll()}>{t('enroll')}</Button>
            </>
          )}
        >
          <div className="space-y-4">
            <ActionAlert error={refusal} fallbackMessage={t('enrollFailed')} />
            <SwitchField
              label={t('chargeOnIssue')}
              description={t('chargeOnIssueHint')}
              on={chargeOnIssue}
              disabled={busy}
              onToggle={() => setChargeOnIssue((flag) => !flag)}
            />
          </div>
        </Drawer>
      ) : null}
      {canManageMethods ? (
        <AddPaymentMethodDrawer
          partyId={partyId}
          open={addingMethod}
          onClose={() => setAddingMethod(false)}
          onCreated={() => {
            refresh()
            onChanged?.()
          }}
        />
      ) : null}
    </>
  )
}
