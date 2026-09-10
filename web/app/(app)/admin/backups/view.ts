import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/db.ts'
import { s3Enabled } from '@openbooks/engine/src/file-storage.ts'
import { getWorkerHeartbeat } from '@openbooks/jobs'
import { page, pageHeader, ref, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { requirePermission } from '../../../../lib/authz'
import type { BackupManagerProps } from './BackupManager'

/**
 * Stored + scheduled backups, split into a loader and a spec.
 *
 * The whole body is one widget, not spec blocks — see the note on
 * `BackupManager` in `./BackupManager`: the native page renders a single
 * client component that owns the schedule form (local useState per field),
 * live progress polling (`setInterval` → `router.refresh()` while a run is
 * in flight), and fetch mutations (save policy, run now, delete with
 * `window.confirm`). Those are client state, effects and capabilities, none
 * of which a spec can name. What the spec CAN carry is everything around
 * it: the header and the server-resolved inputs become loader data.
 *
 * The loader copies page.tsx's query, permission and derivation logic
 * verbatim (the `admin.backups.manage` gate, the policy/runs queries, the
 * ISO-timestamp normalization, the 90s worker-heartbeat window with its
 * fail-closed catch).
 */

function isoTimestamp(value: Date | string | null): string | null {
  if (value === null) return null
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid backup timestamp: ${String(value)}`)
  }
  return date.toISOString()
}

export interface AdminBackupsData {
  title: string
  description: string
  backHref: string
  backLabel: string
  manager: BackupManagerProps
}

export async function loadAdminBackups(): Promise<AdminBackupsData> {
  const authz = await requirePermission('admin.backups.manage')
  const tHub = await getTranslations('admin.hub')
  const { orgId } = authz.user

  const policyRes = await db.execute<{
    enabled: boolean
    frequency: string
    hour_utc: number
    day_of_week: number
    day_of_month: number
    max_keep: number
    last_run_at: Date | string | null
    next_run_at: Date | string | null
  }>(sql`
    select enabled, frequency, hour_utc, day_of_week, day_of_month, max_keep,
           last_run_at, next_run_at
      from backup_policies where org_id = ${orgId}`)
  const p = policyRes.rows[0]
  const policy: BackupManagerProps['policy'] = p
    ? {
        enabled: p.enabled,
        frequency: p.frequency as NonNullable<BackupManagerProps['policy']>['frequency'],
        hourUtc: p.hour_utc,
        dayOfWeek: p.day_of_week,
        dayOfMonth: p.day_of_month,
        maxKeep: p.max_keep,
        lastRunAt: isoTimestamp(p.last_run_at),
        nextRunAt: isoTimestamp(p.next_run_at),
      }
    : null

  const runsRes = await db.execute<{
    id: string
    kind: string
    status: string
    file_name: string | null
    byte_size: number | null
    table_count: number | null
    row_count: number | null
    sha256: string | null
    error: string | null
    purged_at: Date | string | null
    purge_reason: string | null
    created_at: Date | string
    completed_at: Date | string | null
  }>(sql`
    select id, kind, status, file_name, byte_size, table_count, row_count, sha256,
           error, purged_at, purge_reason, created_at, completed_at
      from backup_runs
     where org_id = ${orgId}
     order by created_at desc
     limit 50`)
  const runs: BackupManagerProps['runs'] = runsRes.rows.map((r) => ({
    id: r.id,
    kind: r.kind as BackupManagerProps['runs'][number]['kind'],
    status: r.status as BackupManagerProps['runs'][number]['status'],
    fileName: r.file_name,
    // bigint/numeric columns arrive from the pg driver as strings.
    byteSize: r.byte_size === null ? null : Number(r.byte_size),
    tableCount: r.table_count === null ? null : Number(r.table_count),
    rowCount: r.row_count === null ? null : Number(r.row_count),
    sha256: r.sha256,
    error: r.error,
    purgedAt: isoTimestamp(r.purged_at),
    purgeReason: r.purge_reason as BackupManagerProps['runs'][number]['purgeReason'],
    createdAt: isoTimestamp(r.created_at)!,
    completedAt: isoTimestamp(r.completed_at),
  }))

  // Scheduled backups run on the background worker — surface when it's down.
  let workerOnline = false
  try {
    const heartbeat = await getWorkerHeartbeat()
    workerOnline = heartbeat !== null && Date.now() - Date.parse(heartbeat) < 90_000
  } catch {
    workerOnline = false
  }

  return {
    title: 'Backups',
    description:
      "Download a complete copy of this organization's data, schedule automatic backups to object storage, and control how many are retained.",
    backHref: '/admin',
    backLabel: tHub('title'),
    manager: { policy, runs, s3Enabled, workerOnline },
  }
}

const f = ref<AdminBackupsData>()

export function adminBackupsSpec(data: AdminBackupsData): PageSpec {
  return page({
    layout: 'list',
    header: [
      pageHeader({
        back: { href: f('backHref'), label: f('backLabel') },
        title: f('title'),
        description: f('description'),
      }),
    ],
    body: [
      // The schedule form, progress polling and mutations are client state —
      // the spec places the component whole and the loader hands over the
      // server inputs as flat data. `s3Enabled` is deployment config the
      // page already reads, not a capability; the worker-online flag is a
      // loader-derived boolean, and Authz never crosses the boundary.
      widgetBlock('backup-manager', {
        policy: data.manager.policy,
        runs: data.manager.runs,
        s3Enabled: data.manager.s3Enabled,
        workerOnline: data.manager.workerOnline,
      }),
    ],
  })
}
