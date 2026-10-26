import assert from "node:assert/strict";
import test from "node:test";
import type { WarehouseData } from "./view";

const { warehouseSpec } = await import("./view");

// A typed inventory refusal inside the supply computation used to escape the
// warehouse loader out of SSR — the home's error page. The loader converts
// every typed refusal into the supply-refusal banner instead. These tests pin
// the spec half of that contract: given blocked supply figures, the page
// shows the banner (linking the report that refuses the same way) and hides
// the figure panels. (The loader half needs a database and has no unit
// interface.)
function blockedData(): WarehouseData {
  return {
    supplyReady: false,
    showSupplyRefusal: true,
    supplyRefusal: [
      {
        tone: "negative",
        text: 'Widget is raised in unit "box" with no conversion to the base unit "ea" — enter the quantity in ea, or add a "box" row',
        href: "/reports/availability",
      },
    ],
  } as unknown as WarehouseData;
}

function blocksOf(spec: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node === "object" && node !== null) {
      found.push(node as Record<string, unknown>);
      for (const value of Object.values(node)) visit(value);
    }
  };
  visit((spec as { body: unknown }).body);
  return found;
}

/** The panel (the node carrying `when`) that hosts a widget block. */
function panelHosting(spec: unknown, widget: string): Record<string, unknown>[] {
  return blocksOf(spec).filter(
    (node) =>
      Array.isArray(node.blocks) &&
      (node.blocks as Record<string, unknown>[]).some((block) => block.widget === widget),
  );
}

test("a supply refusal renders as a banner gated on the refusal flag", () => {
  const [panel] = panelHosting(warehouseSpec(blockedData()), "attention-list");
  assert.ok(panel, "the blocked home must render the supply-refusal banner");
  assert.deepEqual(
    panel.when,
    { $: "showSupplyRefusal" },
    "the banner shows exactly while the refusal is set",
  );
  const [banner] = panel.blocks as Record<string, unknown>[];
  assert.ok(banner, "the banner panel carries its attention list");
  const props = banner.props as Record<string, unknown>;
  const items = props.items as { tone: string; text: string; href: string }[];
  assert.equal(items.length, 1, "the banner carries the one refusal");
  const [first] = items;
  assert.ok(first, "the refusal is present");
  assert.match(first.text, /no conversion/, "the banner names the remedy");
  assert.equal(
    first.href,
    "/reports/availability",
    "the banner links the report that refuses the same way",
  );
});

test("the supply figure panels hide while the refusal is shown", () => {
  const pulses = panelHosting(warehouseSpec(blockedData()), "ap-pulse");
  assert.equal(pulses.length, 2, "both supply panels stay in the spec");
  for (const pulse of pulses) {
    assert.deepEqual(
      pulse.when,
      { $: "supplyReady" },
      "a figure panel shows only when its figures computed — no numbers beside the banner",
    );
  }
});
