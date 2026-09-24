import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Behaviour contract for the team page (/me/team). The spec builder runs
// over hand-built data: a refused read renders its title and remedy with
// the only decision surface being the deep link into approvals — no
// approve/decline widget exists on this page — and the tab strip rides
// the header. Roster scoping (one level, no matrix) stays covered by
// engine/src/hrm/self-service/scope.test.ts, which owns the team read.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { meTeamSpec } = await import("./view.ts");

function specJson(data: Record<string, unknown>): string {
  return JSON.stringify(meTeamSpec(data as never));
}

const TABS = [{ label: "Team", href: "/me/team" }];

test("a refused team read renders the remedy with decisions left to approvals", () => {
  const json = specJson({
    tabs: TABS,
    refusal: { title: "No team", message: "ask an administrator for a linked employment" },
  } as unknown as Record<string, unknown>);
  assert.ok(json.includes("\"empty-state\""), "the refusal renders through the empty-state block");
  assert.ok(json.includes("No team"), "the refusal title reaches the page");
  assert.ok(json.includes("ask an administrator for a linked employment"), "the refusal remedy reaches the page");
  assert.ok(json.includes("\"link-button\""), "the header keeps the approvals deep link");
  assert.ok(json.includes("\"decideInApprovals\""), "the deep link names deciding in approvals");
  assert.ok(!json.includes('"approve"'), "no approve widget exists on this page");
  assert.ok(!json.includes('"decline"'), "no decline widget exists on this page");
});

test("the tab strip rides the header", () => {
  const json = specJson({ tabs: TABS, refusal: null } as unknown as Record<string, unknown>);
  assert.ok(json.includes("\"module-home-tabs\""), "the header carries the tab strip");
  assert.ok(json.includes("/me/team"), "the strip links the team surface");
});
