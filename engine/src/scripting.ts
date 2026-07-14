import { getQuickJS } from "quickjs-emscripten";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { db, schema } from "./db.ts";

/**
 * User scripting: REAL JavaScript (ES2023), executed in a QuickJS sandbox —
 * a separate WASM-hosted engine with no access to Node, the filesystem, the
 * network, or the database connection. The SuiteScript idea, minus the
 * proprietary runtime and the 2010s JavaScript.
 *
 * Contract: a script defines  function main(ctx) { ... }
 *   ctx = { trigger, document, lines, org }   (plain data, deep-frozen copy)
 *   ob.log(...)              collect log lines (persisted to script_runs)
 *   ob.abort("reason")       veto the operation
 *   return { set: {field: value} }  to mutate whitelisted header fields
 *
 * Limits: interrupt-based timeout, 64 MB memory, 1 MB stack.
 */

export interface ScriptContext {
  trigger: string;
  document: Record<string, unknown>;
  lines: Record<string, unknown>[];
  org: { id: string; name: string; baseCurrency: string };
}

export interface ScriptOutcome {
  scriptId: string;
  name: string;
  status: "ok" | "aborted" | "error" | "timeout";
  set?: Record<string, unknown>;
  abortReason?: string;
  logs: string[];
  durationMs: number;
}

const MUTABLE_FIELDS = new Set([
  "memo", "internalNotes", "expectedPayDate", "paymentHoldReason", "dueDate",
  "departmentId", "projectId", "locationId", "classId", "custom",
]);

export async function runScript(
  source: string,
  ctx: ScriptContext,
  timeoutMs: number,
): Promise<Omit<ScriptOutcome, "scriptId" | "name">> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const vm = runtime.newContext();

  const logs: string[] = [];
  const started = Date.now();
  try {
    // host functions
    const obHandle = vm.newObject();
    const logFn = vm.newFunction("log", (...args) => {
      logs.push(args.map((a) => JSON.stringify(vm.dump(a))).join(" "));
    });
    const abortFn = vm.newFunction("abort", (reasonH) => {
      const reason = vm.dump(reasonH);
      const err = vm.newError(`__OB_ABORT__${String(reason)}`);
      const thrown = { value: err } as const;
      return thrown as never;
    });
    vm.setProp(obHandle, "log", logFn);
    vm.setProp(obHandle, "abort", abortFn);
    vm.setProp(vm.global, "ob", obHandle);
    logFn.dispose(); abortFn.dispose(); obHandle.dispose();

    const program = `
      ${source}
      ;(() => {
        const ctx = ${JSON.stringify(ctx)};
        const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
        deepFreeze(ctx);
        if (typeof main !== "function") throw new Error("script must define function main(ctx)");
        const out = main(ctx);
        return JSON.stringify(out ?? null);
      })()
    `;
    const result = vm.evalCode(program);
    if (result.error) {
      const err = vm.dump(result.error);
      result.error.dispose();
      const msg = typeof err === "object" && err && "message" in err ? String((err as any).message) : String(err);
      if (msg.startsWith("__OB_ABORT__")) {
        return { status: "aborted", abortReason: msg.slice("__OB_ABORT__".length), logs, durationMs: Date.now() - started };
      }
      if (Date.now() > deadline) {
        return { status: "timeout", logs, durationMs: Date.now() - started };
      }
      return { status: "error", abortReason: msg, logs, durationMs: Date.now() - started };
    }
    const raw = vm.dump(result.value);
    result.value.dispose();
    const parsed = raw === null || raw === "null" ? null : JSON.parse(raw as string);
    let set: Record<string, unknown> | undefined;
    if (parsed && typeof parsed === "object" && parsed.set && typeof parsed.set === "object") {
      set = {};
      for (const [k, v] of Object.entries(parsed.set)) {
        if (!MUTABLE_FIELDS.has(k)) throw new Error(`script tried to set non-whitelisted field "${k}"`);
        set[k] = v;
      }
    }
    return { status: "ok", set, logs, durationMs: Date.now() - started };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}

/** Run all active scripts for a trigger point + document kind, in order. */
export async function runTriggerScripts(
  trigger: "before_submit" | "before_post" | "after_post" | "before_void",
  ctx: ScriptContext,
  targetId: string,
): Promise<ScriptOutcome[]> {
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
          eq(schema.userScripts.documentKind, String(ctx.document.kind ?? "")),
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
      targetKind: String(ctx.document.kind ?? trigger),
      targetId,
      status: res.status,
      logs: res.logs,
      errorMessage: res.status === "ok" ? null : res.abortReason,
      durationMs: res.durationMs,
    });
    if (res.status === "aborted" || res.status === "error" || res.status === "timeout") break;
  }
  return outcomes;
}
