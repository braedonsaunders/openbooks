import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { NextResponse } from "next/server";
import {
  getDocumentCaptureTestConfig,
  getLlmCaptureTestConfig,
} from "@openbooks/engine/payables/ap-capture-config";
import {
  DocumentEndpointError,
  testAzureDocumentProvider,
} from "@openbooks/engine/payables/ap-capture";
import { testLlmDocumentProvider } from "@openbooks/engine/payables/document-capture-llm";

const requestBodySchema = z
  .object({
    provider: z.enum(["azure_document_intelligence", "llm_vision"]).optional(),
    // The AI provider section as typed, so the AI model is tested before it is saved.
    aiProvider: z.string().trim().min(1).max(40).optional(),
    aiApiKey: z.string().min(1).max(4000).optional(),
    aiBaseUrl: z.string().max(2000).optional(),
    aiModelSmart: z.string().trim().max(200).optional(),
    apiKey: z.string().min(1).optional(),
    endpoint: z.string().url().optional(),
    model: z.string().trim().min(1).max(200).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "At least one field must be provided.",
  });

export const runtime = "nodejs";

export const POST = defineRoute({
  permission: "admin.ai.manage",
  feature: {
    none: "Administrators can test unsaved document capture credentials before document capture is enabled.",
  },
  body: requestBodySchema,
  handler: async ({ body, authz: routeAuthz }) => {
    const gate = routeAuthz;

    // The AI model provider is tested with the key, provider, base URL and
    // models as typed (blank fields fall back to the saved settings), and
    // Azure with the form's or stored key. Nothing typed is stored.
    if (body.provider === "llm_vision") {
      let llm: Awaited<ReturnType<typeof getLlmCaptureTestConfig>>;
      try {
        llm = await getLlmCaptureTestConfig(gate.user.orgId, {
          provider: body.aiProvider,
          apiKey: body.aiApiKey,
          baseUrl: body.aiBaseUrl,
          modelSmart: body.aiModelSmart,
          model: body.model,
        });
      } catch (error) {
        // An unusable base URL names its own fault; the key itself is never
        // part of the answer. Anything else answers through the shared mapping.
        if (error instanceof DocumentEndpointError)
          return NextResponse.json({
            ok: false,
            code: "failed",
            message: error.message.slice(0, 180),
          });
        throw error;
      }
      if (!llm) return NextResponse.json({ ok: false, code: "missingAi" });
      const result = await testLlmDocumentProvider({ config: llm });
      return NextResponse.json({
        ok: result.ok,
        code: result.ok ? "connected" : "failed",
        message: result.message,
      });
    }
    const config = await getDocumentCaptureTestConfig(gate.user.orgId, body);
    if (!config) return NextResponse.json({ ok: false, code: "missing" });
    const result = await testAzureDocumentProvider(config);
    return NextResponse.json({ ok: result.ok, code: result.ok ? "connected" : "failed" });
  },
});
