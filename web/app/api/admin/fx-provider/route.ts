import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'

import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  FX_PROVIDER_MANIFESTS,
  FxProviderError,
  readFxProviderConfigView,
  runFxProvider,
  saveFxProviderConfig,
  type FxProviderKey,
  type FxSyncSchedule,
} from '@openbooks/engine/src/fx/providers.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'

const requestBodySchema = z.object({
  provider: z.enum(["bank_of_canada", "ecb", "open_exchange_rates"]),
  displayName: z.string().trim().min(1).max(100),
  baseCurrency: z.string().regex(/^[A-Z]{3}$/),
  currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1).max(200),
  schedule: z.enum(["manual", "daily", "weekdays", "weekly"]),
  syncHourUtc: z.number().int().min(0).max(23),
  lookbackDays: z.number().int().min(0).max(3650),
  isEnabled: z.boolean(),
  apiKey: z.string().nullable().optional(),
});
const runBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("test") }),
  z.object({ action: z.literal("sync") }),
]);


export const runtime = 'nodejs'
const PERMISSION = 'admin.setup.manage'

async function legacyGET() {
  const gate = await guardFeaturePermission(PERMISSION, 'multiCurrency')
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





export const GET = defineRoute({
  permission: "admin.setup.manage",
  feature: "multiCurrency",
  handler: async () => legacyGET(),
});

export const PUT = defineRoute({
  permission: "admin.setup.manage",
  feature: "multiCurrency",
  body: requestBodySchema,
  handler: async ({ body, authz: routeAuthz }) => {

    const gate = routeAuthz




    try {
      // The engine owns the config write plus its immutable before/after
      // audit as one transaction; the route must not write a second audit.
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
      return NextResponse.json({ id })
    } catch (error) {
      if (error instanceof FxProviderError) return apiErrorResponse(error, { safeStatus: 422 })
      throw error
    }
  },
});

export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: "multiCurrency",
  body: runBodySchema,
  handler: async ({ body, authz: routeAuthz }) => {

    const gate = routeAuthz




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
      if (error instanceof FxProviderError) return apiErrorResponse(error, { safeStatus: 422 })
      throw error
    }
  },
});
