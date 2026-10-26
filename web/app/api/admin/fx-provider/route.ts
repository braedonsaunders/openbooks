import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";

import { NextResponse } from "next/server";
import {
  FX_PROVIDER_MANIFESTS,
  FxProviderError,
  readFxProviderConfigView,
  runFxProvider,
  saveFxProviderConfig,
  type FxProviderKey,
  type FxSyncSchedule,
} from "@openbooks/engine/fx/providers";
import { listFxProviderRuns } from "@openbooks/engine/fx/providers-read";
import type { Authz } from "@/lib/authz";

const requestBodySchema = z.object({
  provider: z.enum(["bank_of_canada", "ecb", "open_exchange_rates"]),
  displayName: z.string().trim().min(1).max(100),
  baseCurrency: z.string().regex(/^[A-Z]{3}$/),
  currencies: z
    .array(z.string().regex(/^[A-Z]{3}$/))
    .min(1)
    .max(200),
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

export const runtime = "nodejs";

async function legacyGET(gate: Authz) {
  const config = await readFxProviderConfigView(gate.user.orgId);
  const runs = await listFxProviderRuns(gate.user.orgId);
  return NextResponse.json({ config, runs, providers: Object.keys(FX_PROVIDER_MANIFESTS) });
}

export const GET = defineRoute({
  permission: "admin.setup.manage",
  feature: "multiCurrency",
  handler: async ({ authz }) => legacyGET(authz),
});

export const PUT = defineRoute({
  permission: "admin.setup.manage",
  feature: "multiCurrency",
  body: requestBodySchema,
  handler: async ({ body, authz: routeAuthz }) => {
    const gate = routeAuthz;

    try {
      // The engine owns the config write plus its immutable before/after
      // audit as one transaction; the route must not write a second audit.
      const id = await saveFxProviderConfig(gate.user.orgId, gate.user.id, {
        provider: body.provider as FxProviderKey,
        displayName: body.displayName,
        baseCurrency: String(body.baseCurrency ?? ""),
        currencies: Array.isArray(body.currencies) ? body.currencies : [],
        schedule: body.schedule as FxSyncSchedule,
        syncHourUtc: Number(body.syncHourUtc),
        lookbackDays: Number(body.lookbackDays),
        isEnabled: body.isEnabled === true,
        apiKey: body.apiKey,
      });
      return NextResponse.json({ id });
    } catch (error) {
      if (error instanceof FxProviderError) return apiErrorResponse(error, { safeStatus: 422 });
      throw error;
    }
  },
});

export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: "multiCurrency",
  body: runBodySchema,
  handler: async ({ body, authz: routeAuthz }) => {
    const gate = routeAuthz;

    if (body.action !== "test" && body.action !== "sync") {
      return NextResponse.json({ error: "action must be test or sync" }, { status: 400 });
    }
    try {
      const result = await runFxProvider(
        gate.user.orgId,
        body.action === "test" ? "test" : "manual",
        gate.user.id,
      );
      return NextResponse.json({ ok: true, result });
    } catch (error) {
      if (error instanceof FxProviderError) return apiErrorResponse(error, { safeStatus: 422 });
      throw error;
    }
  },
});
