import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { ReactElement } from "react";

// E53: every numeric widget prop crossed Number(), so a non-numeric value
// ('abc' from a hand-written spec) rendered NaN. Every site now uses the num
// guard, which treats NaN/Infinity/non-numbers as absent so the widget falls
// back to its default. E58: an unknown document kind crashed the row through
// a non-null DOC_KINDS assertion; it renders a refused-row state instead.

// The families compose native pages whose graph pulls stylesheets and
// server-only markers that plain tsx cannot load. Stub those out: calling a
// widget builds its element without rendering the native component.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (/\.(css|scss|sass|less)(\?[^"]*)?$/.test(specifier)) {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export default {}" };
    }
    return nextResolve(specifier, context);
  },
});

const React = await import("react");
Object.assign(globalThis, { React });
const { renderToStaticMarkup } = await import("react-dom/server");
const { BANKING_WIDGETS } = await import("./widgets-banking");
const { AGENTS_WIDGETS } = await import("./widgets-agents");
const { CONTROLS_WIDGETS } = await import("./widgets-controls");
const { OPERATIONS_WIDGETS } = await import("./widgets-operations");
const { SETUP_WIDGETS } = await import("./widgets-setup");
const { RECORDS_WIDGETS } = await import("./widgets-records");
hooks.deregister();

function propsOf(node: unknown): Record<string, unknown> {
  return (node as ReactElement).props as Record<string, unknown>;
}

test("non-numeric amounts fall back to the default instead of NaN", () => {
  const roster = propsOf(BANKING_WIDGETS["banking-roster"]({ totalCash: "abc", totalCards: "abc" }));
  assert.equal(roster.totalCash, 0);
  assert.equal(roster.totalCards, 0);
  const recon = propsOf(
    BANKING_WIDGETS["reconcile-workspace"]({ stmtTotal: "abc", glTotal: "abc", matchedTotal: "abc" }),
  );
  assert.equal(recon.stmtTotal, 0);
  assert.equal(recon.glTotal, 0);
  assert.equal(recon.matchedTotal, 0);
  assert.equal(propsOf(AGENTS_WIDGETS["metric-tile"]({ value: "abc" })).value, 0);
  const counts = propsOf(CONTROLS_WIDGETS["row-counts-cell"]({ created: "abc", updated: "abc", failed: "abc" }));
  assert.equal(counts.created, 0);
  assert.equal(counts.updated, 0);
  assert.equal(counts.failed, 0);
  assert.equal(propsOf(OPERATIONS_WIDGETS["close-readiness-cell"]({ readiness: "abc" })).readiness, 0);
  assert.equal(propsOf(OPERATIONS_WIDGETS["new-filing"]({ defaultYear: "abc" })).defaultYear, 0);
  const hero = propsOf(
    SETUP_WIDGETS["setup-readiness-hero"]({
      progressPercent: "abc",
      progressMin: "abc",
      progressMax: "abc",
      progressNow: "abc",
    }),
  );
  assert.equal(hero.progressPercent, 0);
  assert.equal(hero.progressMin, 0);
  assert.equal(hero.progressMax, 0);
  assert.equal(hero.progressNow, 0);
});

test("genuine numbers still pass through untouched", () => {
  assert.equal(propsOf(BANKING_WIDGETS["banking-roster"]({ totalCash: 42.5 })).totalCash, 42.5);
  assert.equal(propsOf(AGENTS_WIDGETS["metric-tile"]({ value: 7 })).value, 7);
  assert.equal(propsOf(OPERATIONS_WIDGETS["new-filing"]({ defaultYear: 2026 })).defaultYear, 2026);
});

test("an unknown document kind renders a refused row, not a crash", () => {
  const html = renderToStaticMarkup(
    RECORDS_WIDGETS["document-row-actions"]({ kind: "frobnicator", id: "row-1" }) as ReactElement,
  );
  assert.ok(html.includes("Unknown document kind"), "the refusal must be visible");
  assert.ok(html.includes("frobnicator"), "the refusal must name the kind");
  assert.ok(html.includes('role="alert"'), "the refusal must be announced");
});

test("a known document kind still renders its row actions", () => {
  const node = RECORDS_WIDGETS["document-row-actions"]({ kind: "vendor_bill", id: "row-1" }) as ReactElement;
  assert.notEqual(node.type, "span", "a known kind must not render the refusal");
});
