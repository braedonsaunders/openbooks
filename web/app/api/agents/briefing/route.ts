import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { AIDisabledError } from "../../../../lib/assistant/client";
import {
  generateBriefing,
  loadBriefing,
  sendBriefingEmail,
} from "../../../../lib/agents/briefing";
const postBodySchema0 = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("generate") }),
  z.strictObject({ action: z.literal("send") }),
]);

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
export const GET = defineRoute({
  permission: "assistant.use",
  feature: "continuousClose",
  handler: async ({ authz: gate }) => {
    const { briefing, aiEnabled, role } = await loadBriefing(gate);
    return NextResponse.json({ ok: true, role, aiEnabled, briefing });
  },
});

export const POST = defineRoute({
  permission: "assistant.use",
  feature: "continuousClose",
  body: postBodySchema0,
  handler: async ({ authz: gate, body }) => {
    if (body.action === "generate") {
      try {
        const briefing = await generateBriefing(gate);
        return NextResponse.json({ ok: true, briefing });
      } catch (error) {
        if (error instanceof AIDisabledError) {
          return NextResponse.json(
            { error: "ai_not_configured" },
            { status: 503 },
          );
        }
        if (error instanceof Error && error.message === "briefing_empty") {
          return NextResponse.json(
            { error: "briefing_empty" },
            { status: 502 },
          );
        }
        console.error("[agents/briefing] generate failed", error);
        return NextResponse.json({ error: "briefing_failed" }, { status: 500 });
      }
    }
    if (body.action === "send") {
      const { briefing } = await loadBriefing(gate);
      if (!briefing)
        return NextResponse.json({ error: "no_briefing" }, { status: 404 });
      const result = await sendBriefingEmail(gate, briefing.text);
      return NextResponse.json({ ok: true, ...result });
    }
    return NextResponse.json({ error: "invalid_action" }, { status: 422 });
  },
});
