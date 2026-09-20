import { newAsyncContext } from "../platform/quickjs.ts";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { ContributedLine } from "../allocations/types.ts";
import { db, schema } from "../platform/db.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { featureEnabled, type FeatureState } from "../organization/feature-registry.ts";
import { abs, cmp, isZero, normalizeMoney, sum } from "../money/money.ts";
// Named export, NOT the default: under ESM/tsx the default import resolves to
// the module namespace (no .parse), so computeNextRunAt silently returned
// null and scheduled scripts never ran. CronExpressionParser.parse works
// under both CJS and ESM interop.
import { CronExpressionParser } from "cron-parser";
import { runUserSql } from "../platform/sqlapi.ts";
import { createScriptJournal } from "../ledger/journal-writes.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";

/**
 * User scripting: REAL JavaScript (ES2023), executed in a QuickJS sandbox —
 * a separate WASM-hosted engine with no access to Node, the filesystem, the
 * network, or the database connection. It provides governed automation without
 * exposing infrastructure or relying on a proprietary runtime.
 *
 * The sandbox uses the ASYNCIFY variant of QuickJS so host functions can do
 * real async I/O (database queries) while the script sees a synchronous call.
 * This is how ob.query works: the script calls ob.query("SELECT ...") and the
 * runtime suspends the WASM, the host runs the SQL through the read-only role,
 * resumes the VM with the rows, and the script gets its array — no callbacks,
 * no promises, no special syntax.
 *
 * Contract: a script defines  function main(ctx) { ... }
 *   ctx = { trigger, document?, lines?, org, user? }   (plain data, deep-frozen)
 *
 * Host APIs on the global `ob` object:
 *   ob.log(...)              collect log lines (persisted to script_runs)
 *   ob.abort("reason")       veto the operation (before_* triggers only)
 *   ob.query(sql)            run a SELECT through the read-only role -> rows[]
 *                            (ob.record.load / ob.search are sugar over it).
 *                            Raw SQL over the governed catalog cannot apply a
 *                            subsidiary allowlist, so an ATTRIBUTED caller must
 *                            satisfy exactly what /api/query demands: the
 *                            queryConsole feature, sql.execute, and an
 *                            unrestricted subsidiary scope — a restlet is never
 *                            a way to read past the query console's gates.
 *                            Actor-less runs (engine triggers, cron) keep the
 *                            documented system path.
 *   ob.runtime               { org, trigger, user } -- read-only context info
 *   ob.record.load(t, id)    load one row by id (convenience over ob.query)
 *   ob.search(t, filters)    search rows by key=value filters
 *   ob.journal.create(input[, {post}])
 *                            governed ledger write: create a BALANCED draft
 *                            journal (engine/src/ledger/journal-writes.ts). post:true
 *                            runs the posting engine and is allowed only
 *                            outside before_* triggers (no posting reentrancy
 *                            while another document is mid-post). The acting
 *                            user needs gl.post for draft AND post — the same
 *                            permission every HTTP journal boundary demands
 *                            (fnd_mt97va1e_kiv9jd: an endpoint script may not
 *                            launder a journal write past role permissions).
 *                            Runs without a signed-in user (scheduled/bulk/
 *                            engine triggers) keep the documented system-
 *                            provenance path.
 *
 * Return contract (before_post only):
 *   return { set: { field: value } }  to mutate whitelisted header fields
 *
 * Limits: interrupt-based timeout, 64 MB memory, 1 MB stack.
 * ob.query: 5 000 rows, 5 s statement timeout, read-only transaction.
 */

export interface ScriptContext {
  trigger: string;
  document?: Record<string, unknown>;
  lines?: Record<string, unknown>[];
  /** custom_gl_lines: the posting kernel's own lines, deep-frozen, read-only. */
  kernelLines?: Record<string, unknown>[];
  /** endpoint scripts: the inbound HTTP request { method, query, body }. */
  request?: Record<string, unknown>;
  org: { id: string; name: string; baseCurrency: string };
  user?: { id: string; name: string; roles: string[] };
}

export interface ScriptOutcome {
  scriptId: string;
  name: string;
  status: "ok" | "aborted" | "error" | "timeout";
  set?: Record<string, unknown>;
  /** main()'s raw JSON return value (endpoint scripts' response body). */
  returned?: unknown;
  abortReason?: string;
  logs: string[];
  durationMs: number;
}

const MUTABLE_FIELDS = new Set([
  "memo",
  "internalNotes",
  "expectedPayDate",
  "paymentHoldReason",
  "dueDate",
  "departmentId",
  "projectId",
  "locationId",
  "classId",
  "custom",
]);

/**
 * Document.custom keys that are part of the posting kernel or its immutable
 * tax evidence. A before_post script may add operational metadata, but it
 * must never be able to replace one of these values after approval.
 */
