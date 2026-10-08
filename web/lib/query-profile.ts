import "server-only";
import { appendFile } from "node:fs/promises";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { registerQueryObserver } from "@openbooks/engine/src/platform/query-observer.ts";

/**
 * Per-route database profile for the running web server.
 *
 * Enabled with OPENBOOKS_QUERY_PROFILE=1 and written to
 * OPENBOOKS_QUERY_PROFILE_FILE. Every statement the connection layer sends is
 * attributed to the Next request whose work issued it (through Next's
 * per-request WorkStore, the same storage request-org.ts keys tenant scope
 * on). Each minute the profiler appends one JSON line covering the requests
 * that completed in that window: per route, the request count, mean and p95
 * database round trips and summed database time per request, and the ten
 * statements most often repeated within a single request and the ten
 * statement shapes consuming the most database time.
 *
 * Statements are recorded only in normalized form: literals, numbers and
 * placeholders become `?`, so neither parameter values nor inline tenant data
 * ever reach the profile. When the flag is off this module is never loaded
 * and the connection layer observes nothing.
 */

const FLUSH_INTERVAL_MS = 60_000;
/**
 * Next exposes no completion signal to code running inside a request, so a
 * request's profile is closed once it has issued no statement for this long.
 * Streaming responses that resolve late boundaries stay one request as long
 * as their gaps are shorter than this.
 */
const REQUEST_IDLE_MS = 10_000;
const TOP_REPEATED_STATEMENTS = 10;
/** Bounds memory against unusual traffic; round trips and time still count beyond it. */
const MAX_DISTINCT_STATEMENTS = 1_000;
const MAX_STATEMENT_LENGTH = 600;
const NORMALIZED_CACHE_LIMIT = 5_000;

export interface QueryProfileRequest {
  /** Identity of one request; held only until the request's profile closes. */
  key: object;
  route: string;
}

export interface QueryProfileOptions {
  currentRequest: () => QueryProfileRequest | undefined;
  now?: () => number;
  requestIdleMs?: number;
}

export interface RepeatedStatement {
  statement: string;
  /** Executions beyond the first within the same request, summed over requests. */
  repeats: number;
  executions: number;
  /** Requests that ran the statement more than once. */
  requestsRepeating: number;
  maxPerRequest: number;
  totalDbMs: number;
}

export interface RouteQueryProfile {
  route: string;
  requests: number;
  roundTrips: { mean: number; p95: number; max: number };
  dbMs: { mean: number; p95: number; max: number; total: number };
  repeatedStatements: RepeatedStatement[];
  slowStatements: { statement: string; executions: number; totalDbMs: number; meanDbMs: number }[];
}

export interface QueryProfileSummary {
  windowStart: string;
  windowEnd: string;
  routes: RouteQueryProfile[];
  /** Statements issued outside any request: boot, background timers, detached work. */
  unattributed: { roundTrips: number; dbMs: number };
  /** Requests still issuing statements; they are reported in a later window. */
  openRequests: number;
}

type StatementTally = { executions: number; dbMs: number };

type RequestProfile = {
  route: string;
  roundTrips: number;
  dbMs: number;
  lastAt: number;
  statements: Map<string, StatementTally>;
};

type RouteWindow = {
  roundTrips: number[];
  dbMs: number[];
  statements: Map<string, Omit<RepeatedStatement, "statement">>;
};

// One alternation scanned left to right, so a quote or comment marker inside
// another token is consumed by the token that starts first.
const SQL_TOKENS =
  /\/\*[\s\S]*?\*\/|--[^\n]*|"(?:[^"]|"")*"|[eE]'(?:[^'\\]|''|\\[\s\S])*'|'(?:[^']|'')*'|\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$|\$\d+|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;

/**
 * Reduce a statement to its shape: comments removed, string, dollar-quoted
 * and numeric literals and bind placeholders replaced with `?`, lists of
 * values collapsed, whitespace folded. Quoted identifiers are kept because
 * they name schema, not data.
 */
