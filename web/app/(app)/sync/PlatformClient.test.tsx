import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const client = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "PlatformClient.tsx"),
  "utf8",
);

function actionSource(name: string, nextName: string): string {
  const start = client.indexOf(`async function ${name}`);
  const end = client.indexOf(`\n  async function ${nextName}`, start);
  assert.ok(start >= 0, `${name} action must exist`);
  assert.ok(end > start, `${name} action boundary must exist`);
  // Code only: a comment that explains the rule ("never a SyntaxError from
  // res.json()") must not read as a parse.
  return client.slice(start, end).replace(/\/\/.*$/gm, "");
}

test("mirror toggle checks the PATCH response before refreshing", () => {
  const action = actionSource("toggleMirror", "setMirrorSchedule");
  const statusGuard = action.indexOf("if (!res.ok)");
  const reload = action.indexOf("await load()");

  // The contract, not the text: the status is checked before anything is
  // parsed or refreshed, the failure branch throws (so the catch toasts it),
  // and no body is read before the guard. The exact expression is free to
  // improve — it did once, from a body parse to readApiErrorMessage.
  assert.match(action, /const res = await fetch\(/);
  assert.ok(statusGuard >= 0, "the PATCH response status is checked");
  assert.match(action, /if \(!res\.ok\) throw new Error\(/, "a failed PATCH throws into the catch");
  const firstParse = action.indexOf(".json(");
  assert.ok(firstParse === -1 || firstParse > statusGuard, "no body is parsed before the status check");
  assert.ok(reload > statusGuard, "the list refreshes only after the status check");
  assert.match(action, /catch \(error\) \{\s*toast\.error\(\(error as Error\)\.message\);/);
});

test("connection removal only refreshes and toasts after a successful DELETE", () => {
  const action = actionSource("remove", "copy");
  const statusGuard = action.indexOf("if (!res.ok)");
  const reload = action.indexOf("await load()");
  const successToast = action.indexOf('toast.success(t("toast.removed"))');

  // The contract: status checked first, failure thrown into the catch, no
  // body parsed before the guard (a DELETE has no body worth parsing), and
  // the refresh and the success toast strictly after a successful response.
  assert.match(action, /const res = await fetch\(/);
  assert.ok(statusGuard >= 0, "the DELETE response status is checked");
  assert.match(action, /if \(!res\.ok\) throw new Error\(/, "a failed DELETE throws into the catch");
  const firstParse = action.indexOf(".json(");
  assert.ok(firstParse === -1 || firstParse > statusGuard, "no body is parsed before the status check");
  assert.ok(reload > statusGuard && successToast > reload, "refresh, then toast, only after success");
  assert.match(action, /catch \(error\) \{\s*toast\.error\(\(error as Error\)\.message\);/);
});
