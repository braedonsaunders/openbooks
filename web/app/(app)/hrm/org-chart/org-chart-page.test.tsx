import assert from "node:assert/strict";
import test from "node:test";

// Behaviour contract for the org-chart tree (/hrm/org-chart). These tests
// RENDER the tree with hand-built charts: nodes show names with vacancy
// dashed and no pay anywhere, collapsing hides children behind
// aria-expanded, search expands into matches, and an empty chart states
// so. The as-of resolution and row scope stay covered by
// engine/src/hrm/org-chart.integration.test.ts, which owns the chart
// read — this widget renders what the loader resolved.

// jsdom first: the tree reads browser globals at render.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/hrm/org-chart",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}

const { registerHooks } = await import("node:module");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export function useRouter(){return { push(){}, refresh(){} }} export function useSearchParams(){return { get(k){ return k === 'q' ? (globalThis.__orgChartQuery ?? null) : null } }}",
      };
    }
    return next(specifier, context);
  },
});

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
// Dynamic: the tree resolves next/navigation through the stub above, so
// it must load after the hook registers.
const { OrgChartTree } = await import("./sections");

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

const LABELS = {
  empty: "No employments",
  expand: "Expand",
  collapse: "Collapse",
  vacant: "Vacant",
  span: "Span of control",
};

function node(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    employmentId: "e-1",
    positionId: "p-1",
    name: "Ada",
    title: "Engineer",
    positionCode: "ENG",
    department: "Shop",
    vacant: false,
    spanOfControl: 1,
    children: [],
    ...overrides,
  };
}

const CHART = {
  roots: [
    node({
      employmentId: "e-boss",
      name: "Boss",
      title: "Manager",
      spanOfControl: 2,
      children: [
        node({ employmentId: "e-ada", name: "Ada", spanOfControl: 0, children: [] }),
        node({
          employmentId: null,
          positionId: "p-open",
          name: "",
          title: null,
          vacant: true,
          spanOfControl: 0,
          children: [],
        }),
      ],
    }),
  ],
};

async function mountTree(chart: unknown): Promise<() => Promise<void>> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<OrgChartTree chart={chart as never} personBaseHref="/hrm/org-chart?asOf=2026-09-22" labels={LABELS} />);
    await tick();
  });
  await tick();
  return async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  };
}

function textOf(): string {
  return document.body.textContent ?? "";
}

// The desktop tree is the first list; the narrow-screen card stack below
// it always renders every node flat, so collapse assertions scope here.
function treeOf(): Element {
  const tree = document.querySelectorAll("ul")[0];
  assert.ok(tree, "the desktop tree renders");
  return tree;
}

function treeText(): string {
  return treeOf().textContent ?? "";
}

test("nodes render names with vacancy dashed and no pay anywhere", async (t) => {
  const unmount = await mountTree(CHART);
  t.after(unmount);

  const text = textOf();
  assert.ok(text.includes("Boss"), "the root name renders");
  assert.ok(text.includes("Ada"), "children render expanded by default");
  assert.ok(text.includes("Vacant"), "vacant nodes read as vacant, never blank");
  for (const pay of ["salary", "Salary", "compensation", "Compensation", "wage", "$"]) {
    assert.ok(!text.includes(pay), `no pay concept renders (${pay})`);
  }
  const vacantButton = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Vacant"));
  assert.ok(vacantButton?.hasAttribute("disabled"), "vacant nodes offer no person drawer");
});

test("collapsing hides children behind aria-expanded", async (t) => {
  const unmount = await mountTree(CHART);
  t.after(unmount);

  assert.ok(treeText().includes("Ada"), "the child renders expanded by default");
  const toggle = [...treeOf().querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Collapse");
  assert.ok(toggle, "the parent offers its collapse toggle");
  assert.equal(toggle?.getAttribute("aria-expanded"), "true", "expanded reads expanded");
  await act(async () => {
    (toggle as HTMLElement).click();
    await tick();
  });
  await tick();
  assert.ok(!treeText().includes("Ada"), "collapsing hides the children");
  assert.equal(
    [...treeOf().querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Expand")?.getAttribute("aria-expanded"),
    "false",
    "collapsed reads collapsed",
  );
});

test("search expands into matches", async (t) => {
  (globalThis as Record<string, unknown>).__orgChartQuery = "ada";
  const unmount = await mountTree(CHART);
  t.after(unmount);
  t.after(() => {
    (globalThis as Record<string, unknown>).__orgChartQuery = null;
  });

  assert.ok(textOf().includes("Ada"), "the match renders");
  const match = [...document.querySelectorAll("div")].find((d) => d.className.includes("ring-2"));
  assert.ok(match, "the match highlights into view");
});

test("an empty chart states so instead of an empty card", async (t) => {
  const unmount = await mountTree({ roots: [] });
  t.after(unmount);
  assert.ok(textOf().includes("No employments"), "the empty chart states so");
});
