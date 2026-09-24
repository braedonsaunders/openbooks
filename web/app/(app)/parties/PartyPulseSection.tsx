'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Skeleton } from '@openbooks/ui'
import { PulsePanel } from './PulsePanel'
import type { CustomerPulseData } from '../../../lib/customer-pulse'
import { readApiErrorMessage } from '../../../lib/api-error'

/** The Pulse tab of the customer flyout: loads the computed snapshot and
 *  hands it to the read-only panel. Pulse lives on the record and nowhere
 *  else — there is no standalone Pulse page to pick a customer on. */
export function PartyPulseSection({ partyId }: { partyId: string }) {
  const t = useTranslations('crm.pulse')
  // The result carries the party it belongs to, so switching parties reads as
  // "not loaded yet" without a synchronous reset in the effect body — which
  // would cascade a render on every mount (react-hooks/set-state-in-effect).
  const [result, setResult] = useState<{ partyId: string; data: CustomerPulseData | null } | null>(null)
  // The refusal carries its party like the result does, so switching parties
  // reads as "not loaded yet" with no synchronous reset in the effect body.
  const [refusal, setRefusal] = useState<{ partyId: string; message: string } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/customers/${partyId}/pulse`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(await readApiErrorMessage(response, t('loadFailed')))
        return response.json() as Promise<CustomerPulseData>
      })
      .then((loaded) => setResult({ partyId, data: loaded }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setResult({ partyId, data: null })
        setRefusal({ partyId, message: error instanceof Error ? error.message : t('loadFailed') })
      })
    return () => controller.abort()
  }, [partyId, t])

  const current = result?.partyId === partyId ? result : null
  const data = current?.data ?? null

  if (!current) {
    return (
      <div className="space-y-4 py-4">
        <Skeleton className="h-24 w-full rounded-xl" />
        <div className="grid grid-cols-4 gap-4">
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
          <Skeleton className="h-24 rounded-lg" />
        </div>
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    )
  }

  if (!data) {
    return (
      <div className="py-8 text-center text-sm text-slate-500">
        {refusal?.partyId === partyId ? refusal.message : t('loadFailed')}
      </div>
    )
  }

  return <PulsePanel data={data} />
}
