import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

// F-t11-008: a/d open the finding drawer to complete apply/dismiss (there is
// no instant write path) — the legend must say so in EVERY locale, not promise
// that the keys apply/dismiss directly. The drawer word differs per locale
// ((drawer), (tiroir), (panel), (Seitenbereich), (painel), （ドロワー）, （抽屉）),
// so the rule is structural, not a word pin: the hint splits into one segment
// per key, and both the a-action segment and the d-action segment carry a
// parenthetical qualifier (half- or full-width parens).
const LOCALES = ["en", "fr", "es", "de", "ja", "pt-BR", "zh"] as const;

const hint = (locale: string): string => {
  const catalog = JSON.parse(
    readFileSync(join(root, "web", "messages", locale, "agents.json"), "utf8"),
  ) as { triage?: { hint?: unknown } };
  const hint = catalog.triage?.hint;
  assert.equal(typeof hint, "string", `${locale} triage.hint must exist`);
  return hint as string;
};

for (const locale of LOCALES) {
  test(`F-t11-008: shortcut legend qualifies a/d as drawer flows in ${locale}`, () => {
    const segments = hint(locale)
      .split("·")
      .map((part) => part.trim());
    const apply = segments.find((part) => part.startsWith("a "));
    const dismiss = segments.find((part) => part.startsWith("d "));
    assert.ok(apply, `${locale} legend must have an a-action segment`);
    assert.ok(dismiss, `${locale} legend must have a d-action segment`);
    assert.match(
      apply,
      /[\(（][^\)）]+[\)）]/,
      `${locale} must qualify the a action as a drawer flow, not a direct apply`,
    );
    assert.match(
      dismiss,
      /[\(（][^\)）]+[\)）]/,
      `${locale} must qualify the d action as a drawer flow, not a direct dismiss`,
    );
  });
}
