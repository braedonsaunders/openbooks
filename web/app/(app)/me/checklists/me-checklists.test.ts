import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Behaviour contract for the checklists page (/me/checklists). The spec
// builder runs over hand-built data: a refused read renders its title
// and remedy, and the steps table binds its rows with the tab strip in
// the header. Step completion rides the shared hrm-step-complete widget
// through the existing step endpoint — the widget contracts and the
// steps routes own that path, not this page.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { meChecklistsSpec } = await import("./view.ts");

function specJson(data: Record<string, unknown>): string {
  return JSON.stringify(meChecklistsSpec(data as never));
}

const TABS = [{ label: "Checklists", href: "/me/checklists" }];

test("a refused checklists read renders the remedy", () => {
  const json = specJson({ tabs: TABS, refusal: { title: "No checklists", message: "ask an administrator for a linked employment" } } as unknown as Record<string, unknown>);
  assert.ok(json.includes("\"empty-state\""), "the refusal renders through the empty-state block");
  assert.ok(json.includes("No checklists"), "the refusal title reaches the page");
  assert.ok(json.includes("ask an administrator for a linked employment"), "the refusal remedy reaches the page");
});

test("the steps table binds with the tab strip in the header", () => {
  const json = specJson({ tabs: TABS, refusal: null } as unknown as Record<string, unknown>);
  assert.ok(json.includes("\"module-home-tabs\""), "the header carries the tab strip");
  assert.ok(json.includes("/me/checklists"), "the strip links the checklists surface");
  assert.ok(json.includes("\"hrm-step-complete\""), "the row action rides the shared step-complete widget");
});