const BEFORE_POST_PROTECTED_CUSTOM_FIELDS = new Set([
  "controlAccountId",
  "discountAmount",
  "discountAccountId",
  "feeAmount",
  "feeIncomeAccountId",
  "taxProviderAddresses",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate the only JSON shape that a before_post custom mutation may carry.
 * Returning a message (rather than throwing) lets the sandbox record a normal
 * failed script run, exactly like a non-whitelisted header field.
 */
export function beforePostCustomMutationError(value: unknown): string | null {
  if (!isRecord(value)) {
    return "before_post scripts may only set custom to an object";
  }
  const protectedKey = Object.keys(value).find((key) =>
    BEFORE_POST_PROTECTED_CUSTOM_FIELDS.has(key),
  );
  return protectedKey
    ? `script tried to set protected posting custom field "custom.${protectedKey}"`
    : null;
}

/**
 * Merge a validated before_post custom mutation without replacing existing
 * posting controls. This remains a second, posting-layer guard in case a
 * caller ever supplies a ScriptOutcome without going through runScript.
 */
export function mergeBeforePostCustomMutation(
  existing: unknown,
  mutation: unknown,
): Record<string, unknown> {
  const error = beforePostCustomMutationError(mutation);
  if (error) throw new Error(error);
  return {
    ...(isRecord(existing) ? existing : {}),
    ...(mutation as Record<string, unknown>),
  };
}

/**
 * The refusal an attributed caller gets from ob.query, or null when the call
 * may proceed. Mirrors web/app/api/query/route.ts gate-for-gate:
 * guardFeaturePermission("sql.execute", "queryConsole") and
 * hasUnrestrictedQueryScope. Resolved live against the tenant (ctx.user's
 * roles array is display data), and only for a signed-in principal —
 * system-driven runs have no caller to authorize and remain governed by the
 * scripts feature alone.
 */
export async function scriptQueryRefusal(
  ctx: Pick<ScriptContext, "org" | "user">,
): Promise<string | null> {
  const userId = ctx.user?.id;
  if (!userId) return null;
  const feature = (await db.execute<{ enabled: boolean }>(sql`
    select coalesce((settings->'features'->>'queryConsole')::boolean, false) as enabled
      from orgs
     where id = ${ctx.org.id}
  `)).rows[0];
  if (!feature?.enabled) return "queryConsole feature is disabled";
  if (!(await actorHasPermission(db, ctx.org.id, userId, "sql.execute"))) {
    return "missing permission: sql.execute";
  }
  if ((await actorAllowedSubsidiaryIds(db, ctx.org.id, userId)) !== null) {
    return "raw queries require unrestricted subsidiary access";
  }
  return null;
}

/** Domain-boundary gate for every script execution path. */
export async function scriptingFeatureEnabled(orgId: string): Promise<boolean> {
  const result = (await db.execute<{ enabled: string | null }>(sql`
    select settings #>> '{features,scripts}' as enabled
      from orgs
     where id = ${orgId}
  `));
  return result.rows[0]?.enabled === "true";
}

/**
 * Per-run sandbox posture beyond the trigger default. Only the triggers that
 * opt in pay for the stricter semantics, so existing scripts are unaffected.
 */
export interface RunScriptOptions {
  /**
   * Prepend "use strict" so a write to the deep-frozen context throws instead
   * of silently doing nothing (custom_gl_lines must prove kernel immutability).
   */
  strict?: boolean;
  /** Refuse ob.journal.create: the trigger answers with a return value. */
  forbidJournalCreate?: boolean;
  /** Remove clock and randomness (Date, Math.random) for deterministic triggers. */
  deterministic?: boolean;
}

export async function runScript(
  source: string,
  ctx: ScriptContext,
  timeoutMs: number,
  opts: RunScriptOptions = {},
): Promise<Omit<ScriptOutcome, "scriptId" | "name">> {
  const vm = await newAsyncContext();
  const runtime = vm.runtime;
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);

  const logs: string[] = [];
  const started = Date.now();
  try {
    const obHandle = vm.newObject();

    const logFn = vm.newFunction("log", (...args) => {
      logs.push(args.map((a) => JSON.stringify(vm.dump(a))).join(" "));
    });

    const abortFn = vm.newFunction("abort", (reasonH) => {
      const reason = vm.dump(reasonH);
      return { error: vm.newError(`__OB_ABORT__${String(reason)}`) };
    });

    // The caller's query authorization is fixed for the run; resolve it once
    // on first use so ob.search loops do not re-read roles per statement.
    let queryRefusal: Promise<string | null> | undefined;
    const queryFn = vm.newAsyncifiedFunction("__query", async (sqlH) => {
      const sqlText = String(vm.dump(sqlH));
      queryRefusal ??= scriptQueryRefusal(ctx);
      const refusal = await queryRefusal;
      if (refusal) return { error: vm.newError(`query: ${refusal}`) };
      try {
        const result = await runUserSql(sqlText, {
          orgId: ctx.org.id,
          maxRows: 5_000,
          timeoutMs: 5_000,
        });
        return vm.newString(JSON.stringify(result.rows));
      } catch (e) {
        return { error: vm.newError(`query failed: ${(e as Error).message}`) };
      }
    });

    // Governed ledger write. post:true is refused inside before_* triggers —
    // the posting engine is already mid-flight for the triggering document.
    // An attributed caller (endpoint scripts run under a signed-in user) must
    // hold gl.post like they would at any HTTP journal boundary; the roles
    // array on ctx is display data, so the live tenant authorization is
    // re-resolved here rather than trusted from the context.
    const journalFn = vm.newAsyncifiedFunction(
      "__journal_create",
      async (inputH, postH) => {
        // custom_gl_lines contributes lines through its return value; a
        // direct ledger write from inside the trigger would bypass host
        // validation (balance, account checks) and the single-entry stamp.
        if (opts.forbidJournalCreate) {
          return {
            error: vm.newError(
              `journal.create is not available in ${ctx.trigger} (return { lines: [...] } instead)`,
            ),
          };
        }
        const post = vm.dump(postH) === true;
        if (post && ctx.trigger.startsWith("before_")) {
          return {
            error: vm.newError(
              `journal.create: post:true is not allowed in ${ctx.trigger} (create a draft instead)`,
            ),
          };
        }
        if (ctx.user?.id && !(await actorHasPermission(db, ctx.org.id, ctx.user.id, "gl.post"))) {
          return {
            error: vm.newError("journal.create: missing permission: gl.post"),
          };
        }
        try {
          const input = JSON.parse(String(vm.dump(inputH)));
          // The caller's live subsidiary scope travels with the write: a
          // restricted principal can only journal into an entity it may see,
          // exactly as at the HTTP draft route. System runs are unrestricted.
          const allowedSubsidiaryIds = ctx.user?.id
            ? await actorAllowedSubsidiaryIds(db, ctx.org.id, ctx.user.id)
            : null;
          const result = await createScriptJournal(
            ctx.org.id,
            ctx.user?.id ?? null,
            input,
            { post, allowedSubsidiaryIds },
          );
          return vm.newString(JSON.stringify(result));
        } catch (e) {
          return {
            error: vm.newError(
              `journal.create failed: ${(e as Error).message}`,
            ),
          };
        }
      },
    );

    vm.setProp(obHandle, "log", logFn);
    vm.setProp(obHandle, "abort", abortFn);
    vm.setProp(obHandle, "__query", queryFn);
    vm.setProp(obHandle, "__journal_create", journalFn);
    vm.setProp(vm.global, "ob", obHandle);
    logFn.dispose();
    abortFn.dispose();
    queryFn.dispose();
    journalFn.dispose();
    obHandle.dispose();

    const program = `
      ${opts.strict ? '"use strict";' : ""}
      ${source}
      ;(() => {
        const ctx = ${JSON.stringify(ctx)};
        const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
        deepFreeze(ctx);
        ${opts.deterministic ? `Date = function () { throw new Error("custom_gl_lines is deterministic: Date is not available"); }; Math.random = function () { throw new Error("custom_gl_lines is deterministic: Math.random is not available"); };` : ""}

        ob.runtime = Object.freeze({
          org: ctx.org,
          trigger: ctx.trigger,
          user: ctx.user || null,
        });

        ob.query = function(sqlText) {
          return JSON.parse(ob.__query(sqlText));
        };

        function __sqlVal(v) {
          if (v === null || v === undefined) return "NULL";
          if (typeof v === "number") return String(v);
          if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
          return "'" + String(v).replace(/'/g, "''") + "'";
        }

        ob.record = {
          load: function(table, id) {
            if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error("invalid table: " + table);
            var rows = ob.query("SELECT * FROM " + table + " WHERE id = " + __sqlVal(id) + " LIMIT 1");
            return rows[0] || null;
          }
        };

        ob.search = function(table, filters) {
          if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error("invalid table: " + table);
          var q = "SELECT * FROM " + table;
          if (filters) {
            var clauses = [];
            for (var k in filters) { clauses.push(k + " = " + __sqlVal(filters[k])); }
            if (clauses.length) q += " WHERE " + clauses.join(" AND ");
          }
          q += " LIMIT 1000";
          return ob.query(q);
        };

        ob.journal = {
          create: function(input, opts) { return JSON.parse(ob.__journal_create(JSON.stringify(input || {}), !!(opts && opts.post))); }
        };

        if (typeof main !== "function") throw new Error("script must define function main(ctx)");
        const out = main(ctx);
        return JSON.stringify(out ?? null);
      })()
    `;

    const result = await vm.evalCodeAsync(program);
    if (result.error) {
      const err = vm.dump(result.error);
      result.error.dispose();
      const msg =
        typeof err === "object" && err && "message" in err
          ? String((err).message)
          : String(err);
      if (msg.startsWith("__OB_ABORT__")) {
        return {
          status: "aborted",
          abortReason: msg.slice("__OB_ABORT__".length),
          logs,
          durationMs: Date.now() - started,
        };
      }
      if (Date.now() > deadline) {
        return { status: "timeout", logs, durationMs: Date.now() - started };
      }
      return {
        status: "error",
        abortReason: msg,
        logs,
        durationMs: Date.now() - started,
      };
    }
    const raw = vm.dump(result.value);
    result.value.dispose();
    // raw is the VM's JSON.stringify(out); non-serializable returns (functions,
    // undefined) come back as a non-string — treat them as "no return value".
    const parsed =
      typeof raw === "string" && raw !== "null" ? JSON.parse(raw) : null;
    let set: Record<string, unknown> | undefined;
    // The { set: {...} } mutation contract only applies to before_* triggers —
    // endpoint/bulk/scheduled scripts' returns are plain data, never mutations.
    if (
      ctx.trigger.startsWith("before_") &&
      parsed &&
      typeof parsed === "object" &&
      parsed.set &&
      typeof parsed.set === "object"
    ) {
      set = {};
      for (const [k, v] of Object.entries(parsed.set)) {
        if (!MUTABLE_FIELDS.has(k)) {
          return {
            status: "error",
            abortReason: `script tried to set non-whitelisted field "${k}"`,
            logs,
            durationMs: Date.now() - started,
          };
        }
        if (ctx.trigger === "before_post" && k === "custom") {
          const customError = beforePostCustomMutationError(v);
          if (customError) {
            return {
              status: "error",
              abortReason: customError,
              logs,
              durationMs: Date.now() - started,
            };
          }
        }
        set[k] = v;
      }
    }
    return {
      status: "ok",
      set,
      returned: parsed,
      logs,
      durationMs: Date.now() - started,
    };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

export async function runTriggerScripts(
  trigger: "before_submit" | "before_post" | "after_post" | "before_void",
  ctx: ScriptContext,
  targetId: string,
): Promise<ScriptOutcome[]> {
  if (!(await scriptingFeatureEnabled(ctx.org.id))) return [];
  const docKind = ctx.document?.kind ?? "";
  const scripts = await db
    .select()
    .from(schema.userScripts)
    .where(
      and(
        eq(schema.userScripts.orgId, ctx.org.id),
        eq(schema.userScripts.triggerPoint, trigger),
        eq(schema.userScripts.isActive, true),
        or(
          isNull(schema.userScripts.documentKind),
          eq(schema.userScripts.documentKind, String(docKind)),
        ),
      ),
    )
    .orderBy(asc(schema.userScripts.sortOrder));

  const outcomes: ScriptOutcome[] = [];
  for (const s of scripts) {
    const res = await runScript(s.source, { ...ctx, trigger }, s.timeoutMs);
    const outcome: ScriptOutcome = { scriptId: s.id, name: s.name, ...res };
    outcomes.push(outcome);
    await db.insert(schema.scriptRuns).values({
      orgId: ctx.org.id,
      scriptId: s.id,
      targetKind: String(docKind || trigger),
      targetId,
      status: res.status,
      logs: res.logs,
      errorMessage: res.status === "ok" ? null : res.abortReason,
      durationMs: res.durationMs,
      // Attribution mirrors the triggering operation's own actor: a real user
      // when an authenticated human drove it, explicit null when system-driven.
      createdBy: ctx.user?.id ?? null,
    });
    await db.execute(
      sql`update user_scripts set last_run_at = now() where id = ${s.id} and org_id = ${ctx.org.id}`,
    );
    if (
      res.status === "aborted" ||
      res.status === "error" ||
      res.status === "timeout"
    )
      break;
  }
  return outcomes;
}

export async function runScheduledScript(
  scriptId: string,
  orgId: string,
  opts: ScriptRunOptions = {},
): Promise<ScriptOutcome> {
  if (!(await scriptingFeatureEnabled(orgId))) throw new Error("scripts feature is disabled");
  const [s] = await db
    .select()
    .from(schema.userScripts)
    .where(
      and(
        eq(schema.userScripts.id, scriptId),
        eq(schema.userScripts.orgId, orgId),
        eq(schema.userScripts.triggerPoint, "scheduled"),
        eq(schema.userScripts.isActive, true),
      ),
    );
  if (!s) throw new Error("script not found");

  // This is the deepest execution boundary shared by the web scheduler, the
  // queue worker, and manual Run now. A stored scheduled script must still
  // satisfy today's parser contract immediately before its source is loaded
  // into QuickJS; callers can therefore never execute a legacy-invalid row by
  // bypassing the admin route.
  if (s.triggerPoint === "scheduled") {
    computeScheduledScriptNextRunAt(s.cron);
  }

  const [org] = await db
    .select()
    .from(schema.orgs)
    .where(eq(schema.orgs.id, orgId));
  if (!org) throw new Error("org not found");

  // Attribution before any source runs: a manual "Run now" carries its
  // authenticated actor through ctx and every evidence row; a true cron tick
  // passes none and stays explicitly system-attributed (null created_by).
  const user = await resolveScriptUser(orgId, opts.actorId ?? null);
  const ctx: ScriptContext = {
    trigger: "scheduled",
    org: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
    ...(user ? { user } : {}),
  };
  const res = await runScript(s.source, ctx, s.timeoutMs);
  const outcome: ScriptOutcome = { scriptId: s.id, name: s.name, ...res };

  await db.insert(schema.scriptRuns).values({
    orgId,
    scriptId: s.id,
    targetKind: "scheduled",
    targetId: null,
    status: res.status,
    logs: res.logs,
    errorMessage: res.status === "ok" ? null : res.abortReason,
    durationMs: res.durationMs,
    createdBy: user?.id ?? null,
  });
  await db.execute(
    sql`update user_scripts set last_run_at = now() where id = ${s.id} and org_id = ${orgId}`,
  );

  return outcome;
}

/**
 * Run an endpoint script (the RESTlet idea): loaded by its per-org slug, given
 * the inbound request as ctx.request, and its main() return becomes the HTTP
 * response body. Every invocation is logged to script_runs.
 */
export async function runEndpointScript(
  slug: string,
  orgId: string,
  user: { id: string; name: string; roles: string[] },
  request: { method: string; query: Record<string, string>; body: unknown },
): Promise<ScriptOutcome | null> {
  if (!(await scriptingFeatureEnabled(orgId))) return null;
  const [s] = await db
    .select()
    .from(schema.userScripts)
    .where(
      and(
        eq(schema.userScripts.orgId, orgId),
        eq(schema.userScripts.triggerPoint, "endpoint"),
        eq(schema.userScripts.endpointSlug, slug),
        eq(schema.userScripts.isActive, true),
      ),
    );
  if (!s) return null;

  const [org] = await db
    .select()
    .from(schema.orgs)
    .where(eq(schema.orgs.id, orgId));
  if (!org) throw new Error("org not found");

  const ctx: ScriptContext = {
    trigger: "endpoint",
    request: request as unknown as Record<string, unknown>,
    org: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
    user,
  };
  const res = await runScript(s.source, ctx, s.timeoutMs);
  const outcome: ScriptOutcome = { scriptId: s.id, name: s.name, ...res };

  await db.insert(schema.scriptRuns).values({
    orgId,
    scriptId: s.id,
    targetKind: "endpoint",
    targetId: null,
    status: res.status,
    logs: res.logs,
    errorMessage: res.status === "ok" ? null : res.abortReason,
    durationMs: res.durationMs,
    // Endpoint invocations are always interactive (permission-gated caller).
    createdBy: user.id,
  });
  await db.execute(
    sql`update user_scripts set last_run_at = now() where id = ${s.id} and org_id = ${orgId}`,
  );
  return outcome;
}

/** Bulk scripts get a 30 s deadline regardless of the stored (10 s-capped) timeout. */
const BULK_TIMEOUT_MS = 30_000;

/**
 * Run a bulk script — the long-budget background kind. Same contract as a
 * scheduled script (doc-less ctx), but with an extended deadline; meant to be
 * consumed on the worker via the scripts queue, with inline fallback. A
 * queued "Run now" carries its authenticated actor through opts.actorId and
 * it is re-resolved against users here — the one boundary every entry path
 * (route, inline fallback, worker payload) shares.
 */
export async function runBulkScript(
  scriptId: string,
  orgId: string,
  opts: ScriptRunOptions = {},
): Promise<ScriptOutcome> {
  if (!(await scriptingFeatureEnabled(orgId))) throw new Error("scripts feature is disabled");
  const [s] = await db
    .select()
    .from(schema.userScripts)
    .where(
      and(
        eq(schema.userScripts.id, scriptId),
        eq(schema.userScripts.orgId, orgId),
        eq(schema.userScripts.triggerPoint, "bulk"),
        eq(schema.userScripts.isActive, true),
      ),
    );
  if (!s) throw new Error("script not found");

  const [org] = await db
    .select()
    .from(schema.orgs)
    .where(eq(schema.orgs.id, orgId));
  if (!org) throw new Error("org not found");

  // Attribution before any source runs, exactly like the scheduled runner:
  // interactive "Run now" keeps its real user through ctx (so journal drafts
  // get created_by instead of system provenance), cron-style callers keep null.
  const user = await resolveScriptUser(orgId, opts.actorId ?? null);
  const ctx: ScriptContext = {
    trigger: "bulk",
    org: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
    ...(user ? { user } : {}),
  };
  const res = await runScript(s.source, ctx, BULK_TIMEOUT_MS);
  const outcome: ScriptOutcome = { scriptId: s.id, name: s.name, ...res };

  await db.insert(schema.scriptRuns).values({
    orgId,
    scriptId: s.id,
    targetKind: "bulk",
    targetId: null,
    status: res.status,
    logs: res.logs,
    errorMessage: res.status === "ok" ? null : res.abortReason,
    durationMs: res.durationMs,
    createdBy: user?.id ?? null,
  });
  await db.execute(
    sql`update user_scripts set last_run_at = now() where id = ${s.id} and org_id = ${orgId}`,
  );
  return outcome;
}

export const INVALID_SCHEDULED_SCRIPT_CRON_CODE = "invalid_scheduled_script_cron";

export class InvalidScheduledScriptCronError extends Error {
  readonly code = INVALID_SCHEDULED_SCRIPT_CRON_CODE;

  constructor() {
    super("invalid cron expression");
    this.name = "InvalidScheduledScriptCronError";
  }
}

/** Thrown when an attributed runner is handed an id that no active user of
 *  the owning org backs (a stale identity, or a UUID from another domain such
 *  as a subscription/template row). Execution is refused before any source
 *  runs: user-actor columns receive either a validated users.id or NULL, and
 *  a run never silently downgrades an authorized human to system provenance. */
export class ScriptActorError extends Error {
  readonly name = "ScriptActorError";
}

/**
 * Attribution option for runners reachable from a queue or scheduler boundary.
 * `actorId` is the interactive triggerer (e.g. the admin who pressed "Run
 * now"); omitted/null means system automation and stays explicit null
 * provenance everywhere (script_runs.created_by, journal created_by).
 */
export interface ScriptRunOptions {
  actorId?: string | null;
}

/**
 * Resolve an attributed human actor for one script run. The actor is
 * re-resolved against the users table at this deepest shared boundary so
 * every entry path (HTTP route, inline fallback, queue payload) stamps the
 * same thing: a real, currently-active user of the owning org — with their
 * name and role keys for ob.runtime — or nothing at all. Same join contract
 * as web/lib/auth.ts session roles.
 */
export async function resolveScriptUser(
  orgId: string,
  actorId: string | null,
): Promise<NonNullable<ScriptContext["user"]> | null> {
  if (!actorId) return null;
  const [u] = await db
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.id, actorId),
        eq(schema.users.orgId, orgId),
        eq(schema.users.isActive, true),
      ),
    );
  if (!u) throw new ScriptActorError(`run actor ${actorId} is not an active user of organization ${orgId}`);
  const roles = await db
    .select({ key: schema.appRoles.key })
    .from(schema.roleAssignments)
    .innerJoin(schema.appRoles, eq(schema.appRoles.id, schema.roleAssignments.roleId))
    .where(
      and(
        eq(schema.roleAssignments.orgId, orgId),
        eq(schema.roleAssignments.userId, actorId),
      ),
    )
    .orderBy(asc(schema.appRoles.isBuiltIn), asc(schema.appRoles.key));
  return { id: u.id, name: u.name, roles: roles.map((r) => r.key) };
}

