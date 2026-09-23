import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Restricted subsidiary-scoped views show manual/formula categories only
// with an attribution into the visible set; SQL-backed methods scope
// through their own accounts/parties, and unscoped or unrestricted views
// show everything (narrowing never hides what the caller may read).
test("category subsidiary visibility fails closed for restricted views", () => {
  const source = `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "../money-server") return { url: "data:text/javascript,export async function getMoneyFormatter() { return { money: String, moneyCompact: String } }", shortCircuit: true };
        return nextResolve(specifier, context);
      },
    });
    const { isCategoryVisibleInScope } = await import("./web/lib/cash/core.ts");
    const manual = { id: "m", name: "Rent", direction: "outflow", method: "manual_recurring", amount: "100.0000", frequency: "monthly" };
    const formula = { id: "f", name: "F", direction: "inflow", method: "formula_expression", formula: "{AR_IN}" };
    const gl = { id: "g", name: "G", direction: "outflow", method: "gl_history_average", accountIds: ["a"] };
    const restricted = new Set(["s1"]);
    // Unscoped views show everything, attributed or not.
    assert.equal(isCategoryVisibleInScope(manual, undefined, restricted), true);
    assert.equal(isCategoryVisibleInScope(formula, undefined, restricted), true);
    assert.equal(isCategoryVisibleInScope(gl, undefined, restricted), true);
    // Unrestricted callers see everything even when narrowing (never hide
    // what the caller may already read org-wide).
    assert.equal(isCategoryVisibleInScope(manual, ["s1"], null), true);
    assert.equal(isCategoryVisibleInScope(formula, ["s1"], null), true);
    // Restricted scoped views hide unattributed org-level models...
    assert.equal(isCategoryVisibleInScope(manual, ["s1"], restricted), false);
    assert.equal(isCategoryVisibleInScope(formula, ["s1"], restricted), false);
    assert.equal(isCategoryVisibleInScope({ ...manual, subsidiaryIds: [] }, ["s1"], restricted), false);
    assert.equal(isCategoryVisibleInScope({ ...manual, subsidiaryIds: ["s2"] }, ["s1"], restricted), false);
    // ...show attributions into the visible set...
    assert.equal(isCategoryVisibleInScope({ ...manual, subsidiaryIds: ["s1"] }, ["s1"], restricted), true);
    assert.equal(isCategoryVisibleInScope({ ...formula, subsidiaryIds: ["s2", "s1"] }, ["s1"], restricted), true);
    // ...and SQL-backed methods always pass (they scope their own reads).
    assert.equal(isCategoryVisibleInScope(gl, ["s1"], restricted), true);
    assert.equal(isCategoryVisibleInScope(gl, [], restricted), true);
    console.log("category subsidiary visibility passed: attributed shows, unattributed hides, SQL passes");
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
