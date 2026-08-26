import { newAsyncContext } from "./quickjs.ts";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
// Named export, NOT the default: under ESM/tsx the default import resolves to
// the module namespace (no .parse), so computeNextRunAt silently returned
// null and scheduled scripts never ran. CronExpressionParser.parse works
// under both CJS and ESM interop.
import { CronExpressionParser } from "cron-parser";
import { db, schema } from "./db.ts";
import { runUserSql } from "./sqlapi.ts";
import { createScriptJournal } from "./journal-writes.ts";

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
 *   ob.runtime               { org, trigger, user } -- read-only context info
 *   ob.record.load(t, id)    load one row by id (convenience over ob.query)
 *   ob.search(t, filters)    search rows by key=value filters
 *   ob.journal.create(input[, {post}])
 *                            governed ledger write: create a BALANCED draft
 *                            journal (engine/src/journal-writes.ts). post:true
 *                            runs the posting engine and is allowed only
 *                            outside before_* triggers (no posting reentrancy
 *                            while another document is mid-post).
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

/** Domain-boundary gate for every script execution path. */
export async function scriptingFeatureEnabled(orgId: string): Promise<boolean> {
  const result = (await db.execute<{ enabled: string | null }>(sql`
    select settings #>> '{features,scripts}' as enabled
      from orgs
     where id = ${orgId}
  `));
  return result.rows[0]?.enabled === "true";
}

export async function runScript(
  source: string,
  ctx: ScriptContext,
  timeoutMs: number,
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

    const queryFn = vm.newAsyncifiedFunction("__query", async (sqlH) => {
      const sqlText = String(vm.dump(sqlH));
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
    const journalFn = vm.newAsyncifiedFunction(
      "__journal_create",
      async (inputH, postH) => {
        const post = vm.dump(postH) === true;
        if (post && ctx.trigger.startsWith("before_")) {
          return {
            error: vm.newError(
              `journal.create: post:true is not allowed in ${ctx.trigger} (create a draft instead)`,
            ),
          };
        }
        try {
          const input = JSON.parse(String(vm.dump(inputH)));
          const result = await createScriptJournal(
            ctx.org.id,
            ctx.user?.id ?? null,
            input,
            { post },
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
      ${source}
      ;(() => {
        const ctx = ${JSON.stringify(ctx)};
        const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
        deepFreeze(ctx);

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
): Promise<ScriptOutcome> {
  if (!(await scriptingFeatureEnabled(orgId))) throw new Error("scripts feature is disabled");
  const [s] = await db
    .select()
    .from(schema.userScripts)
    .where(
      and(
        eq(schema.userScripts.id, scriptId),
        eq(schema.userScripts.orgId, orgId),
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

  const ctx: ScriptContext = {
    trigger: "scheduled",
    org: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
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
 * consumed on the worker via the scripts queue, with inline fallback.
 */
export async function runBulkScript(
  scriptId: string,
  orgId: string,
): Promise<ScriptOutcome> {
  if (!(await scriptingFeatureEnabled(orgId))) throw new Error("scripts feature is disabled");
  const [s] = await db
    .select()
    .from(schema.userScripts)
    .where(
      and(
        eq(schema.userScripts.id, scriptId),
        eq(schema.userScripts.orgId, orgId),
      ),
    );
  if (!s) throw new Error("script not found");

  const [org] = await db
    .select()
    .from(schema.orgs)
    .where(eq(schema.orgs.id, orgId));
  if (!org) throw new Error("org not found");

  const ctx: ScriptContext = {
    trigger: "bulk",
    org: { id: org.id, name: org.name, baseCurrency: org.baseCurrency },
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