/**
 * Strict parser contract for every user_scripts write and execution boundary.
 * Invalid input is a domain error, never a nullable scheduling decision.
 */
export function computeScheduledScriptNextRunAt(
  cron: string | null,
  from: Date = new Date(),
  timezone = "UTC",
): Date {
  if (!cron?.trim()) throw new InvalidScheduledScriptCronError();
  try {
    const expr = CronExpressionParser.parse(cron, {
      currentDate: from,
      tz: timezone,
    });
    return expr.next().toDate();
  } catch {
    throw new InvalidScheduledScriptCronError();
  }
}

/**
 * Compatibility policy for payment/recurring callers that already consume a
 * nullable result. Their behavior remains unchanged; user_scripts must use the
 * strict contract above.
 */
export function computeNextRunAt(
  cron: string,
  from: Date = new Date(),
  timezone = "UTC",
): Date | null {
  try {
    return computeScheduledScriptNextRunAt(cron, from, timezone);
  } catch (error) {
    if (error instanceof InvalidScheduledScriptCronError) return null;
    throw error;
  }
}

export const SCHEDULED_SCRIPT_SCHEDULER_IDENTITY =
  "scheduled-script-scheduler";

/**
 * Atomically quarantine one malformed active scheduled script and preserve
 * both pieces of repairable configuration (cron and next_run_at). The error
 * run is explicitly configuration evidence, not a claimed execution, while
 * audit_log attributes the system mutation and links back to that run.
 */
