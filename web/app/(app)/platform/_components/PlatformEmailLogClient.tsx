'use client'

import { DeliveryLogAdmin, type DeliveryLogRecord } from '@braedonsaunders/appkit-superadmin/react'
import type { PlatformEmail } from '../../../../lib/platform-admin'
import { asDate } from '../../../../lib/platform-console'

function toLog(row: PlatformEmail): DeliveryLogRecord {
  return {
    id: row.id,
    createdAt: asDate(row.createdAt) ?? new Date(),
    tenantName: row.orgName,
    recipient: row.recipientPrimary ?? row.recipients[0] ?? '—',
    subject: row.subject,
    category: row.categoryKey,
    status: row.status,
    provider: row.provider,
    errorMessage: row.errorMessage,
  }
}

export function PlatformEmailLogClient({ rows }: { rows: PlatformEmail[] }) {
  return (
    <DeliveryLogAdmin
      kind="email"
      title="Email log"
      description="Delivery evidence across every organization."
      rows={rows.map(toLog)}
      statuses={['queued', 'sent', 'failed', 'suppressed', 'uncertain']}
    />
  )
}
