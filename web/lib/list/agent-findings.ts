import { CONTINUOUS_CLOSE_AGENT_KEYS, type ContinuousCloseAgentKey } from "@openbooks/engine/src/continuous-close-config.ts";
import { isUuid, parseListParams, pickString } from "../list-params";
import type { AgentInboxFilters, InboxSeverity, InboxStatus } from "../agents/inbox";

/**
 * The agent-findings list source — the URL ↔ inbox contract for the Agent
 * Workbench. ONE place parses the workbench query string into the
 * loadAgentInbox filters plus paging/sort, so the page, its tabs, and the
 * triage island can never disagree about what "filtered" means.
 *
 * The universal RecordListView/EntityListView cannot host this list: every
 * finding title and summary line is a loader-computed localized string (per
 * finding type, via the continuousClose namespace), and the default order is
 * the rank score — neither travels through the customization registry. The
 * page therefore composes the same shared blocks (search-input,
 * filter-chips, sortable table, pagination, empty-state) over this source
 * instead.
 */

export const FINDING_SORTS = ["rank", "detected", "materiality", "severity"] as const;
export type FindingSort = (typeof FINDING_SORTS)[number];
export type FindingDir = "asc" | "desc";

/** URL `since` values and their lookback windows. Values are stable keys —
 *  the loader maps them to ISO instants, so shared links never rot. */
export const FINDING_SINCE_WINDOWS = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
} as const;
export type FindingSince = keyof typeof FINDING_SINCE_WINDOWS;

// Local literal mirrors of the inbox's INBOX_SEVERITIES / INBOX_STATUSES.
// Runtime-importing them from ../agents/inbox would drag the drizzle pool
// into every unit test of this pure module; the sync test below pins them
// to the read model instead.
const SEVERITIES: readonly InboxSeverity[] = ["info", "warning", "critical"];
const STATUSES: readonly InboxStatus[] = ["open", "in_review", "resolved", "dismissed"];

const AGENT_KEYS: readonly string[] = CONTINUOUS_CLOSE_AGENT_KEYS;

export interface AgentFindingsQuery {
  /** Filters for loadAgentInbox, including limit/offset/sort/dir. */
  filters: AgentInboxFilters;
  sort: FindingSort;
  dir: FindingDir;
  page: number;
  perPage: number;
}

function asPackList(raw: string | undefined): ContinuousCloseAgentKey[] | undefined {
  if (!raw) return undefined;
  const packs = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is ContinuousCloseAgentKey => (AGENT_KEYS as readonly string[]).includes(s));
  return packs.length > 0 ? packs : undefined;
}

function asOne<T extends string>(raw: string | undefined, allowed: readonly T[]): T | undefined {
  return raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : undefined;
}

/** Map a stable `since` window key to an ISO lookback instant. */
export function findingsSinceIso(since: FindingSince | undefined, now: number = Date.now()): string | undefined {
  if (!since || !(since in FINDING_SINCE_WINDOWS)) return undefined;
  return new Date(now - FINDING_SINCE_WINDOWS[since]).toISOString();
}

export function parseAgentFindingsParams(
  sp: Record<string, string | string[] | undefined>,
): AgentFindingsQuery {
  const params = parseListParams(sp, {
    sort: "rank" as FindingSort,
    dir: "desc" as FindingDir,
    perPage: 25,
    allowedSorts: FINDING_SORTS,
  });

  const rawSeverity = pickString(sp.severity);
  const severity = asOne(rawSeverity, SEVERITIES);
  const rawStatus = pickString(sp.status);
  const status = asOne(rawStatus, STATUSES);
  const rawSubsidiary = pickString(sp.subsidiary);
  const subsidiary = rawSubsidiary && isUuid(rawSubsidiary) ? rawSubsidiary : undefined;
  const assigned = pickString(sp.assigned);
  const rawSince = pickString(sp.since);
  const sinceKey = asOne(rawSince, Object.keys(FINDING_SINCE_WINDOWS) as FindingSince[]);

  const filters: AgentInboxFilters = {
    limit: params.perPage,
    offset: (params.page - 1) * params.perPage,
    sort: params.sort,
    dir: params.dir,
  };
  const packs = asPackList(pickString(sp.packs));
  if (packs) filters.packs = packs;
  if (severity) filters.severities = [severity];
  if (status) filters.statuses = [status];
  if (params.q) filters.query = params.q;
  if (pickString(sp.proposals) === "true") filters.hasProposal = true as const;
  if (subsidiary) filters.subsidiaryId = subsidiary;
  const sinceIso = findingsSinceIso(sinceKey);
  if (sinceIso) filters.since = sinceIso;
  if (assigned === "mine") filters.assignedToMe = true as const;
  else if (assigned === "unassigned") filters.unassignedOnly = true as const;
  else if (assigned === "overdue") filters.overdueOnly = true as const;

  return { filters, sort: params.sort, dir: params.dir, page: params.page, perPage: params.perPage };
}
