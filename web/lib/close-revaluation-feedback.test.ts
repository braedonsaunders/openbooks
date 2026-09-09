import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// Exercise the actual client handler with its effects supplied at the closure
// boundary, without importing Next's router or rendering the entire wizard.
const source = ts.createSourceFile("CloseWizard.tsx", readFileSync(
  new URL("../app/(app)/close/CloseWizard.tsx", import.meta.url), "utf8",
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler: ts.FunctionDeclaration | undefined;
function findHandler(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "runRevaluation") handler = node;
  ts.forEachChild(node, findHandler);
}
findHandler(source);
assert.ok(handler, "the close wizard must expose the revaluation action");
const executable = ts.transpileModule(handler.getText(source), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

type Result = { posted: object[]; skipped: object[]; problems: string[] };
async function invoke(result: Result | Error) {
  const busy: boolean[] = [];
  const feedback: { kind: string; message: string; description?: string }[] = [];
  let refreshed = 0;
  const notification = (kind: string) => (message: string, options?: { description?: string }) => {
    feedback.push({ kind, message, description: options?.description });
  };
  const run = new Function("call", "props", "setBusy", "toast", "t", "router",
    `${executable}\nreturn runRevaluation;`)(
    async (url: string, body: { periodId: string }) => {
      assert.equal(url, "/api/close/run-revaluation");
      assert.deepEqual(body, { periodId: "test-period" });
      if (result instanceof Error) throw result;
      return result;
    },
    { run: { period_id: "test-period" } },
    (value: boolean) => busy.push(value),
    { success: notification("success"), error: notification("error"), info: notification("info") },
    (key: string) => key,
    { refresh: () => { refreshed++; } },
  ) as () => Promise<void>;
  await run();
  assert.deepEqual(busy, [true, false]);
  return { feedback, refreshed };
}

test("revaluation refusals surface every entity problem instead of claiming success", async () => {
  const result = await invoke({ posted: [], skipped: [], problems: ["Branch A: no spot rate", "Branch B: inactive"] });
  assert.deepEqual(result, { refreshed: 1, feedback: [{ kind: "error", message: "Branch A: no spot rate\nBranch B: inactive", description: undefined }] });
});

test("partial revaluation shows failures and acknowledges posted siblings, then refreshes", async () => {
  const result = await invoke({ posted: [{}], skipped: [], problems: ["Branch B: no spot rate"] });
  assert.deepEqual(result, { refreshed: 1, feedback: [{ kind: "error", message: "Branch B: no spot rate", description: "messages.revaluationPosted" }] });
});

test("successful revaluation reports posting and refreshes", async () => {
  const result = await invoke({ posted: [{}], skipped: [], problems: [] });
  assert.deepEqual(result, { refreshed: 1, feedback: [{ kind: "success", message: "messages.revaluationPosted", description: undefined }] });
});

test("clean no-op refreshes without claiming to have posted a revaluation", async () => {
  const result = await invoke({ posted: [], skipped: [{}], problems: [] });
  assert.deepEqual(result, { refreshed: 1, feedback: [{ kind: "info", message: "messages.refresh", description: undefined }] });
});

test("request failure clears the busy state and shows the server error", async () => {
  const result = await invoke(new Error("request failed"));
  assert.deepEqual(result, { refreshed: 0, feedback: [{ kind: "error", message: "request failed", description: undefined }] });
});
