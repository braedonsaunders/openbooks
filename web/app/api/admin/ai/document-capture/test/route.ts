import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from 'next/server'
import { getDocumentCaptureTestConfig, getLlmCaptureTestConfig } from '@openbooks/engine/payables/ap-capture-config'
import { testAzureDocumentProvider } from '@openbooks/engine/payables/ap-capture'
import { testLlmDocumentProvider } from '@openbooks/engine/payables/document-capture-llm'


const requestBodySchema = z.object({
  provider: z.enum(['azure_document_intelligence', 'llm_vision']).optional(),
  apiKey: z.string().min(1).optional(), endpoint: z.string().url().optional(), model: z.string().trim().min(1).max(200).optional(),
}).refine((body) => Object.keys(body).length > 0, { message: "At least one field must be provided." });


export const runtime = 'nodejs'



export const POST = defineRoute({
  permission: "admin.ai.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  body: requestBodySchema,
  handler: async ({ body, authz: routeAuthz }) => {

    const gate = routeAuthz




    // The AI model provider is tested with the organization's AI key and the
    // capture model (or its smart model); Azure with the form's or stored key.
    if (body.provider === 'llm_vision') {
      let llm: Awaited<ReturnType<typeof getLlmCaptureTestConfig>>
      try {
        llm = await getLlmCaptureTestConfig(gate.user.orgId, { model: body.model })
      } catch (error) {
        return NextResponse.json({ ok: false, code: 'failed', message: error instanceof Error ? error.message : undefined })
      }
      if (!llm) return NextResponse.json({ ok: false, code: 'missingAi' })
      const result = await testLlmDocumentProvider({ config: llm })
      return NextResponse.json({ ok: result.ok, code: result.ok ? 'connected' : 'failed', message: result.message })
    }
    const config = await getDocumentCaptureTestConfig(gate.user.orgId, body)
    if (!config) return NextResponse.json({ ok: false, code: 'missing' })
    const result = await testAzureDocumentProvider(config)
    return NextResponse.json({ ok: result.ok, code: result.ok ? 'connected' : 'failed' })
  },
});
