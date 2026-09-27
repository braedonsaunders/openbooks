import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { guardPermission } from "../../../../../lib/authz";
import { isAiProvider, type AiProvider } from "../../../../../lib/assistant/client";
import { getOrgAiConfig } from "../../../../../lib/assistant/ai-config";
import { listModelsCached } from "../../../../../lib/assistant/models";
import { classifyModelsError } from "../../../../../lib/assistant/models-error";

const requestBodySchema = z.object({
  "apiKey": z.string().optional(),
  "baseUrl": z.string().optional(),
  "provider": z.enum(["anthropic", "openai", "google", "openrouter", "groq", "xai", "deepseek", "mistral", "custom"]).optional(),
  "refresh": z.boolean().optional(),
});


export const runtime = "nodejs";

/**
 * List the models a provider exposes, for the settings dropdowns. Uses the key
 * typed into the form; falls back to the saved (encrypted) key when the
 * provider is unchanged. The key never leaves the server in either direction.
 */
async function legacyPOST(req: Request) {
  const gate = await guardPermission("admin.ai.manage");
  if (gate instanceof NextResponse) return gate;
  let body: { provider?: string; baseUrl?: string; apiKey?: string; refresh?: boolean };
  try {
    const parsedBody = await parseJsonBody(req, requestBodySchema);
    if (!parsedBody.ok) return parsedBody.response;
    body = parsedBody.data;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const provider: AiProvider = isAiProvider(body.provider) ? body.provider : "anthropic";
  let apiKey = String(body.apiKey ?? "").trim();
  let baseUrl = String(body.baseUrl ?? "").trim();
  if (!apiKey) {
    const saved = await getOrgAiConfig(gate.user.orgId);
    if (saved && saved.provider === provider) {
      apiKey = saved.apiKey;
      if (!baseUrl) baseUrl = saved.baseUrl ?? "";
    }
  }
  if (!apiKey) {
    return NextResponse.json({ ok: false, models: [], code: "missingKey" });
  }
  try {
    const models = await listModelsCached({ provider, apiKey, baseUrl: baseUrl || null }, body.refresh === true);
    if (!models.length) {
      return NextResponse.json({ ok: false, models: [], code: "empty" });
    }
    return NextResponse.json({ ok: true, models });
  } catch (e) {
    // Never forward the raw upstream body (a `401 … — {…}` JSON blob): the
    // form renders a localized message from the code instead.
    const classified = classifyModelsError(e);
    return NextResponse.json({ ok: false, models: [], ...classified });
  }
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
