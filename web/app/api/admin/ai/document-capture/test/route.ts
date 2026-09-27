import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { getDocumentCaptureTestConfig } from '@openbooks/engine/src/payables/ap-capture-config.ts'
import { testAzureDocumentProvider } from '@openbooks/engine/src/payables/ap-capture.ts'
import { guardPermission } from '../../../../../../lib/authz'

const requestBodySchema = z.object({
  apiKey: z.string().min(1).optional(), endpoint: z.string().url().optional(), model: z.string().trim().min(1).max(200).optional(),
});


export const runtime = 'nodejs'

async function legacyPOST(request: Request) {
  const gate = await guardPermission('admin.ai.manage')
  if (gate instanceof NextResponse) return gate
  const parsedBody = await parseJsonBody(request, requestBodySchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as {
    endpoint?: string
    model?: string
    apiKey?: string
  }
  const config = await getDocumentCaptureTestConfig(gate.user.orgId, body)
  if (!config) return NextResponse.json({ ok: false, code: 'missing' })
  const result = await testAzureDocumentProvider(config)
  return NextResponse.json({ ok: result.ok, code: result.ok ? 'connected' : 'failed' })
}

export const POST = defineRoute({
  permission: "admin.ai.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  body: requestBodySchema,
  handler: async ({ request, body }) => {
    const replayHeaders = new Headers(request.headers);
    replayHeaders.delete("content-length");
    const replayRequest = new Request(request.url, { method: request.method, headers: replayHeaders, body: JSON.stringify(body), signal: request.signal });
    return legacyPOST(replayRequest as never);
  },
});