export async function quarantineInvalidScheduledScript(input: {
  id: string;
  orgId: string;
  cron: string | null;
  nextRunAt: Date | string | null;
}): Promise<boolean> {
  const errorMessage = "scheduled script quarantined: invalid cron expression";
  const quarantined = await db.execute<{ runId: string }>(sql`
    with quarantined as (
      update user_scripts
         set is_active = false,
             updated_at = now()
       where id = ${input.id}
         and org_id = ${input.orgId}
         and trigger_point = 'scheduled'
         and is_active
         and cron is not distinct from ${input.cron}
         and next_run_at is not distinct from ${input.nextRunAt}
      returning id, org_id, cron, next_run_at
    ), failure as (
      insert into script_runs
        (org_id, script_id, target_kind, target_id, status, logs, error_message, duration_ms, at)
      select org_id, id, 'scheduled_configuration', null, 'error',
             jsonb_build_array(jsonb_build_object(
               'event', 'invalid_cron_quarantined',
               'markedBy', ${SCHEDULED_SCRIPT_SCHEDULER_IDENTITY}::text,
               'cron', cron,
               'nextRunAt', next_run_at)),
             ${errorMessage}, null, now()
        from quarantined
      returning id, org_id, script_id
    ), audited as (
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      select quarantined.org_id, 'user_scripts', quarantined.id, 'update',
             jsonb_build_object(
               'event', 'invalid_cron_quarantined',
               'actorKind', 'system',
               'actor', ${SCHEDULED_SCRIPT_SCHEDULER_IDENTITY}::text,
               'reason', ${errorMessage}::text,
               'scriptRunId', failure.id,
               'before', jsonb_build_object(
                 'isActive', true,
                 'cron', quarantined.cron,
                 'nextRunAt', quarantined.next_run_at),
               'after', jsonb_build_object(
                 'isActive', false,
                 'cron', quarantined.cron,
                 'nextRunAt', quarantined.next_run_at)),
             null
        from quarantined
        join failure on failure.script_id = quarantined.id
      returning id
    )
    select failure.id as "runId"
      from failure
      cross join audited
  `);
  return quarantined.rows.length === 1;
}

