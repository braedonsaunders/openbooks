import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from 'next/server'
import { getDocumentCaptureTestConfig } from '@openbooks/engine/src/payables/ap-capture-config.ts'
import { testAzureDocumentProvider } from '@openbooks/engine/src/payables/ap-capture.ts'


const requestBodySchema = z.object({
  apiKey: z.string().min(1).optional(), endpoint: z.string().url().optional(), model: z.string().trim().min(1).max(200).optional(),
}).refine((body) => Object.keys(body).length > 0, { message: "At least one field must be provided." });


export const runtime = 'nodejs'



export const POST = defineRoute({
  permission: "admin.ai.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  body: requestBodySchema,
  handler: async ({ body, authz: routeAuthz }) => {

    const gate = routeAuthz




    const config = await getDocumentCaptureTestConfig(gate.user.orgId, body)
    if (!config) return NextResponse.json({ ok: false, code: 'missing' })
    const result = await testAzureDocumentProvider(config)
    return NextResponse.json({ ok: result.ok, code: result.ok ? 'connected' : 'failed' })
  },
});
