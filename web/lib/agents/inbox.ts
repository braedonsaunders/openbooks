import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import type { ContinuousCloseAgentKey } from "@openbooks/engine/src/continuous-close-config.ts";
import { can, type Authz } from "../authz";
import { readableContinuousCloseAgents } from "../continuous-close";

/**
 * Agent Workbench inbox read model. ONE resolver backs the /agents inbox, the
 * dashboard tile, and the morning briefing, so every number in the workbench
 * agrees by construction. It reuses the same ai_work_items queries as the
 * continuous-close screen and the finding tools — never a parallel SQL path.
 *
 * Ranking: materiality × confidence × age. Age amplifies (a stale finding
 * bubbles up): score = materiality · confidence · (1 + ageDays / 30).
 * Subsidiary resolves through the finding subject where the subject type is
 * subsidiary-scoped (account subjects today); every other subject lands in
 * the unresolved bucket rather than a guessed subsidiary.
 */

export const INBOX_STATUSES = ["open", "in_review", "resolved", "dismissed"] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];
export const INBOX_SEVERITIES = ["info", "warning", "critical"] as const;
export type InboxSeverity = (typeof INBOX_SEVERITIES)[number];

const DEFAULT_STATUSES: InboxStatus[] = ["open", "in_review"];
export const INBOX_DEFAULT_LIMIT = 25;
export const INBOX_MAX_LIMIT = 100;

export interface AgentInboxFilters {
  packs?: ContinuousCloseAgentKey[];
  severities?: InboxSeverity[];
  statuses?: InboxStatus[];
  query?: string;
  hasProposal?: boolean;
  subsidiaryId?: string;
  /** "What changed since I last looked": only findings detected after this ISO instant. */
  since?: string;
  limit?: number;
  offset?: number;
}

export interface AgentInboxRow {
  id: string;
  pack: ContinuousCloseAgentKey;
  findingType: string;
  severity: InboxSeverity;
  status: InboxStatus;
  confidence: string;
  materiality: string;
  score: number;
  summary: Record<string, unknown>;
  subsidiary: { id: string; name: string } | null;
  hasProposal: boolean;
  evidenceCount: number;
  firstDetectedAt: string;
  lastDetectedAt: string;
}

export interface AgentInboxFacets {
  packs: { key: ContinuousCloseAgentKey; count: number }[];
  severities: { key: InboxSeverity; count: number }[];
  statuses: { key: InboxStatus; count: number }[];
  subsidiaries: { id: string; name: string; count: number }[];
  unresolvedSubsidiary: number;
  withProposals: number;
}

export interface AgentInbox {
  rows: AgentInboxRow[];
  total: number;
  truncated: boolean;
  facets: AgentInboxFacets;
  readablePacks: ContinuousCloseAgentKey[];
}

type InboxRowRaw = {
  id: string;
  agent_key: ContinuousCloseAgentKey;
  finding_type: string;
  severity: InboxSeverity;
  status: InboxStatus;
  confidence: string;
  materiality: string;
  score: string | number;
  summary: Record<string, unknown>;
  subsidiary_id: string | null;
  subsidiary_name: string | null;
  has_proposal: boolean;
  evidence_count: string | number;
  first_detected_at: string | Date;
  last_detected_at: string | Date;
};

function asStatuses(statuses: InboxStatus[] | undefined): InboxStatus[] {
  const picked = (statuses ?? []).filter((s): s is InboxStatus =>
    (INBOX_STATUSES as readonly string[]).includes(s),
  );
  return picked.length > 0 ? picked : DEFAULT_STATUSES;
}

function asSeverities(severities: InboxSeverity[] | undefined) {
  return (severities ?? []).filter((s): s is InboxSeverity =>
    (INBOX_SEVERITIES as readonly string[]).includes(s),
  );
}

function asLimit(limit: number | undefined): number {
  if (!Number.isSafeInteger(limit)) return INBOX_DEFAULT_LIMIT;
  return Math.min(INBOX_MAX_LIMIT, Math.max(1, limit as number));
}

function asOffset(offset: number | undefined): number {
  if (!Number.isSafeInteger(offset)) return 0;
  return Math.max(0, offset as number);
}

