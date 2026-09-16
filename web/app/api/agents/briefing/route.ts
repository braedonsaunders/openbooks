import { NextResponse } from "next/server";
import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { guardFeaturePermission } from "../../../../lib/feature-gates";
import { AIDisabledError } from "../../../../lib/assistant/client";
import { generateBriefing, loadBriefing, sendBriefingEmail } from "../../../../lib/agents/briefing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Generation runs one bounded background turn (8 read-tool steps max).
export const maxDuration = 180;

/**
 * Morning briefing feed. GET serves the cached per-day-per-user narrative
 * (null when today has none yet); POST generates it through the assistant
 * runtime or emails the cached copy to the viewer. Thin adapters over the
 * briefing library — no prompt or persistence logic lives here.
 */
export async function GET(): Promise<NextResponse> {
  const gate = await guardFeaturePermission("assistant.use", "continuousClose");
  if (gate instanceof NextResponse) return gate;
  const { briefing, aiEnabled, role } = await loadBriefing(gate);
  return NextResponse.json({ ok: true, role, aiEnabled, briefing });
}

export async function POST(request: Request): Promise<NextResponse> {
  const gate = await guardFeaturePermission("assistant.use", "continuousClose");
  if (gate instanceof NextResponse) return gate;
  let body: { action?: unknown };
  try {
    const parsed = await parseJsonBody(request, jsonObject);
    if (!parsed.ok) return parsed.response;
    body = parsed.data as { action?: unknown };
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.action === "generate") {
    try {
      const briefing = await generateBriefing(gate);
      return NextResponse.json({ ok: true, briefing });
    } catch (error) {
      if (error instanceof AIDisabledError) {
        return NextResponse.json({ error: "ai_not_configured" }, { status: 503 });
      }
      if (error instanceof Error && error.message === "briefing_empty") {
        return NextResponse.json({ error: "briefing_empty" }, { status: 502 });
      }
      console.error("[agents/briefing] generate failed", error);
      return NextResponse.json({ error: "briefing_failed" }, { status: 500 });
    }
  }
  if (body.action === "send") {
    const { briefing } = await loadBriefing(gate);
    if (!briefing) return NextResponse.json({ error: "no_briefing" }, { status: 404 });
    const result = await sendBriefingEmail(gate, briefing.text);
    return NextResponse.json({ ok: true, ...result });
  }
  return NextResponse.json({ error: "invalid_action" }, { status: 422 });
}
