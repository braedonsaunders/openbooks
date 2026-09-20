import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("./documents.ts", import.meta.url), "utf8");

test("posted correction routes approval flows inside the idempotent command", () => {
  const commandStart = SOURCE.indexOf("export async function correctPostedDocument");
  assert.ok(commandStart >= 0, "correctPostedDocument must exist");
  const command = SOURCE.slice(commandStart);
  const callbackStart = command.indexOf("execute: async () => {");
  assert.ok(callbackStart >= 0, "correction must use an idempotent execute callback");
  const callbackEnd = command.indexOf("\n      }\n    },", callbackStart);
  assert.ok(callbackEnd > callbackStart, "idempotent execute callback must be closed");

  const dispatch = command.indexOf("runPostedCorrectionDraftFlows(", callbackStart);
  assert.ok(
    dispatch > callbackStart && dispatch < callbackEnd,
    "approval routing must run before the idempotent callback commits",
  );
  assert.equal(
    command.indexOf("if (!outcome.replayed)", callbackEnd),
    -1,
    "completed idempotency replays must not bypass correction routing",
  );
});

test("application document reads and refusal policy use engine boundaries", () => {
  assert.match(SOURCE, /import \{ controlDeps, loadDocument \} from "@openbooks\/engine\/src\/records\/document-service\.ts"/);
  assert.match(SOURCE, /import \{ DocumentEditError \} from "@openbooks\/engine\/src\/records\/document-edit-policy\.ts"/);
  const webImport = SOURCE.match(/import \{([^}]+)\} from "\.\.\/documents"/);
  assert.ok(webImport);
  assert.deepEqual(webImport[1]!.split(',').map((name) => name.trim()).filter(Boolean).sort(), [
    'createPostedCorrectionDraft', 'isDocKindEnabled', 'runPostedCorrectionDraftFlows',
  ]);
  for (const name of ['document-service', 'document-edit-policy', 'document-input']) {
    const engineSource = readFileSync(new URL(`../../../engine/src/records/${name}.ts`, import.meta.url), 'utf8');
    assert.doesNotMatch(engineSource, /(?:from\s+|import\s*)['"][^'"]*(?:web\/|server-only|next\/|org-scope)/);
  }
});
