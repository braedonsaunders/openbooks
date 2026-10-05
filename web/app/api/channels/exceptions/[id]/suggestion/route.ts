import { NextResponse } from "next/server";
import { z } from "zod";
import { generateText } from "ai";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { getOrgAiConfig } from "@/lib/assistant/ai-config";
import { getModel } from "@/lib/assistant/client";
import {
  CommerceError,
  suggestExceptionFix,
} from "@openbooks/engine/commerce";
import { isUuid } from "@/lib/list-params";
import { guardChannelOrderScope } from "@/lib/channel-scope";

export const runtime = "nodejs";

/**
 * Classified fix proposal for one parked order. Deterministic candidates
 * always ship; when the org configured an assistant model it rewords the
 * explanation and confirms the ranking — when it is missing, slow or
 * failing, the deterministic proposal stands on its own.
 */
export const GET = defineRoute({
  permission: "channels.read",
  feature: "salesChannels",
  params: z.object({ id: z.string() }),
  handler: async ({ authz: gate, params }) => {
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    const outOfScope = await guardChannelOrderScope(gate, id);
    if (outOfScope) return outOfScope;
    try {
      const suggestion = await suggestExceptionFix(gate.user.orgId, id);
      const ranking = await explainWithModel(gate.user.orgId, suggestion.explanation);
      return NextResponse.json({ suggestion, ranking });
    } catch (error) {
      if (error instanceof CommerceError && error.code === "channel_order_unknown") return notFound("record");
      throw error;
    }
  },
});

async function explainWithModel(orgId: string, explanation: string): Promise<{ modelRanked: boolean; note: string | null }> {
  let model: ReturnType<typeof getModel> = null;
  try {
    model = getModel(await getOrgAiConfig(orgId), "fast");
  } catch {
    return { modelRanked: false, note: null };
  }
  if (!model) return { modelRanked: false, note: null };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const result = await generateText({
      model,
      system: "You explain an enterprise-ERP exception fix to a store operator in one plain sentence. Never invent accounts, items or amounts; only reword the given proposal.",
      prompt: `Reword in one plain sentence, keeping every name and number exact: ${explanation}`,
      temperature: 0,
      abortSignal: controller.signal,
    });
    const note = result.text.trim().slice(0, 500);
    return note ? { modelRanked: true, note } : { modelRanked: false, note: null };
  } catch {
    return { modelRanked: false, note: null };
  } finally {
    clearTimeout(timeout);
  }
}