export async function refreshScheduledNextRuns(orgId: string): Promise<void> {
  if (!(await scriptingFeatureEnabled(orgId))) {
    await db.execute(sql`
      update user_scripts
         set next_run_at = null
       where org_id = ${orgId} and trigger_point = 'scheduled'
    `);
    return;
  }
  const scripts = await db
    .select()
    .from(schema.userScripts)
    .where(
      and(
        eq(schema.userScripts.orgId, orgId),
        eq(schema.userScripts.triggerPoint, "scheduled"),
        eq(schema.userScripts.isActive, true),
      ),
    );

  for (const s of scripts) {
    const cron = s.cron;
    let next: Date;
    try {
      next = computeScheduledScriptNextRunAt(cron);
    } catch (error) {
      if (!(error instanceof InvalidScheduledScriptCronError)) throw error;
      await quarantineInvalidScheduledScript({
        id: s.id,
        orgId,
        cron,
        nextRunAt: s.nextRunAt,
      });
      continue;
    }
    await db.execute(
      sql`update user_scripts set next_run_at = ${next} where id = ${s.id} and org_id = ${orgId}`,
    );
  }
}

// --- custom_gl_lines: allocation-kernel GL plug-in (A6) ----------------------
// Tenant-authored extra GL lines on a document's own journal entry. The
// posting seam (engine/src/ledger/posting.ts, after rule contributions) calls
// runCustomGlLineScripts with the kernel lines; each active script's main(ctx)
// returns { lines: [...] } and the host validates, resolves, and stamps every
// line. The first refusal throws CustomGlLinesError, which halts posting
// before the posting transaction opens — never a partial write.

