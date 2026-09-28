import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
test("fund and release loaders read drawers through the canonical engine readers", () => {
  for (const [file, reader] of [["funds", "getFund"], ["releases", "getFundRelease"]] as const) {
    const source = readFileSync(`web/app/(app)/nonprofit/${file}/view.ts`, "utf8");
    assert.match(source, new RegExp(`${reader}\\({ orgId, \\w+Id }\\)`));
    assert.match(source, /return base[\s\S]*notFound\(\)/);
    assert.match(source, new RegExp(`closeHref: '/nonprofit/${file}'`));
    assert.doesNotMatch(source, file === "funds" ? /from funds f/ : /from fund_releases/);
  }
});
