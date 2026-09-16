import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// The dashboard "Agent findings" tile links to /agents — the ranked inbox —
// so its numbers must BE the inbox scope: open/in_review findings over the
// caller's readable packs, open carriers with a proposal, and the latest
// detection instant as "last run". Pack visibility is the doorway: without
// assistant.use (plus a module grant per pack) the readable set is empty and
// the tile counts zero instead of leaking org-wide numbers.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { loadDashboardMetrics, pruneDashboardMetrics } = await import("./_metrics.ts");
const { canSeeWidget } = await import("./_widget-access.ts");
type Authz = import("@/lib/authz.ts").Authz;

const DB = !!process.env.OPENBOOKS_DB_URL;

function authzFor(orgId: string, userId: string, permissions: string[]): Authz {
  return {
    user: {
      id: userId, email: `${userId}@test`, name: "Agent Watcher", orgId,
      roles: [{ key: "staff", name: "staff" }],
      envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  };
}

async function seedFinding(orgId: string, row: {
  agent?: string; status?: string; summary?: unknown; lastDetected?: string;
}): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into ai_work_items
    (id, org_id, agent_key, finding_type, detector_version, fingerprint, severity, status,
     confidence, materiality, subject_type, subject_id, summary, first_detected_at, last_detected_at)
    values (${id}, ${orgId}, ${row.agent ?? 'accounting'}, 'unmatched_bank_activity',
      'test', ${`fp-${id}`}, 'warning', ${row.status ?? 'open'},
      '1', '1000', null, null, ${JSON.stringify(row.summary ?? {})}::jsonb,
      ${row.lastDetected ?? new Date(Date.now() - 86_400_000).toISOString()}::timestamptz,
      ${row.lastDetected ?? new Date(Date.now() - 86_400_000).toISOString()}::timestamptz)`);
  return id;
}

test("agent findings tile counts the inbox scope, not the org", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const other = await createScratchOrg();
  try {
    const fresh = new Date().toISOString();
    const stale = new Date(Date.now() - 7 * 86_400_000).toISOString();
    // Two open readable findings, one carrying a proposal.
    await seedFinding(org.orgId, { lastDetected: stale });
    await seedFinding(org.orgId, {
      lastDetected: fresh,
      summary: { proposedCommand: { tool: "match_bank_line", input: {}, label: "Match" } },
    });
    // Resolved findings are done — never on the tile.
    await seedFinding(org.orgId, { status: "resolved", lastDetected: fresh });
    // Unreadable pack (finance needs reports.read): invisible to this caller.
    await seedFinding(org.orgId, { agent: "finance", lastDetected: fresh });
    // Other org: invisible everywhere.
    await seedFinding(other.orgId, { lastDetected: fresh });

    const reader = await createScratchUser(org.orgId, "Watcher", "b06_tile_watcher");
    const authz = authzFor(org.orgId, reader as unknown as string, ["assistant.use", "gl.read", "dashboard.read"]);
    assert.equal(canSeeWidget(authz, "kpi-agent-findings"), true);
    const metrics = await loadDashboardMetrics(authz);
    assert.equal(metrics.agentFindingsOpen, 2);
    assert.equal(metrics.agentFindingsProposals, 1);
    assert.equal(metrics.agentFindingsLastRun, new Date(fresh).toISOString());
    // The tile's pruned payload carries exactly its three fields.
    const pruned = pruneDashboardMetrics(metrics, ["kpi-agent-findings"]);
    assert.equal(pruned.agentFindingsOpen, 2);
    assert.equal(pruned.pendingApprovals, 0);

    // No assistant.use: the tile hides and the counts stay zero.
    const blind = authzFor(org.orgId, reader as unknown as string, ["gl.read", "dashboard.read"]);
    assert.equal(canSeeWidget(blind, "kpi-agent-findings"), false);
    const blindMetrics = await loadDashboardMetrics(blind);
    assert.equal(blindMetrics.agentFindingsOpen, 0);
    assert.equal(blindMetrics.agentFindingsProposals, 0);
    assert.equal(blindMetrics.agentFindingsLastRun, null);
  } finally {
    await dropScratchOrg(org.orgId);
    await dropScratchOrg(other.orgId);
  }
});