export function normalizeStatement(text: string): string {
  const shape = text
    .replace(SQL_TOKENS, (token) => {
      if (token.startsWith("/*") || token.startsWith("--")) return " ";
      if (token.startsWith('"')) return token;
      return "?";
    })
    .replace(/\s+/g, " ")
    .replace(/\?(?:\s*,\s*\?)+/g, "?, ...")
    .replace(/\((?:\?|\?, \.\.\.)\)(?:\s*,\s*\((?:\?|\?, \.\.\.)\))+/g, "(?, ...), ...")
    .trim();
  return shape.length > MAX_STATEMENT_LENGTH ? `${shape.slice(0, MAX_STATEMENT_LENGTH)}…` : shape;
}

const round = (value: number) => Math.round(value * 100) / 100;

/** Nearest-rank summary of a non-empty sample (a route window holds at least one request). */
function distribution(values: number[]): { mean: number; p95: number; max: number; total: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const rank = Math.max(1, Math.ceil(sorted.length * 0.95));
  return {
    mean: round(total / sorted.length),
    p95: round(sorted[rank - 1]!),
    max: round(sorted[sorted.length - 1]!),
    total: round(total),
  };
}

export function createQueryProfile(options: QueryProfileOptions) {
  const now = options.now ?? (() => Date.now());
  const requestIdleMs = options.requestIdleMs ?? REQUEST_IDLE_MS;
  const open = new Map<object, RequestProfile>();
  const normalized = new Map<string, string>();
  let routes = new Map<string, RouteWindow>();
  let unattributed = { roundTrips: 0, dbMs: 0 };
  let windowStart = now();

  function shapeOf(statement: string): string {
    let shape = normalized.get(statement);
    if (shape === undefined) {
      if (normalized.size >= NORMALIZED_CACHE_LIMIT) normalized.clear();
      shape = normalizeStatement(statement);
      normalized.set(statement, shape);
    }
    return shape;
  }

  function observe(statement: string, durationMs: number): void {
    const request = options.currentRequest();
    if (!request) {
      unattributed.roundTrips += 1;
      unattributed.dbMs += durationMs;
      return;
    }
    let profile = open.get(request.key);
    if (!profile) {
      profile = { route: request.route, roundTrips: 0, dbMs: 0, lastAt: 0, statements: new Map() };
      open.set(request.key, profile);
    }
    profile.roundTrips += 1;
    profile.dbMs += durationMs;
    profile.lastAt = now();
    const shape = shapeOf(statement);
    const tally = profile.statements.get(shape);
    if (tally) {
      tally.executions += 1;
      tally.dbMs += durationMs;
    } else if (profile.statements.size < MAX_DISTINCT_STATEMENTS) {
      profile.statements.set(shape, { executions: 1, dbMs: durationMs });
    }
  }

  function close(profile: RequestProfile): void {
    let window = routes.get(profile.route);
    if (!window) {
      window = { roundTrips: [], dbMs: [], statements: new Map() };
      routes.set(profile.route, window);
    }
    window.roundTrips.push(profile.roundTrips);
    window.dbMs.push(profile.dbMs);
    for (const [shape, tally] of profile.statements) {
      let entry = window.statements.get(shape);
      if (!entry) {
        if (window.statements.size >= MAX_DISTINCT_STATEMENTS) continue;
        entry = { repeats: 0, executions: 0, requestsRepeating: 0, maxPerRequest: 0, totalDbMs: 0 };
        window.statements.set(shape, entry);
      }
      entry.executions += tally.executions;
      entry.totalDbMs += tally.dbMs;
      entry.maxPerRequest = Math.max(entry.maxPerRequest, tally.executions);
      if (tally.executions > 1) {
        entry.repeats += tally.executions - 1;
        entry.requestsRepeating += 1;
      }
    }
  }

  /**
   * Close idle requests (or every request when `all`), return the window's
   * summary and start a new window. Returns null for a window with no
   * database activity.
   */
  function summarize(all = false): QueryProfileSummary | null {
    const at = now();
    for (const [key, profile] of open) {
      if (all || at - profile.lastAt >= requestIdleMs) {
        close(profile);
        open.delete(key);
      }
    }
    const closedRoutes = routes;
    const outside = unattributed;
    const start = windowStart;
    routes = new Map();
    unattributed = { roundTrips: 0, dbMs: 0 };
    windowStart = at;
    if (closedRoutes.size === 0 && outside.roundTrips === 0) return null;

    const routeProfiles: RouteQueryProfile[] = [...closedRoutes].map(([route, window]) => {
      const roundTrips = distribution(window.roundTrips);
      return {
        route,
        requests: window.roundTrips.length,
        roundTrips: { mean: roundTrips.mean, p95: roundTrips.p95, max: roundTrips.max },
        dbMs: distribution(window.dbMs),
        repeatedStatements: [...window.statements]
          .filter(([, entry]) => entry.repeats > 0)
          .sort(([, a], [, b]) => b.repeats - a.repeats || b.totalDbMs - a.totalDbMs)
          .slice(0, TOP_REPEATED_STATEMENTS)
          .map(([statement, entry]) => ({ statement, ...entry, totalDbMs: round(entry.totalDbMs) })),
        slowStatements: [...window.statements]
          .sort(([, a], [, b]) => b.totalDbMs - a.totalDbMs)
          .slice(0, TOP_REPEATED_STATEMENTS)
          .map(([statement, entry]) => ({
            statement,
            executions: entry.executions,
            totalDbMs: round(entry.totalDbMs),
            meanDbMs: round(entry.totalDbMs / entry.executions),
          })),
      };
    });
    routeProfiles.sort((a, b) => b.dbMs.total - a.dbMs.total || a.route.localeCompare(b.route));
    return {
      windowStart: new Date(start).toISOString(),
      windowEnd: new Date(at).toISOString(),
      routes: routeProfiles,
      unattributed: { roundTrips: outside.roundTrips, dbMs: round(outside.dbMs) },
      openRequests: open.size,
    };
  }

  return { observe, summarize };
}

