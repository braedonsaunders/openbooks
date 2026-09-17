import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

// F-t12-012 redo: the shared cockpit StatTile clipped KPI labels, values,
// AND sublines with `truncate` at 390px ("ACTIVE CU…", "CA$…"), and the card
// itself (a grid item) could not shrink below its content. Labels/values/
// sublines must wrap instead of ellipsis, and the card must yield (min-w-0)
// so narrow grid columns engage wrapping instead of overflowing the page.
const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) {
    const path = root + "web/" + specifier.slice(2);
    for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) if (existsSync(new URL(path + suffix))) return next(path + suffix, context);
    return next(path, context);
  }
  return next(specifier, context);
} });

const React = await import("react");
const { renderToString } = await import("react-dom/server");
const { Users } = await import("lucide-react");
const { StatTile } = await import("./ui");

function paragraphs(html: string): string[] {
  return [...html.matchAll(/<p class="([^"]*)">/g)].map((m) => m[1]!);
}

test("F-t12-012: stat tiles wrap label, value, and sub instead of truncating", () => {
  const html = renderToString(
    <StatTile
      icon={Users}
      label="ACTIVE CUSTOMERS"
      value="CA$12,345,678.90"
      sub="CA$0 weighted pipeline"
    />,
  );
  assert.ok(html.includes("CA$12,345,678.90"), "hero amounts must render in full");
  const [label, value, sub] = paragraphs(html);
  assert.ok(label !== undefined && value !== undefined && sub !== undefined, "tile renders label, value, and sub");
  for (const [name, cls] of [["label", label], ["value", value], ["sub", sub]] as const) {
    assert.ok(!cls.split(" ").includes("truncate"), `${name} must wrap, never ellipsis`);
  }
  assert.match(value, /break-words/, "unbroken figures must wrap mid-string, never clip");
  assert.match(html, /min-w-0/, "tile card must shrink below content width in narrow grids");
});
