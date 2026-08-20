import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  FX_PROVIDER_MANIFESTS,
  FxProviderError,
  readFxProviderConfigView,
  runFxProvider,
  saveFxProviderConfig,
  type FxProviderKey,
  type FxSyncSchedule,
} from '@openbooks/engine/src/fx-providers.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'
const PERMISSION = 'admin.setup.manage'

export async function GET() {
  const gate = await guardPermission(PERMISSION)
  if (gate instanceof NextResponse) return gate
  const config = await readFxProviderConfigView(gate.user.orgId)
  const runs = (await db.execute<Record<string, unknown>>(sql`
    select id, trigger, status, requested_from as "requestedFrom", requested_to as "requestedTo",
           observations_received as "observationsReceived", rates_inserted as "ratesInserted",
           rates_updated as "ratesUpdated", manual_overrides_preserved as "manualOverridesPreserved",
           error_message as "errorMessage", started_at as "startedAt", finished_at as "finishedAt"
      from fx_provider_runs where org_id = ${gate.user.orgId}
     order by started_at desc limit 10
  `))
  return NextResponse.json({ config, runs: runs.rows, providers: Object.keys(FX_PROVIDER_MANIFESTS) })
}

export async function PUT(req: Request) {
  const gate = await guardPermission(PERMISSION)
  if (gate instanceof NextResponse) return gate
  const body = (await req.json().catch(() => ({}))) as {
    provider?: FxProviderKey
    displayName?: string
    baseCurrency?: string
    currencies?: string[]
    schedule?: FxSyncSchedule
    syncHourUtc?: number
    lookbackDays?: number
    isEnabled?: boolean
    apiKey?: string | null
  }
  try {
    const existing = await readFxProviderConfigView(gate.user.orgId)
    const id = await saveFxProviderConfig(gate.user.orgId, gate.user.id, {
      provider: body.provider as FxProviderKey,
      displayName: body.displayName,
      baseCurrency: String(body.baseCurrency ?? ''),
      currencies: Array.isArray(body.currencies) ? body.currencies : [],
      schedule: body.schedule as FxSyncSchedule,
      syncHourUtc: Number(body.syncHourUtc),
      lookbackDays: Number(body.lookbackDays),
      isEnabled: body.isEnabled === true,
      apiKey: body.apiKey,
    })
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${gate.user.orgId}, 'fx_provider_configs', ${id}, ${existing ? 'update' : 'insert'},
              ${JSON.stringify({ provider: body.provider, displayName: body.displayName, baseCurrency: body.baseCurrency, currencies: body.currencies, schedule: body.schedule, syncHourUtc: body.syncHourUtc, lookbackDays: body.lookbackDays, isEnabled: body.isEnabled })}::jsonb,
              ${gate.user.id})
    `)
    return NextResponse.json({ id })
  } catch (error) {
    if (error instanceof FxProviderError) return NextResponse.json({ error: error.message }, { status: 422 })
    throw error
  }
}

export async function POST(req: Request) {
  const gate = await guardPermission(PERMISSION)
  if (gate instanceof NextResponse) return gate
  const body = (await req.json().catch(() => ({}))) as { action?: 'test' | 'sync' }
  if (body.action !== 'test' && body.action !== 'sync') {
    return NextResponse.json({ error: 'action must be test or sync' }, { status: 400 })
  }
  try {
    const result = await runFxProvider(
      gate.user.orgId,
      body.action === 'test' ? 'test' : 'manual',
      gate.user.id,
    )
    return NextResponse.json({ ok: true, result })
  } catch (error) {
    if (error instanceof FxProviderError) return NextResponse.json({ error: error.message }, { status: 422 })
    throw error
  }
}