type QueryProfileRuntime = typeof globalThis & { __openbooksQueryProfileStarted?: boolean };

/**
 * Start profiling this process. Refuses when the output file is not
 * configured, so an enabled profiler never runs without a destination.
 * Starting twice in one process (a module graph evaluated again) is a no-op.
 */
export function startQueryProfile(env: Record<string, string | undefined>): void {
  const file = env.OPENBOOKS_QUERY_PROFILE_FILE?.trim();
  if (!file) {
    throw new Error(
      "[query-profile] OPENBOOKS_QUERY_PROFILE=1 requires OPENBOOKS_QUERY_PROFILE_FILE: set it to the file the per-route summaries are appended to, or unset OPENBOOKS_QUERY_PROFILE.",
    );
  }
  const runtime = globalThis as QueryProfileRuntime;
  if (runtime.__openbooksQueryProfileStarted) return;
  runtime.__openbooksQueryProfileStarted = true;

  const profile = createQueryProfile({
    currentRequest: () => {
      const store = workAsyncStorage.getStore();
      return store ? { key: store, route: store.route } : undefined;
    },
  });
  registerQueryObserver(profile.observe);

  let writing: Promise<void> = Promise.resolve();
  const flush = () => {
    const summary = profile.summarize();
    if (!summary) return;
    writing = writing
      .then(() => appendFile(file, `${JSON.stringify(summary)}\n`))
      .catch((error: Error) => {
        console.error(`[query-profile] could not append to ${file}:`, error.message);
      });
  };
  setInterval(flush, FLUSH_INTERVAL_MS).unref();
  console.log(`[query-profile] per-route database profile enabled; appending to ${file} every ${FLUSH_INTERVAL_MS / 1000}s`);
}
