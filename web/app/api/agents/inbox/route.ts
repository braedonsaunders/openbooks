import { NextResponse } from "next/server";
import { CONTINUOUS_CLOSE_AGENT_KEYS } from "@openbooks/engine/src/agents/continuous-close-config.ts";
import { guardFeaturePermission } from "../../../../lib/feature-gates";
import { isUuid, pickString } from "../../../../lib/list-params";
import { loadAgentInbox } from "../../../../lib/agents/inbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent Workbench inbox feed. Thin adapter over loadAgentInbox — the same
 * resolver the /agents page renders from — so the triage client and the
 * server page can never disagree. Unknown packs are dropped (fail closed to
 * the readable set); unknown statuses/severities are ignored and malformed
 * paging falls back to defaults inside the resolver.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const gate = await guardFeaturePermission("assistant.use", "continuousClose");
  if (gate instanceof NextResponse) return gate;
  const authz = gate;
  const sp = new URL(request.url).searchParams;
  const one = (key: string): string | undefined =>
    pickString(sp.get(key) ?? undefined);
  const list = (key: string): string[] =>
    sp.get(key)?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];

  const packs = list("packs").filter((p): p is (typeof CONTINUOUS_CLOSE_AGENT_KEYS)[number] =>
    (CONTINUOUS_CLOSE_AGENT_KEYS as readonly string[]).includes(p),
  );
  const q = one("q");
  const hasProposal = one("hasProposal");
  const subsidiary = one("subsidiary");
  const assigned = one("assigned");
  const since = one("since");
  const limit = Number.parseInt(one("limit") ?? "", 10);
  const offset = Number.parseInt(one("offset") ?? "", 10);

  const inbox = await loadAgentInbox(authz, {
    ...(packs.length > 0 ? { packs } : {}),
    ...(list("severities").length > 0
      ? { severities: list("severities") as ("info" | "warning" | "critical")[] }
      : {}),
    ...(list("statuses").length > 0
      ? { statuses: list("statuses") as ("open" | "in_review" | "resolved" | "dismissed")[] }
      : {}),
    ...(q ? { query: q } : {}),
    ...(hasProposal === "true" ? { hasProposal: true as const } : {}),
    ...(hasProposal === "false" ? { hasProposal: false as const } : {}),
    ...(subsidiary && isUuid(subsidiary) ? { subsidiaryId: subsidiary } : {}),
    ...(assigned === "mine" ? { assignedToMe: true as const } : {}),
    ...(assigned === "unassigned" ? { unassignedOnly: true as const } : {}),
    ...(assigned === "overdue" ? { overdueOnly: true as const } : {}),
    ...(since ? { since } : {}),
    ...(Number.isSafeInteger(limit) ? { limit } : {}),
    ...(Number.isSafeInteger(offset) ? { offset } : {}),
  });
  return NextResponse.json({ ok: true, ...inbox });
}
