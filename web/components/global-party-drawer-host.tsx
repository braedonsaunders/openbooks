'use client'

import { useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Drawer } from '@openbooks/ui'
import { toast } from 'sonner'
import { LogoLoader } from './brand-logo'
import { PartyDrawer } from '../app/(app)/parties/PartyDrawer'
import type { RelatedPartyRole } from './related-party-link'

interface DrawerPayload {
  payload: Parameters<typeof PartyDrawer>[0]['payload']
  paymentTerms: Parameters<typeof PartyDrawer>[0]['paymentTerms']
  departments: Parameters<typeof PartyDrawer>[0]['departments']
  trades: Parameters<typeof PartyDrawer>[0]['trades']
  fieldDefs: Parameters<typeof PartyDrawer>[0]['fieldDefs']
  subsidiaries: Array<{
    id: string
    parentId: string | null
    name: string
    isElimination: boolean
    depth: number
  }>
}

function isRole(value: string | null): value is RelatedPartyRole {
  return value === 'customer' || value === 'vendor' || value === 'employee'
}

/** Shell-level related-party overlay. Its close URL is the exact page beneath it. */
export function GlobalPartyDrawerHost({ canManage }: { canManage: boolean }) {
  const t = useTranslations('shell.relatedParty')
  const pathname = usePathname() ?? '/'
  const searchParams = useSearchParams()
  const queryString = searchParams.toString()
  const router = useRouter()
  const partyId = searchParams.get('relatedParty')
  const requestedRole = searchParams.get('relatedPartyRole')
  const role = isRole(requestedRole) ? requestedRole : undefined
  const [data, setData] = useState<DrawerPayload | null>(null)
  const [loadedId, setLoadedId] = useState<string | null>(null)

  const closeHref = useMemo(() => {
    const params = new URLSearchParams(queryString)
    params.delete('relatedParty')
    params.delete('relatedPartyRole')
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
    fetch(`/api/parties/${encodeURIComponent(partyId)}/drawer`, { signal: controller.signal })
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
  }, [closeHref, partyId, router, t])

  if (!partyId) return null
  if (!data || loadedId !== partyId) {
    return (
      <Drawer open onClose={() => router.push(closeHref as never, { scroll: false })} size="lg" title={t('loadingTitle')}>
        <LogoLoader label={t('loading')} />
      </Drawer>
    )
  }

  return (
    <PartyDrawer
      {...({ subsidiaries: data.subsidiaries } as any)}
      key={partyId}
      payload={data.payload}
      paymentTerms={data.paymentTerms}
      departments={data.departments}
      trades={data.trades}
      fieldDefs={data.fieldDefs}
      canManage={canManage}
      role={role}
      basePath={closeHref}
    />
  )
}
