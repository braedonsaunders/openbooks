import { NextResponse } from "next/server";
import { guardPermission } from "../../../../lib/authz";
import { isAiProvider, type AiProvider } from "../../../../lib/assistant/client";
import {
  clearOrgAiKey,
  getOrgAiSettings,
  saveOrgAiSettings,
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
  let body: Partial<AiSettingsInput> & { provider?: string };
  try {
    body = await req.json();
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
  };
  try {
    await saveOrgAiSettings(gate.user.orgId, gate.user.id, input);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 422 });
  }
  return NextResponse.json(await getOrgAiSettings(gate.user.orgId));
}

/** Remove the stored (encrypted) API key. */
export async function DELETE() {
  const gate = await guardPermission("admin.ai.manage");
  if (gate instanceof NextResponse) return gate;
  await clearOrgAiKey(gate.user.orgId, gate.user.id);
  return NextResponse.json(await getOrgAiSettings(gate.user.orgId));
}
