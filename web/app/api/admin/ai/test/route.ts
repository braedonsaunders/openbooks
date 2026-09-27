import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { z } from "zod";

import { isAiProvider, pingModel } from "../../../../../lib/assistant/client";
import { getOrgAiConfig } from "../../../../../lib/assistant/ai-config";


export const runtime = "nodejs";

const aiTestBody = z.object({
  provider: z.enum(["anthropic", "openai", "google", "openrouter", "groq", "xai", "deepseek", "mistral", "custom"]).optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  modelFast: z.string().optional(),
}).refine((body) => Object.keys(body).length > 0, { message: "At least one field must be provided." });

/**
 * Live test of the config — sends a tiny prompt to the fast model. Verifies
 * what is in the form: the request may carry a typed (unsaved) provider, base
 * URL, key and model, so a key can be checked before it is persisted. Any
 * field left blank falls back to the saved config for the same provider
 * (a saved key belongs to its own provider and never crosses over).
 */


export const POST = defineRoute({
  permission: "admin.ai.manage",
  feature: { none: "This endpoint has no single route-wide feature gate; its handler retains any action-specific feature checks." },
  body: aiTestBody,
  handler: async ({ body, authz: routeAuthz }) => {

    const gate = routeAuthz;

    // One zod boundary for JSON bodies, like every other mutation route: a
    // hand-typed parse silently accepts shapes the shared boundary would
    // refuse, and this route fetches caller-supplied baseUrl endpoints
    // server-side, so its inputs deserve the same refusal discipline.



    const saved = await getOrgAiConfig(gate.user.orgId);
    const provider = isAiProvider(body.provider) ? body.provider : (saved?.provider ?? "anthropic");
    const sameProvider = saved?.provider === provider;
    const typed = (v: string | undefined) => (v && v.trim() ? v.trim() : "");
    const apiKey = typed(body.apiKey) || (sameProvider ? (saved?.apiKey ?? "") : "");
    const baseUrl = typed(body.baseUrl) || (sameProvider ? (saved?.baseUrl ?? "") : "");
    const modelFast = typed(body.modelFast) || (sameProvider ? (saved?.modelFast ?? "") : "");
    const result = await pingModel({
      provider,
      apiKey,
      baseUrl: baseUrl || null,
      modelFast: modelFast || null,
    });
    return NextResponse.json(result);
  },
});
