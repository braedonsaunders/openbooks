import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const coreSource = readFileSync(join(import.meta.dirname, "core.ts"), "utf8");

// The orientation conventions derive from the canonical class map — a second
// handwritten list would silently miss a type the map gains tomorrow.
test("net conventions derive from the canonical account class map", () => {
  assert.doesNotMatch(coreSource, /"asset_bank",\s*\n\s*"asset_receivable"/);
  assert.doesNotMatch(coreSource, /"liability_payable",\s*\n\s*"liability_card"/);
  assert.match(coreSource, /ACCOUNT_CLASS_TYPES\.asset/);
  assert.match(coreSource, /ACCOUNT_CLASS_TYPES\.expense/);
  assert.match(coreSource, /ACCOUNT_CLASS_TYPES\.liability/);
  assert.match(coreSource, /ACCOUNT_CLASS_TYPES\.equity/);
  assert.match(coreSource, /ACCOUNT_CLASS_TYPES\.income/);
});

test("every account type in the universe maps to exactly one convention", () => {
  const source = `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "../money-server") return { url: "data:text/javascript,export async function getMoneyFormatter() { return { money: String, moneyCompact: String } }", shortCircuit: true };
        return nextResolve(specifier, context);
      },
    });
    const { netConvention, orientNetTotal } = await import("./web/lib/cash/core.ts");
    const { ACCOUNT_CLASS_TYPES } = await import("./engine/src/records/account-types.ts");
    const mapped = new Map();
    for (const [cls, types] of Object.entries(ACCOUNT_CLASS_TYPES)) {
      for (const type of types) {
        // One account, one unit of gross: the convention is exact, never a throw.
        const convention = netConvention([{ id: "x", type, gross: "1.0000" }]);
        assert.ok(convention === 1 || convention === -1, type);
        assert.ok(!mapped.has(type), "each type maps once: " + type);
        mapped.set(type, { cls, convention });
      }
    }
    // The partition is exact: debit-normal classes on one side, the rest on
    // the other, nothing unmapped and nothing on both.
    for (const [type, { cls, convention }] of mapped) {
      const expected = cls === "asset" || cls === "expense" ? 1 : -1;
      assert.equal(convention, expected, type + " (" + cls + ")");
    }
    // Orientation on the netted total: convention side forecasts, the other
    // side reports 0 with the flag (never cash the wrong way).
    assert.deepEqual(orientNetTotal("120.0000", 1), { total: "120.0000", againstDirection: false });
    assert.deepEqual(orientNetTotal("-1200.0000", -1), { total: "1200.0000", againstDirection: false });
    assert.deepEqual(orientNetTotal("150.0000", -1), { total: "0.0000", againstDirection: true });
    assert.deepEqual(orientNetTotal("0.0000", 1), { total: "0.0000", againstDirection: false });
    // Unknown types refuse by name instead of guessing a sign.
    assert.throws(() => netConvention([{ id: "x", type: "mystery", gross: "1.0000" }]), /unknown account type "mystery"/);
    console.log("net conventions passed: full universe maps, orientation exact, unknowns refuse");
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