export const CUSTOM_GL_LINES_TRIGGER = "custom_gl_lines";
export const MAX_CUSTOM_GL_LINES = 200;
export const CUSTOM_GL_LINES_ERROR_CODE = "custom_gl_lines_error";

/** Typed refusal from the custom_gl_lines host (validation, gates, errors). */
export class CustomGlLinesError extends Error {
  readonly code = CUSTOM_GL_LINES_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = "CustomGlLinesError";
  }
}

export interface CustomGlLineRunRequest {
  orgId: string;
  document: Record<string, unknown>;
  documentLines: Record<string, unknown>[];
  /** The posting kernel's own lines (pre-subsidiary), exposed read-only. */
  kernelLines: Record<string, unknown>[];
  /** Posting actor; null = system provenance (same rule as ob.journal.create). */
  actorId: string | null;
  /** Document id, for script_runs evidence. */
  targetId: string;
}

/**
 * Both halves of the feature gate: the scripts platform AND the allocation
 * posting mode, resolved through the feature registry so the allocations
 * parent key governs its binding-moment children (a child can never resolve
 * enabled while the parent is off). Unknown keys resolve closed.
 */
export async function customGlLinesEnabled(orgId: string): Promise<boolean> {
  const r = (await db.execute<{ features: FeatureState | null }>(sql`
    select settings->'features' as features
      from orgs
     where id = ${orgId}
  `));
  const state = r.rows[0]?.features ?? {};
  return (
    featureEnabled(state, "scripts") &&
    featureEnabled(state, "allocationsAtPosting")
  );
}

/**
 * Run every active custom_gl_lines script for the document kind, in
 * sort_order, and collect their validated contributions. Rule contributions
 * (A5) run first at the seam; scripts observe them through kernelLines. The
 * first error — a failed run or a refused line set — throws and halts
 * posting; script_runs evidence for every script that ran is already recorded.
 */
