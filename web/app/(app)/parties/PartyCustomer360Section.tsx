'use client'

import { useEffect, useState } from 'react'
import { Skeleton } from '@openbooks/ui'
import { Customer360Cockpit } from '../crm/Customer360Cockpit'
import type { Customer360Data } from '../../../lib/customer-360'

export function PartyCustomer360Section({ partyId }: { partyId: string }) {
  const [data, setData] = useState<Customer360Data | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    fetch(`/api/customers/${partyId}/360`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load customer 360 data')
        return res.json()
      })
      .then((resData) => {
        if (!cancelled) {
          setData(resData)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message)
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [partyId])

  if (loading) {
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

  if (error || !data) {
    return (
      <div className="py-8 text-center text-sm text-slate-500">
        {error ?? 'Unable to load Customer 360 telemetry.'}
      </div>
    )
  }

  return <Customer360Cockpit data={data} />
}
