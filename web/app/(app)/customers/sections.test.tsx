import assert from "node:assert/strict";
import test from "node:test";

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/link") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export default function Link(p){return p.children}",
      };
    }
    return next(specifier, context);
  },
});

const React = await import("react");
const { renderToString } = await import("react-dom/server");
const { ArPulse } = await import("./sections");

// F-t12-012: the AR-pulse hero truncated large amounts at 390px — each
// third of the row is ~100px and the unbroken tabular figures overflowed
// their grid cells. Value cells must shrink (min-w-0) and wrap
// (break-words) instead of clipping; desktop padding is unchanged.
test("F-t12-012: hero amounts wrap instead of truncating on narrow screens", () => {
  const html = renderToString(
    <ArPulse
      outstanding="$12,345,678.90"
      overdue="$1,234,567.89"
      overdueIsNegative
      dso="48.2"
      labels={{ open: "Open", overdue: "Overdue", dso: "DSO", cta: "View all" }}
      href="/ar"
    />,
  );
  assert.ok(html.includes("$12,345,678.90"), "hero amounts must render in full");
  const valueCells = [...html.matchAll(/<p class="([^"]*)">(?:\$|48\.2)/g)];
  assert.equal(valueCells.length, 3, "all three hero values must render");
  for (const cell of valueCells) {
    assert.match(cell[1]!, /break-words/, "hero values must wrap, never clip");
  }
  assert.match(html, /min-w-0/, "hero grid cells must shrink below content width");
});