export async function runCustomGlLineScripts(
  req: CustomGlLineRunRequest,
): Promise<ContributedLine[]> {
  if (!(await customGlLinesEnabled(req.orgId))) return [];
  const docKind = String(
    (req.document as { kind?: unknown } | null)?.kind ?? "",
  );
  const scripts = await db
    .select()
    .from(schema.userScripts)
    .where(
      and(
        eq(schema.userScripts.orgId, req.orgId),
        eq(schema.userScripts.triggerPoint, CUSTOM_GL_LINES_TRIGGER),
        eq(schema.userScripts.isActive, true),
        or(
          isNull(schema.userScripts.documentKind),
          eq(schema.userScripts.documentKind, docKind),
        ),
      ),
    )
    .orderBy(asc(schema.userScripts.sortOrder));
  if (scripts.length === 0) return [];

  // The posting caller needs gl.post, re-resolved live against its roles —
  // the same pattern as ob.journal.create. The ctx user object is display
  // data; the tenant authorization below is authoritative. Actor-less runs
  // keep the documented system-provenance path.
  const user = await resolveScriptUser(req.orgId, req.actorId);
  if (
    user &&
    !(await actorHasPermission(db, req.orgId, user.id, "gl.post"))
  ) {
    throw new CustomGlLinesError(
      `custom_gl_lines: user "${user.name}" lacks gl.post`,
    );
  }

  const [org] = await db
    .select()
    .from(schema.orgs)
    .where(eq(schema.orgs.id, req.orgId));
  if (!org) throw new CustomGlLinesError("custom_gl_lines: organization not found");

  const out: ContributedLine[] = [];
  for (const s of scripts) {
    const ctx: ScriptContext = {
      trigger: CUSTOM_GL_LINES_TRIGGER,
      document: req.document,
      lines: req.documentLines,
      kernelLines: req.kernelLines,
      org: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
      ...(user ? { user } : {}),
    };
    const res = await runScript(s.source, ctx, s.timeoutMs, {
      strict: true,
      forbidJournalCreate: true,
      deterministic: true,
    });
    const outcomeStatus = res.status;
    await db.insert(schema.scriptRuns).values({
      orgId: req.orgId,
      scriptId: s.id,
      targetKind: docKind || CUSTOM_GL_LINES_TRIGGER,
      targetId: req.targetId,
      status: outcomeStatus,
      logs: res.logs,
      errorMessage: outcomeStatus === "ok" ? null : res.abortReason,
      durationMs: res.durationMs,
      createdBy: user?.id ?? null,
    });
    await db.execute(
      sql`update user_scripts set last_run_at = now() where id = ${s.id} and org_id = ${req.orgId}`,
    );
    if (outcomeStatus !== "ok") {
      throw new CustomGlLinesError(
        `custom_gl_lines script "${s.name}" ${outcomeStatus}${res.abortReason ? `: ${res.abortReason}` : ""}`,
      );
    }
    out.push(...(await resolveCustomGlLines(req.orgId, s.id, s.name, res.returned)));
  }
  return out;
}

const CUSTOM_GL_LINE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CUSTOM_GL_LINE_AMOUNT = "10000000000000.0000";

interface ParsedCustomGlLine {
  accountId?: string;
  accountCode?: string;
  amount: string;
  departmentId: string | null;
  projectId: string | null;
  locationId: string | null;
  classId: string | null;
  subsidiaryId: string | null;
  memo: string | null;
  bookCode?: string;
}

function customGlLineId(
  scriptName: string,
  index: number,
  field: string,
  value: unknown,
): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !CUSTOM_GL_LINE_UUID_RE.test(value)) {
    throw new CustomGlLinesError(
      `custom_gl_lines script "${scriptName}" line ${index + 1}: invalid ${field}`,
    );
  }
  return value;
}

/**
 * Validate one script's returned line set and resolve it to stamped
 * contributions (contributor_kind 'script', contributor_ref = script id).
 * Lineage is not required for scripts, so no lineage drafts are produced —
 * the posting seam accepts these lines as-is.
 */
