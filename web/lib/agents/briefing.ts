import "server-only";
import { sql } from "drizzle-orm";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import type { Authz } from "../authz";
import { can } from "../authz";
import { resolvedFeatureState } from "../features";
import {
  appendMessage,
  createConversation,
  listConversations,
  recentMessages,
} from "../ai-conversations";
import { getOrgAiConfig } from "../assistant/ai-config";
import { runBackgroundAgent } from "../assistant/agent";
import { AIDisabledError, getModel } from "../assistant/client";
import { buildToolRegistry } from "../assistant/registry";
import { assistantSystemPrompt } from "../assistant/system-prompt";
import { orgFiscalContext } from "../fiscal";
import { loadAgentInbox } from "./inbox";

/**
 * Morning briefing: a role-shaped narrative over the same inbox resolver the
 * workbench renders, produced by the assistant runtime with READ tools only.
 *
 * Cached per day per user with zero schema: one ai_conversations row per
 * user-day (scope `briefing`, title `briefing <business-date>`) carrying the
 * generated text as its assistant message. Owner-only by construction
 * (list/append both filter user_id), so a briefing can never leak across
 * users. "Send as email" reuses the jobs email queue with the shared
 * notification builder — best-effort, honestly reported.
 */

export const BRIEFING_SCOPE = "briefing";
export const BRIEFING_MAX_STEPS = 8;

export type BriefingRole = "owner" | "controller" | "ap_clerk" | "ar_clerk";

/** Role shapes the briefing's focus. Clerks see their lane; stewards see all. */
export function briefingRole(authz: Authz): BriefingRole {
  if (authz.user.isSuperAdmin || can(authz, "admin.ai.manage") || can(authz, "admin.setup.manage")) {
    return "owner";
  }
  const readsLedger = can(authz, "gl.read") || can(authz, "reports.read") || can(authz, "budgets.read");
  const readsAp = can(authz, "ap.read");
  const readsAr = can(authz, "ar.read");
  if (readsAp && !readsLedger && !readsAr) return "ap_clerk";
  if (readsAr && !readsLedger && !readsAp) return "ar_clerk";
  return "controller";
}

const ROLE_FOCUS: Record<BriefingRole, string> = {
  owner:
    "The reader owns the business. Lead with overall control health (how many open findings, total materiality at risk), cash position, and anything needing THEIR decision; keep it to five bullets.",
  controller:
    "The reader is the controller. Lead with close readiness and the highest-materiality findings first, then cash and overdue positions; name the exact next action per item.",
  ap_clerk:
    "The reader is an AP clerk. Focus on payables findings, bills due, and discount opportunities; skip AR, payroll, and tax detail.",
  ar_clerk:
    "The reader is an AR clerk. Focus on collections findings, overdue customers, and receipts; skip payables, payroll, and tax detail.",
};

export interface CachedBriefing {
  text: string;
  generatedAt: string;
  role: BriefingRole;
}

function briefingTitle(businessDate: string): string {
  return `briefing ${businessDate}`;
}

/** Read-only view of the caller's grants: the model sees what they may see, never more. */
export function briefingReadAuthz(authz: Authz): Authz {
  return {
    ...authz,
    permissions: new Set([...authz.permissions].filter((perm) => perm !== "assistant.write")),
  };
}

export async function loadBriefing(authz: Authz): Promise<{ briefing: CachedBriefing | null; aiEnabled: boolean; role: BriefingRole }> {
  const role = briefingRole(authz);
  const aiConfig = await getOrgAiConfig(authz.user.orgId);
  const aiEnabled = getModel(aiConfig, "smart") !== null;
  const today = await businessToday(authz.user.orgId);
  const conversations = await listConversations(authz, BRIEFING_SCOPE, 5);
  const match = conversations.find((c) => c.title === briefingTitle(today));
  if (!match) return { briefing: null, aiEnabled, role };
  const messages = await recentMessages(authz, match.id);
  const last = [...messages].reverse().find(
    (m) => m.role === "assistant" && (m.data as { kind?: unknown } | null)?.kind === "briefing",
  );
  if (!last) return { briefing: null, aiEnabled, role };
  return {
    briefing: {
      text: last.content,
      generatedAt: new Date(last.createdAt).toISOString(),
      role: ((last.data as { role?: unknown } | null)?.role as BriefingRole | undefined) ?? role,
    },
    aiEnabled,
    role,
  };
}

