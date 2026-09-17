import { NextResponse } from "next/server";
import { guardPermission } from "../../../../../lib/authz";
import { isAiProvider, pingModel } from "../../../../../lib/assistant/client";
import { getOrgAiConfig } from "../../../../../lib/assistant/ai-config";

export const runtime = "nodejs";

/**
 * Live test of the config — sends a tiny prompt to the fast model. Verifies
 * what is in the form: the request may carry a typed (unsaved) provider, base
 * URL, key and model, so a key can be checked before it is persisted. Any
 * field left blank falls back to the saved config for the same provider
 * (a saved key belongs to its own provider and never crosses over).
 */
export async function POST(req: Request) {
  const gate = await guardPermission("admin.ai.manage");
  if (gate instanceof NextResponse) return gate;
  let body: { provider?: unknown; baseUrl?: unknown; apiKey?: unknown; modelFast?: unknown } = {};
  try {
    const parsed: unknown = await req.json();
    if (parsed && typeof parsed === "object") body = parsed as typeof body;
  } catch {
    body = {};
  }
  const saved = await getOrgAiConfig(gate.user.orgId);
  const provider = isAiProvider(body.provider) ? body.provider : (saved?.provider ?? "anthropic");
  const sameProvider = saved?.provider === provider;
  const typed = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
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
}