export async function resolveCustomGlLines(
  orgId: string,
  scriptId: string,
  scriptName: string,
  returned: unknown,
): Promise<ContributedLine[]> {
  if (returned === null || returned === undefined) return [];
  if (!isRecord(returned)) {
    throw new CustomGlLinesError(
      `custom_gl_lines script "${scriptName}" must return { lines: [...] } or nothing`,
    );
  }
  const raw = returned.lines;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new CustomGlLinesError(
      `custom_gl_lines script "${scriptName}" must return { lines: [...] }`,
    );
  }
  if (raw.length > MAX_CUSTOM_GL_LINES) {
    throw new CustomGlLinesError(
      `custom_gl_lines script "${scriptName}" returned ${raw.length} lines (max ${MAX_CUSTOM_GL_LINES})`,
    );
  }
  const parsed: ParsedCustomGlLine[] = raw.map((entry, index) => {
    const lineNo = index + 1;
    if (!isRecord(entry)) {
      throw new CustomGlLinesError(
        `custom_gl_lines script "${scriptName}" line ${lineNo}: must be an object`,
      );
    }
    const exact = canonicalDecimal(entry.amount, 4);
    if (exact === null) {
      throw new CustomGlLinesError(
        `custom_gl_lines script "${scriptName}" line ${lineNo}: amount must be a number with at most 4 decimal places`,
      );
    }
    let amount: string;
    try {
      amount = normalizeMoney(exact);
    } catch {
      throw new CustomGlLinesError(
        `custom_gl_lines script "${scriptName}" line ${lineNo}: amount must be a number with at most 4 decimal places`,
      );
    }
    if (isZero(amount)) {
      throw new CustomGlLinesError(
        `custom_gl_lines script "${scriptName}" line ${lineNo}: amount must be nonzero`,
      );
    }
    if (cmp(abs(amount), MAX_CUSTOM_GL_LINE_AMOUNT) > 0) {
      throw new CustomGlLinesError(
        `custom_gl_lines script "${scriptName}" line ${lineNo}: amount out of range`,
      );
    }
    const accountId = customGlLineId(scriptName, index, "accountId", entry.accountId);
    const accountCode =
      entry.accountCode === undefined || entry.accountCode === null || entry.accountCode === ""
        ? undefined
        : String(entry.accountCode);
    if (!accountId && !accountCode) {
      throw new CustomGlLinesError(
        `custom_gl_lines script "${scriptName}" line ${lineNo}: accountId or accountCode required`,
      );
    }
    const bookCode =
      entry.bookCode === undefined || entry.bookCode === null || entry.bookCode === ""
        ? undefined
        : String(entry.bookCode);
    return {
      ...(accountId ? { accountId } : {}),
      ...(accountCode ? { accountCode } : {}),
      amount,
      departmentId: customGlLineId(scriptName, index, "departmentId", entry.departmentId),
      projectId: customGlLineId(scriptName, index, "projectId", entry.projectId),
      locationId: customGlLineId(scriptName, index, "locationId", entry.locationId),
      classId: customGlLineId(scriptName, index, "classId", entry.classId),
      subsidiaryId: customGlLineId(scriptName, index, "subsidiaryId", entry.subsidiaryId),
      memo: entry.memo === undefined || entry.memo === null || entry.memo === ""
        ? null
        : String(entry.memo).slice(0, 500),
      ...(bookCode ? { bookCode } : {}),
    };
  });

  // Resolve accountCode → id (org-scoped, active, non-summary) and prove
  // every provided accountId/dimension id is org-owned, exactly like the
  // governed journal write — a well-formed foreign id must never die at the
  // composite FK as an unhandled storage error.
  const codes = [...new Set(parsed.filter((l) => !l.accountId).map((l) => l.accountCode!))];
  const accountIds = [...new Set(parsed.map((l) => l.accountId).filter((x): x is string => typeof x === "string"))];
  const byCode = new Map<string, string>();
  if (codes.length > 0) {
    const r = (await db.execute<{ id: string; number: string }>(sql`
      select id, number from accounts
       where org_id = ${orgId} and is_active = true and is_summary = false and number in ${codes}`));
    for (const row of r.rows) byCode.set(String(row.number), String(row.id));
    for (const line of parsed) {
      if (!line.accountId && !byCode.has(line.accountCode!)) {
        const lineNo = parsed.indexOf(line) + 1;
        throw new CustomGlLinesError(
          `custom_gl_lines script "${scriptName}" line ${lineNo}: unknown, inactive, or summary account code "${line.accountCode}"`,
        );
      }
    }
  }
  if (accountIds.length > 0) {
    const r = (await db.execute<{ id: string }>(sql`
      select id from accounts
       where org_id = ${orgId} and is_active = true and is_summary = false and id in ${accountIds}`));
    const found = new Set(r.rows.map((x) => String(x.id)));
    const foreign = parsed.find((l) => l.accountId && !found.has(l.accountId));
    if (foreign) {
      throw new CustomGlLinesError(
        `custom_gl_lines script "${scriptName}" line ${parsed.indexOf(foreign) + 1}: unknown, inactive, or summary accountId "${foreign.accountId}"`,
      );
    }
  }
  const dimChecks = [
    ["departmentId", "department", "departments"],
    ["locationId", "location", "locations"],
    ["classId", "class", "classes"],
    ["projectId", "project", "projects"],
    ["subsidiaryId", "subsidiary", "subsidiaries"],
  ] as const;
  for (const [key, label, table] of dimChecks) {
    const refIds = [
      ...new Set(
        parsed.map((l) => l[key]).filter((x): x is string => typeof x === "string"),
      ),
    ];
    if (refIds.length === 0) continue;
    const r = (await db.execute<{ id: string }>(sql`
      select id from ${sql.raw(`"${table}"`)} where org_id = ${orgId} and id in ${refIds}`));
    const found = new Set(r.rows.map((x) => String(x.id)));
    const foreign = parsed.find((l) => l[key] && !found.has(l[key]!));
    if (foreign) {
      throw new CustomGlLinesError(
        `custom_gl_lines script "${scriptName}" line ${parsed.indexOf(foreign) + 1}: ${label} not found in this organization`,
      );
    }
  }

  // Secondary-book targets arrive with allocation rule support (A5); a script
  // line pinned to a non-primary book is refused rather than silently posted
  // to the primary book.
  const bookCodes = [...new Set(parsed.map((l) => l.bookCode).filter((x): x is string => typeof x === "string"))];
  if (bookCodes.length > 0) {
    const books = (await db.execute<{ code: string; isPrimary: boolean }>(sql`
      select code, is_primary as "isPrimary" from accounting_books where org_id = ${orgId}`));
    for (const code of bookCodes) {
      const book = books.rows.find((b) => b.code === code);
      if (!book) {
        throw new CustomGlLinesError(
          `custom_gl_lines script "${scriptName}": unknown book code "${code}"`,
        );
      }
      if (!book.isPrimary) {
        throw new CustomGlLinesError(
          `custom_gl_lines script "${scriptName}": book code "${code}" is not the primary posting book`,
        );
      }
    }
  }

  // The set must balance per subsidiary among itself (null = the document
  // subsidiary, defaulted at the seam — groups that balance separately still
  // balance combined). Bigint money, never floats.
  const bySubsidiary = new Map<string | null, string[]>();
  for (const line of parsed) {
    const group = bySubsidiary.get(line.subsidiaryId) ?? [];
    group.push(line.amount);
    bySubsidiary.set(line.subsidiaryId, group);
  }
  for (const [subsidiaryId, amounts] of bySubsidiary) {
    const total = sum(amounts);
    if (!isZero(total)) {
      throw new CustomGlLinesError(
        `custom_gl_lines script "${scriptName}" lines do not balance${subsidiaryId ? ` for subsidiary ${subsidiaryId}` : " (the document subsidiary)"} (sum=${total})`,
      );
    }
  }

  return parsed.map((line) => ({
    accountId: line.accountId ?? byCode.get(line.accountCode!)!,
    amount: line.amount,
    subsidiaryId: line.subsidiaryId,
    departmentId: line.departmentId,
    projectId: line.projectId,
    locationId: line.locationId,
    classId: line.classId,
    memo: line.memo,
    contributorKind: "script" as const,
    contributorRef: scriptId,
  }));
}
