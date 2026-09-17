import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

// F-t11-008: a/d open the finding drawer to complete apply/dismiss (there is
// no instant write path) — the legend must say so, not promise that the keys
// apply/dismiss directly.
const hint = (locale: string): string => {
  const catalog = JSON.parse(
    readFileSync(join(root, "web", "messages", locale, "agents.json"), "utf8"),
  ) as { triage?: { hint?: unknown } };
  const hint = catalog.triage?.hint;
  assert.equal(typeof hint, "string", `${locale} triage.hint must exist`);
  return hint as string;
};

test("F-t11-008: shortcut legend qualifies a/d as drawer flows", () => {
  assert.match(hint("en"), /a applies \(drawer\)/, "en must qualify apply");
  assert.match(hint("en"), /d dismisses \(drawer\)/, "en must qualify dismiss");
  assert.match(hint("fr"), /a appliquer \(tiroir\)/, "fr must qualify apply");
  assert.match(hint("fr"), /d rejeter \(tiroir\)/, "fr must qualify dismiss");
  assert.match(hint("es"), /a aplicar \(panel\)/, "es must qualify apply");
  assert.match(hint("es"), /d descartar \(panel\)/, "es must qualify dismiss");
});