export async function loadAgentInbox(authz: Authz, filters: AgentInboxFilters): Promise<AgentInbox> {
  const empty: AgentInbox = {
    rows: [],
    total: 0,
    truncated: false,
    facets: { packs: [], severities: [], statuses: [], subsidiaries: [], unresolvedSubsidiary: 0, withProposals: 0 },
    readablePacks: [],
  };
  // Doorway mirrors the finding tools: without assistant.use nothing is
  // readable, so the inbox is empty rather than an error carrier.
  if (!can(authz, "assistant.use")) return empty;
  const readable = readableContinuousCloseAgents(authz);
  const packs = (filters.packs ?? []).filter((p) => readable.includes(p));
  const agents = filters.packs ? packs : readable;
  const statuses = asStatuses(filters.statuses);
  const severities = asSeverities(filters.severities);
  const limit = asLimit(filters.limit);
  const offset = asOffset(filters.offset);
  const q = filters.query?.trim().slice(0, 200) || undefined;
  const since = filters.since ? new Date(filters.since) : undefined;
  const sinceValid = since && !Number.isNaN(since.getTime()) ? since : undefined;

  if (agents.length === 0) return { ...empty, readablePacks: readable };

  const agentList = sql.join(agents.map((agent) => sql`${agent}`), sql`, `);
  const statusList = sql.join(statuses.map((status) => sql`${status}`), sql`, `);
  const where = sql`w.org_id = ${authz.user.orgId}
    and w.agent_key in (${agentList})
    and w.status in (${statusList})
    ${severities.length > 0 ? sql`and w.severity in (${sql.join(severities.map((s) => sql`${s}`), sql`, `)})` : sql``}
    ${q ? sql`and (w.finding_type ilike ${`%${q}%`} or w.summary::text ilike ${`%${q}%`})` : sql``}
    ${filters.hasProposal === true ? sql`and (w.summary ? 'proposedCommand')` : sql``}
    ${filters.hasProposal === false ? sql`and not (w.summary ? 'proposedCommand')` : sql``}
    ${filters.subsidiaryId ? sql`and subj_acct.subsidiary_id = ${filters.subsidiaryId}` : sql``}
    ${sinceValid ? sql`and w.last_detected_at > ${sinceValid.toISOString()}` : sql``}`;

  const subjectJoin = sql`left join accounts subj_acct
      on subj_acct.id = w.subject_id and w.subject_type = 'account' and subj_acct.org_id = w.org_id
    left join subsidiaries subj_sub on subj_sub.id = subj_acct.subsidiary_id and subj_sub.org_id = w.org_id`;

  const [rows, totalResult, packCounts, severityCounts, statusCounts, subsidiaryCounts, proposalCount] =
    await Promise.all([
      db.execute<InboxRowRaw>(sql`
        select w.id, w.agent_key, w.finding_type, w.severity, w.status,
               w.confidence::text as confidence, w.materiality::text as materiality,
               (w.materiality * w.confidence
                 * (1 + extract(epoch from (now() - w.first_detected_at)) / 2592000))::float8 as score,
               w.summary, subj_sub.id as subsidiary_id, subj_sub.name as subsidiary_name,
               (w.summary ? 'proposedCommand') as has_proposal,
               (select count(*)::int from ai_work_item_evidence e
                 where e.org_id = w.org_id and e.work_item_id = w.id) as evidence_count,
               w.first_detected_at, w.last_detected_at
          from ai_work_items w
          ${subjectJoin}
         where ${where}
         order by score desc, w.last_detected_at desc, w.id
         limit ${limit + 1} offset ${offset}
      `),
      db.execute<{ n: string | number }>(sql`
        select count(*) as n from ai_work_items w ${subjectJoin} where ${where}
      `),
      db.execute<{ agent_key: ContinuousCloseAgentKey; n: string | number }>(sql`
        select w.agent_key, count(*) as n from ai_work_items w ${subjectJoin}
         where ${where} group by w.agent_key
      `),
      db.execute<{ severity: InboxSeverity; n: string | number }>(sql`
        select w.severity, count(*) as n from ai_work_items w ${subjectJoin}
         where ${where} group by w.severity
      `),
      db.execute<{ status: InboxStatus; n: string | number }>(sql`
        select w.status, count(*) as n from ai_work_items w ${subjectJoin}
         where ${where} group by w.status
      `),
      db.execute<{ subsidiary_id: string | null; subsidiary_name: string | null; n: string | number }>(sql`
        select subj_sub.id as subsidiary_id, max(subj_sub.name) as subsidiary_name, count(*) as n
          from ai_work_items w ${subjectJoin}
         where ${where} group by subj_sub.id
      `),
      db.execute<{ n: string | number }>(sql`
        select count(*) as n from ai_work_items w ${subjectJoin}
         where ${where} and (w.summary ? 'proposedCommand')
      `),
    ]);

  const total = Number(totalResult.rows[0]?.n ?? 0);
  const page = rows.rows.slice(0, limit).map((row) => ({
    id: String(row.id),
    pack: row.agent_key,
    findingType: String(row.finding_type),
    severity: row.severity,
    status: row.status,
    confidence: String(row.confidence),
    materiality: String(row.materiality),
    score: Number(row.score),
    summary: (row.summary ?? {}) as Record<string, unknown>,
    subsidiary: row.subsidiary_id
      ? { id: String(row.subsidiary_id), name: String(row.subsidiary_name ?? "") }
      : null,
    hasProposal: Boolean(row.has_proposal),
    evidenceCount: Number(row.evidence_count),
    firstDetectedAt: new Date(row.first_detected_at).toISOString(),
    lastDetectedAt: new Date(row.last_detected_at).toISOString(),
  }));

  return {
    rows: page,
    total,
    truncated: rows.rows.length > limit,
    facets: {
      packs: packCounts.rows.map((r) => ({ key: r.agent_key, count: Number(r.n) })),
      severities: severityCounts.rows.map((r) => ({ key: r.severity, count: Number(r.n) })),
      statuses: statusCounts.rows.map((r) => ({ key: r.status, count: Number(r.n) })),
      subsidiaries: subsidiaryCounts.rows
        .filter((r) => r.subsidiary_id)
        .map((r) => ({ id: String(r.subsidiary_id), name: String(r.subsidiary_name ?? ""), count: Number(r.n) })),
      unresolvedSubsidiary: Number(
        subsidiaryCounts.rows.find((r) => !r.subsidiary_id)?.n ?? 0,
      ),
      withProposals: Number(proposalCount.rows[0]?.n ?? 0),
    },
    readablePacks: readable,
  };
}
