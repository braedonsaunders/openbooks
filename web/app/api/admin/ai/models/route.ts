import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { guardPermission } from "../../../../../lib/authz";
import { isAiProvider, type AiProvider } from "../../../../../lib/assistant/client";
import { getOrgAiConfig } from "../../../../../lib/assistant/ai-config";
import { listModels } from "../../../../../lib/assistant/models";

export const runtime = "nodejs";

/**
 * List the models a provider exposes, for the settings dropdowns. Uses the key
 * typed into the form; falls back to the saved (encrypted) key when the
 * provider is unchanged. The key never leaves the server in either direction.
 */
export async function POST(req: Request) {
  const gate = await guardPermission("admin.ai.manage");
  if (gate instanceof NextResponse) return gate;
  let body: { provider?: string; baseUrl?: string; apiKey?: string };
  try {
    const parsedBody = await parseJsonBody(req, jsonObject);
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
    return NextResponse.json({
      ok: false,
      models: [],
      message: "Enter an API key for this provider to load its models.",
    });
  }
  try {
    const models = await listModels({ provider, apiKey, baseUrl: baseUrl || null });
    if (!models.length) {
      return NextResponse.json({
        ok: false,
        models: [],
        message: "The provider returned no models — enter the id manually.",
      });
    }
    return NextResponse.json({ ok: true, models });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      models: [],
      message: e instanceof Error ? e.message.slice(0, 180) : "Could not load models.",
    });
  }
}
