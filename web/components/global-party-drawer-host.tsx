'use client'

import { useMemo } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { PartyDrawer, type PartyTab } from '../app/(app)/parties/PartyDrawer'
import type { RelatedPartyRole } from './related-party-link'
import { useDrawerResource } from './use-drawer-resource'
import {
  RelatedTransactionDrawerClient,
  type RelatedTransactionDrawerData,
} from './related-transaction-drawer-client'

interface DrawerPayload {
  payload: Parameters<typeof PartyDrawer>[0]['payload']
  paymentTerms: Parameters<typeof PartyDrawer>[0]['paymentTerms']
  departments: Parameters<typeof PartyDrawer>[0]['departments']
  trades: Parameters<typeof PartyDrawer>[0]['trades']
  workerCompGroups?: Parameters<typeof PartyDrawer>[0]['workerCompGroups']
  fieldDefs: Parameters<typeof PartyDrawer>[0]['fieldDefs']
  accounts: Parameters<typeof PartyDrawer>[0]['accounts']
  taxCodes: Parameters<typeof PartyDrawer>[0]['taxCodes']
  salesReps: Parameters<typeof PartyDrawer>[0]['salesReps']
  subsidiaries: Array<{
    id: string
    parentId: string | null
    name: string
    isElimination: boolean
    depth: number
  }>
  layout: Parameters<typeof PartyDrawer>[0]['layout']
  forms: Parameters<typeof PartyDrawer>[0]['forms']
  currentFormId: string | null
  recordType: 'customer' | 'vendor' | 'employee'
  canCustomize: boolean
  payrollEnabled?: boolean
  multiCurrency?: boolean
  complianceEnabled?: boolean
  canManageCompliance?: boolean
  compliance?: { classId: string | null; classes: Array<{ id: string; code: string; name: string }> } | null
}

function isRole(value: string | null): value is RelatedPartyRole {
  return value === 'customer' || value === 'vendor' || value === 'employee'
}

function isPartyTab(value: string | null): value is PartyTab {
  return value === 'overview' || value === 'transactions' || value === 'activities' || value === 'contacts'
    || value === 'addresses' || value === 'accounting' || value === 'wages' || value === 'compliance'
}

/** Shell-level related-party overlay. Its close URL is the exact page beneath it. */
export function GlobalPartyDrawerHost({
  canManage,
  canReadActivities,
  canManageWages,
}: {
  canManage: boolean
  canReadActivities: boolean
  canManageWages: boolean
}) {
  const t = useTranslations('shell.relatedParty')
  const pathname = usePathname() ?? '/'
  const searchParams = useSearchParams()
  const queryString = searchParams.toString()
  const router = useRouter()
  const partyId = searchParams.get('relatedParty')
  const requestedRole = searchParams.get('relatedPartyRole')
  const role = isRole(requestedRole) ? requestedRole : undefined
  const requestedTab = searchParams.get('relatedPartyTab')
  const partyForm = searchParams.get('partyForm')
  const transactionId = searchParams.get('partyTxn')
  const transactionKind = searchParams.get('partyTxnKind')
  const initialTab = isPartyTab(requestedTab) ? requestedTab : 'overview'

  const closeHref = useMemo(() => {
    const params = new URLSearchParams(queryString)
    params.delete('relatedParty')
    params.delete('relatedPartyRole')
    params.delete('relatedPartyTab')
    params.delete('partyTxn')
    params.delete('partyTxnKind')
    params.delete('drawerReturn')
    params.delete('partyForm')
    const query = params.toString()
    return query ? `${pathname}?${query}` : pathname
  }, [pathname, queryString])

  const partySearch = new URLSearchParams()
  if (role) partySearch.set('role', role)
  if (partyForm) partySearch.set('form', partyForm)
  const data = useDrawerResource<DrawerPayload>(partyId ? `/api/parties/${encodeURIComponent(partyId)}/drawer?${partySearch}` : null, (error) => {
    toast.error(error.message || t('loadFailed'))
    router.replace(closeHref as never, { scroll: false })
  })

  const transactionCloseHref = useMemo(() => {
    const params = new URLSearchParams(queryString)
    params.delete('partyTxn')
    params.delete('partyTxnKind')
    const query = params.toString()
    return query ? `${pathname}?${query}` : pathname
  }, [pathname, queryString])

  const transactionSearch = new URLSearchParams({ transaction: transactionId ?? '', kind: transactionKind ?? '' })
  const form = searchParams.get('form')
  if (form) transactionSearch.set('form', form)
  const transactionData = useDrawerResource<RelatedTransactionDrawerData>(partyId && transactionId && transactionKind
    ? `/api/parties/${encodeURIComponent(partyId)}/transaction-drawer?${transactionSearch}` : null, (error) => {
    toast.error(error.message || t('loadFailed'))
    router.replace(transactionCloseHref as never, { scroll: false })
  })
  // The native record owns its shell. Mount it once its full payload is ready.
  if (!partyId || !data) return null

  return (
    <>
      <PartyDrawer
        {...(({ subsidiaries: data.subsidiaries }))}
        key={partyId}
        payload={data.payload}
        paymentTerms={data.paymentTerms}
        departments={data.departments}
        trades={data.trades}
        workerCompGroups={data.workerCompGroups}
        fieldDefs={data.fieldDefs}
        accounts={data.accounts}
        taxCodes={data.taxCodes}
        salesReps={data.salesReps}
        canManage={canManage}
        canReadActivities={canReadActivities}
        canManageWages={canManageWages}
        payrollEnabled={data.payrollEnabled === true}
        multiCurrency={data.multiCurrency === true}
        complianceEnabled={data.complianceEnabled === true}
        canManageCompliance={data.canManageCompliance === true}
        compliance={data.compliance ?? null}
        role={role}
        initialTab={initialTab}
        basePath={closeHref}
        layout={data.layout}
        forms={data.forms}
        currentFormId={data.currentFormId}
        recordType={data.recordType}
        canCustomize={data.canCustomize}
      />
      {transactionData ? (
        <RelatedTransactionDrawerClient data={transactionData} />
      ) : null}
    </>
  )
}
