import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { guardPermission, guardUnrestrictedScope } from "../../../../lib/authz";
import { isAiProvider, type AiProvider } from "../../../../lib/assistant/client";
import {
  clearOrgAiKey,
  CONTINUOUS_CLOSE_DISABLED_REMEDY,
  getOrgAiSettings,
  saveOrgAiSettings,
  normalizeAgentSettingsInput,
  type AiSettingsInput,
} from "../../../../lib/assistant/ai-config";

export const runtime = "nodejs";

/** Org AI settings for the admin form — never includes secret material. */
export async function GET() {
  const gate = await guardPermission("admin.ai.manage");
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json(await getOrgAiSettings(gate.user.orgId));
}

/** Save settings; the API key is sealed at rest and only replaced when typed. */
export async function PUT(req: Request) {
  const gate = await guardPermission("admin.ai.manage");
  if (gate instanceof NextResponse) return gate;
  const scopeDenied = guardUnrestrictedScope(gate);
  if (scopeDenied) return scopeDenied;
  let body: Partial<AiSettingsInput> & { provider?: string };
  try {
    const parsedBody = await parseJsonBody(req, jsonObject);
    if (!parsedBody.ok) return parsedBody.response;
    body = parsedBody.data;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const provider: AiProvider = isAiProvider(body.provider) ? body.provider : "anthropic";
  const input: AiSettingsInput = {
    enabled: body.enabled !== false,
    provider,
    modelFast: String(body.modelFast ?? "").trim(),
    modelSmart: String(body.modelSmart ?? "").trim(),
    baseUrl: String(body.baseUrl ?? "").trim(),
    apiKey: String(body.apiKey ?? "").trim() || undefined,
    agents: [],
    documentCapture: {
      enabled: body.documentCapture?.enabled === true,
      provider: "azure_document_intelligence",
      endpoint: String(body.documentCapture?.endpoint ?? "").trim(),
      model: String(body.documentCapture?.model ?? "prebuilt-invoice").trim(),
      confidenceThreshold: String(body.documentCapture?.confidenceThreshold ?? "0.9000").trim(),
      autoCreatePoMatchedDrafts: body.documentCapture?.autoCreatePoMatchedDrafts === true,
      apiKey: String(body.documentCapture?.apiKey ?? "").trim() || undefined,
    },
  };
  try {
    // Pack policies live under Setup → Agents: a provider save that omits the
    // array must leave every policy untouched — normalizing an absent array
    // would default-disable all packs (persistAgentPolicy loops input.agents).
    input.agents = body.agents === undefined ? [] : normalizeAgentSettingsInput(body.agents);
    await saveOrgAiSettings(gate.user.orgId, gate.user.id, input);
  } catch (e) {
    // Enabling a pack while Continuous Close is off refuses by name with a
    // 409 (like the run routes), carrying the remedy instead of the bare
    // code; every other validation failure stays a 422.
    if ((e as Error).message === "feature_disabled") {
      return NextResponse.json({ error: CONTINUOUS_CLOSE_DISABLED_REMEDY }, { status: 409 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 422 });
  }
  return NextResponse.json(await getOrgAiSettings(gate.user.orgId));
}

/** Remove the stored (encrypted) API key. */
export async function DELETE() {
  const gate = await guardPermission("admin.ai.manage");
  if (gate instanceof NextResponse) return gate;
  const scopeDenied = guardUnrestrictedScope(gate);
  if (scopeDenied) return scopeDenied;
  await clearOrgAiKey(gate.user.orgId, gate.user.id);
  return NextResponse.json(await getOrgAiSettings(gate.user.orgId));
}