function findingLine(row: {
  findingType: string;
  severity: string;
  materiality: string;
  confidence: string;
  summary: Record<string, unknown>;
  id: string;
}): string {
  const summary = JSON.stringify(row.summary).slice(0, 300);
  return `- [${row.severity}] ${row.findingType} — materiality ${row.materiality}, confidence ${row.confidence} — /agents?item=${row.id} — ${summary}`;
}

export async function generateBriefing(authz: Authz): Promise<CachedBriefing> {
  const aiConfig = await getOrgAiConfig(authz.user.orgId);
  if (!getModel(aiConfig, "smart")) throw new AIDisabledError();
  const role = briefingRole(authz);
  const today = await businessToday(authz.user.orgId);
  const features = await resolvedFeatureState(authz.user.orgId);
  const readAuthz = briefingReadAuthz(authz);
  const inbox = await loadAgentInbox(readAuthz, { limit: 10 });
  const org = await db.execute<{ base_currency: string; name: string }>(
    sql`select base_currency, name from orgs where id = ${authz.user.orgId}`,
  );
  const system =
    assistantSystemPrompt({
      orgName: aiConfig?.org?.name ?? null,
      baseCurrency: org.rows[0]?.base_currency ?? null,
      userName: authz.user.name,
      today,
      fiscal: await orgFiscalContext(today, authz.user.orgId),
      canWrite: false,
      features,
    }) +
    `\nYou are writing the morning briefing, not chatting. ${ROLE_FOCUS[role]}` +
    `\nEvery figure you quote must come from a tool result; link each one to the exact record or /agents?item={id} the tool returned. ` +
    `Never invent amounts, counts, or dates. Keep it under 400 words.`;
  const prompt = [
    `Write today's briefing for ${today}.`,
    `Open findings by rank (materiality, confidence, evidence):`,
    ...inbox.rows.map(findingLine),
    inbox.total > inbox.rows.length ? `…and ${inbox.total - inbox.rows.length} more in /agents.` : ``,
    `Use read tools (cash_position, list_open_items, aging) for the cash position and due items the snapshot lacks, then write the briefing.`,
  ]
    .filter(Boolean)
    .join("\n");
  const result = await runBackgroundAgent(aiConfig, {
    prompt,
    system,
    tools: buildToolRegistry(readAuthz, features),
    tier: "fast",
    maxSteps: BRIEFING_MAX_STEPS,
  });
  const text = result.text.trim();
  if (!text) throw new Error("briefing_empty");
  const conversationId = await createConversation(authz, BRIEFING_SCOPE, briefingTitle(today));
  await appendMessage(authz, {
    conversationId,
    role: "assistant",
    content: text,
    data: { v: 1, kind: "briefing", date: today, role },
  });
  return { text, generatedAt: new Date().toISOString(), role };
}

export async function sendBriefingEmail(
  authz: Authz,
  text: string,
): Promise<{ emailed: boolean; emailError?: string }> {
  try {
    const org = await db.execute<{ name: string }>(
      sql`select name from orgs where id = ${authz.user.orgId}`,
    );
    const [{ enqueueEmail }] = await Promise.all([import("@openbooks/jobs")]);
    const { flowNotificationEmail } = await import("@openbooks/emails");
    const mail = flowNotificationEmail({
      orgName: org.rows[0]?.name ?? "OpenBooks",
      subject: "Morning briefing",
      body: text.slice(0, 8000),
    });
    await (enqueueEmail as (data: Record<string, unknown>) => Promise<unknown>)({
      orgId: authz.user.orgId,
      to: authz.user.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      meta: { category: "agent-briefing" },
    });
    return { emailed: true };
  } catch (error) {
    return { emailed: false, emailError: error instanceof Error ? error.message : "email_failed" };
  }
}
