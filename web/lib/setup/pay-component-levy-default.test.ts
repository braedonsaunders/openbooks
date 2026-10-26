import assert from "node:assert/strict";
import test from "node:test";

// The fold is pure over the request body (no storage); only the module
// import is stubbed by server-only, exactly like the treatment-refusal test.
const { defaultPayComponentProgramExclusions, foldPayComponentSetupCreate } =
  await import("./write.ts");

test("a non-taxable earning gets the CA levy exclusions in its initial policy version", () => {
  assert.deepEqual(
    defaultPayComponentProgramExclusions({ kind: "earning", taxable: false, country: "CA" }),
    ["cnt", "eht", "hsf", "wcb"],
  );
  assert.deepEqual(
    foldPayComponentSetupCreate("pay-components", {
      kind: "earning",
      taxable: false,
      country: "CA",
    }),
    { kind: "earning", taxable: false, country: "CA" },
  );
});

test("a taxable earning is left alone", () => {
  const body = { kind: "earning", taxable: true, country: "CA" };
  assert.equal(foldPayComponentSetupCreate("pay-components", body), body);
});

test("an earning with no stated taxability is left alone", () => {
  const body = { kind: "earning", country: "CA" };
  assert.equal(foldPayComponentSetupCreate("pay-components", body), body);
});

test("explicit exclusions become the initial effective-dated policy", () => {
  const body = { kind: "earning", taxable: false, country: "CA", programExclusions: ["qpip"] };
  assert.equal(foldPayComponentSetupCreate("pay-components", body), body);
  assert.deepEqual(defaultPayComponentProgramExclusions(body), ["qpip"]);
  const empty = {
    kind: "earning",
    taxable: false,
    country: "CA",
    programExclusions: [] as string[],
  };
  assert.equal(foldPayComponentSetupCreate("pay-components", empty), empty);
  assert.deepEqual(defaultPayComponentProgramExclusions(empty), []);
});

test("other entities and employer contributions pass through untouched", () => {
  const account = { kind: "earning", taxable: false };
  assert.equal(foldPayComponentSetupCreate("payroll-filing-accounts", account), account);
  const contribution = { kind: "employer_contribution", country: "CA" };
  assert.equal(foldPayComponentSetupCreate("pay-components", contribution), contribution);
});

test("a new deduction starts outside the protected base unless it says otherwise", () => {
  // Disposable earnings are pay after deductions required by law: a 401(k)
  // deferral created with no stated membership must not shrink the base.
  assert.deepEqual(
    foldPayComponentSetupCreate("pay-components", { kind: "deduction", country: "US" }),
    { kind: "deduction", country: "US", includeInDisposableEarnings: false },
  );
  const required = { kind: "deduction", country: "US", includeInDisposableEarnings: true };
  assert.equal(foldPayComponentSetupCreate("pay-components", required), required);
});
