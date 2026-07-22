'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { PartyDrawer, type PartyTab } from '../app/(app)/parties/PartyDrawer'
import type { RelatedPartyRole } from './related-party-link'
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
}

function isRole(value: string | null): value is RelatedPartyRole {
  return value === 'customer' || value === 'vendor' || value === 'employee'
}

function isPartyTab(value: string | null): value is PartyTab {
  return value === 'overview' || value === 'transactions' || value === 'activities' || value === 'contacts'
    || value === 'addresses' || value === 'accounting' || value === 'wages'
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
  const [data, setData] = useState<DrawerPayload | null>(null)
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const [transactionData, setTransactionData] = useState<RelatedTransactionDrawerData | null>(null)
  const [loadedTransaction, setLoadedTransaction] = useState<string | null>(null)

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

  useEffect(() => {
    if (!partyId) {
      setData(null)
      setLoadedId(null)
      return
    }
    const controller = new AbortController()
    setData(null)
    setLoadedId(null)
    const params = new URLSearchParams()
    if (role) params.set('role', role)
    if (partyForm) params.set('form', partyForm)
    fetch(`/api/parties/${encodeURIComponent(partyId)}/drawer?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : t('loadFailed'))
        return body as DrawerPayload
      })
      .then((body) => {
        setData(body)
        setLoadedId(partyId)
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        toast.error(error instanceof Error ? error.message : t('loadFailed'))
        router.replace(closeHref as never, { scroll: false })
      })
    return () => controller.abort()
  }, [closeHref, partyForm, partyId, role, router, t])

  const transactionCloseHref = useMemo(() => {
    const params = new URLSearchParams(queryString)
    params.delete('partyTxn')
    params.delete('partyTxnKind')
    const query = params.toString()
    return query ? `${pathname}?${query}` : pathname
  }, [pathname, queryString])

  useEffect(() => {
    if (!partyId || !transactionId || !transactionKind) {
      setTransactionData(null)
      setLoadedTransaction(null)
      return
    }
    const selection = `${transactionKind}:${transactionId}`
    const controller = new AbortController()
    setTransactionData(null)
    setLoadedTransaction(null)
    const params = new URLSearchParams({ transaction: transactionId, kind: transactionKind })
    const form = searchParams.get('form')
    if (form) params.set('form', form)
    fetch(`/api/parties/${encodeURIComponent(partyId)}/transaction-drawer?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : t('loadFailed'))
        return body as RelatedTransactionDrawerData
      })
      .then((body) => {
        setTransactionData(body)
        setLoadedTransaction(selection)
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        toast.error(error instanceof Error ? error.message : t('loadFailed'))
        router.replace(transactionCloseHref as never, { scroll: false })
      })
    return () => controller.abort()
  }, [partyId, router, searchParams, t, transactionCloseHref, transactionId, transactionKind])

  if (!partyId) return null
  // Keep the page beneath completely undisturbed while the record loads. The
  // real, full-size drawer mounts only after its complete payload is ready.
  if (!data || loadedId !== partyId) return null

  const transactionSelection = transactionId && transactionKind ? `${transactionKind}:${transactionId}` : null
  return (
    <>
      <PartyDrawer
        {...({ subsidiaries: data.subsidiaries } as any)}
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
        role={role}
        initialTab={initialTab}
        basePath={closeHref}
        layout={data.layout}
        forms={data.forms}
        currentFormId={data.currentFormId}
        recordType={data.recordType}
        canCustomize={data.canCustomize}
      />
      {transactionData && loadedTransaction === transactionSelection ? (
        <RelatedTransactionDrawerClient data={transactionData} />
      ) : null}
    </>
  )
}
