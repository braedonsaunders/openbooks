import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const read = (path: string) => readFileSync(join(dir, path), "utf8");
const ccPageSource = readFileSync(join(dir, "..", "continuous-close", "page.tsx"), "utf8");
const agentsView = read("./view.ts");

// F-t13-007: /continuous-close redirects to /agents with no notice. The route
// is intentionally retired (the workbench moved), so the redirect must carry
// context and /agents must explain the move once, on the record.
test("F-t13-007: retired route redirects with landing context", () => {
  // ?from= rides along with the preserved ?item= deep link.
  assert.match(ccPageSource, /params\.set\('from', 'continuous-close'\)/);
  assert.match(ccPageSource, /redirect\(`\/agents\$\{query/);
  assert.match(ccPageSource, /params\.set\('item', itemValue\)/);
});

test("F-t13-007: agents explains the move only on that landing", () => {
  assert.match(agentsView, /singleParam\(sp, 'from'\) === 'continuous-close'/);
  assert.match(agentsView, /movedNotice:\s*\{[^}]*title:[^}]*description:[^}]*dismissLabel/s);
  assert.match(agentsView, /widgetBlock\('moved-notice',/);
  assert.match(agentsView, /when: f\('movedNotice'\)/);
});

// New user-visible strings are catalog keys in all 7 locales, properly
// translated — never English pasted into a non-English catalog.
const messagesDir = join(dir, "..", "..", "..", "messages");
const catalog = (locale: string): Record<string, Record<string, unknown>> =>
  JSON.parse(readFileSync(join(messagesDir, locale, "agents.json"), "utf8")) as Record<
    string,
    Record<string, unknown>
  >;
const english = catalog("en").movedNotice as Record<string, string>;
assert.ok(english?.title, "en/agents.json must define movedNotice");
for (const locale of ["de", "es", "fr", "ja", "pt-BR", "zh"]) {
  test(`F-t13-007: moved notice is translated in ${locale}`, () => {
    const notice = catalog(locale).movedNotice as Record<string, string> | undefined;
    assert.ok(notice, `${locale}/agents.json must define movedNotice`);
    for (const key of ["title", "description", "dismiss"]) {
      const value: unknown = notice[key];
      assert.equal(typeof value, "string", `${locale} movedNotice.${key} must be a string`);
      assert.ok((value as string).trim().length > 0, `${locale} movedNotice.${key} must not be empty`);
    }
    assert.notEqual(notice.title, english.title, "title must not be the English fallback");
    assert.notEqual(
      notice.description,
      english.description,
      "description must not be the English fallback",
    );
  });
}
