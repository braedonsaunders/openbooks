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
  return client.slice(start, end);
}

test("mirror toggle checks the PATCH response before refreshing", () => {
  const action = actionSource("toggleMirror", "setMirrorSchedule");
  const statusGuard = action.indexOf("if (!res.ok)");
  const reload = action.indexOf("await load()");

  assert.match(action, /const res = await fetch\(/);
  assert.match(action, /const body = await res\.json\(\);/);
  assert.match(
    action,
    /if \(!res\.ok\) throw new Error\(body\.error \?\? `HTTP \$\{res\.status\}`\);/,
  );
  assert.ok(statusGuard >= 0 && reload > statusGuard);
  assert.match(action, /catch \(error\) \{\s*toast\.error\(\(error as Error\)\.message\);/);
});

test("connection removal only refreshes and toasts after a successful DELETE", () => {
  const action = actionSource("remove", "copy");
  const statusGuard = action.indexOf("if (!res.ok)");
  const reload = action.indexOf("await load()");
  const successToast = action.indexOf('toast.success(t("toast.removed"))');

  assert.match(action, /const res = await fetch\(/);
  assert.match(action, /const body = await res\.json\(\);/);
  assert.match(
    action,
    /if \(!res\.ok\) throw new Error\(body\.error \?\? `HTTP \$\{res\.status\}`\);/,
  );
  assert.ok(statusGuard >= 0 && reload > statusGuard && successToast > reload);
  assert.match(action, /catch \(error\) \{\s*toast\.error\(\(error as Error\)\.message\);/);
});
