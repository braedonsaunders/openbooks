import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveWebSchedulerMode } from "./scheduler-mode.ts";

const source = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

test("web scheduler is off by default — the worker owns scheduled ticks", () => {
  for (const env of [
    {},
    { NODE_ENV: "production" },
    { NODE_ENV: "development" },
    { NODE_ENV: "test" },
    { OPENBOOKS_RUN_SCHEDULER: "" },
    { OPENBOOKS_RUN_SCHEDULER: "0" },
    { OPENBOOKS_RUN_SCHEDULER: "yes" },
  ]) {
    const decision = resolveWebSchedulerMode(env);
    assert.equal(decision.enabled, false, `env ${JSON.stringify(env)} must not schedule`);
    assert.equal(decision.mode, "worker-only");
  }
});

test("OPENBOOKS_RUN_SCHEDULER=1 opts a production web replica into single-process mode", () => {
  const decision = resolveWebSchedulerMode({ NODE_ENV: "production", OPENBOOKS_RUN_SCHEDULER: "1" });
  assert.equal(decision.enabled, true);
  assert.equal(decision.mode, "web-opt-in");
  assert.match(decision.logLine, /ENABLED/);
});

test("next dev never schedules: OPENBOOKS_RUN_SCHEDULER=1 is refused in development", () => {
  const decision = resolveWebSchedulerMode({ NODE_ENV: "development", OPENBOOKS_RUN_SCHEDULER: "1" });
  assert.equal(decision.enabled, false);
  assert.equal(decision.mode, "web-refused-dev");
  assert.match(decision.logLine, /REFUSED/);
  assert.match(decision.logLine, /force/);
});

test("OPENBOOKS_RUN_SCHEDULER=force is the only development override", () => {
  const dev = resolveWebSchedulerMode({ NODE_ENV: "development", OPENBOOKS_RUN_SCHEDULER: "force" });
  assert.equal(dev.enabled, true);
  assert.equal(dev.mode, "web-forced-dev");
  const prod = resolveWebSchedulerMode({ NODE_ENV: "production", OPENBOOKS_RUN_SCHEDULER: "force" });
  assert.equal(prod.enabled, true);
  assert.equal(prod.mode, "web-opt-in");
});

test("every decision carries the one boot log line naming the mode", () => {
  for (const { env, pattern } of [
    { env: {}, pattern: /disabled.*worker process/ },
    {
      env: { NODE_ENV: "production", OPENBOOKS_RUN_SCHEDULER: "1" },
      pattern: /ENABLED.*single-process/,
    },
    {
      env: { NODE_ENV: "development", OPENBOOKS_RUN_SCHEDULER: "1" },
      pattern: /REFUSED/,
    },
    {
      env: { NODE_ENV: "development", OPENBOOKS_RUN_SCHEDULER: "force" },
      pattern: /ENABLED.*force/,
    },
  ]) {
    const decision = resolveWebSchedulerMode(env);
    assert.match(decision.logLine, /\[scheduler\]/);
    assert.ok(!decision.logLine.includes("\n"), "boot line must be a single line");
    assert.match(decision.logLine, pattern);
  }
});

test("web boots the scheduler only through the gate, never unconditionally", () => {
  const instrumentation = source("../../web/instrumentation.node.ts");
  assert.match(instrumentation, /resolveWebSchedulerMode/, "web must consult the scheduler gate");
  assert.match(
    instrumentation,
    /if \(decision\.enabled\)/,
    "ensureScheduler must run only when the gate allows it",
  );
  const gateCall = instrumentation.indexOf("resolveWebSchedulerMode");
  const startCall = instrumentation.indexOf("ensureScheduler()");
  assert.ok(gateCall > -1 && startCall > gateCall, "the gate decision precedes the scheduler start");
  assert.match(instrumentation, /console\.log\(decision\.logLine\)/, "web logs the one mode line at boot");
});

test("the worker process owns scheduled ticks", () => {
  const worker = source("./worker/index.ts");
  assert.match(
    worker,
    /from "\.\.\/scheduler\.ts"/,
    "the worker must import the scheduler it now owns",
  );
  assert.match(worker, /ensureScheduler\(\)/, "the worker must start the scheduler at boot");
});
