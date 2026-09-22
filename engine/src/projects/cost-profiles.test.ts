import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_PROJECT_TYPES, type FinancialProfile } from "@openbooks/schema";
import { resolveCostProfiles, type CostProfileRow } from "./financials.ts";

// The batched cost reader must never price a misconfigured type at zero:
// a type row missing its billing classification is per-project error state
// the list renders beside the row, while complete rows win and anything
// else falls back to built-in time-and-materials (mirroring loadProjectType).

const builtinTm = BUILTIN_PROJECT_TYPES.find((t) => t.key === "time_and_materials")!.financialProfile;
const customProfile = { ...builtinTm, note: "custom fixture" } as FinancialProfile;

const row = (overrides: Partial<CostProfileRow> & { project_id: string }): CostProfileRow => ({
  type_id: null,
  bm: null,
  fp: null,
  has_ip: false,
  has_bp: false,
  ...overrides,
});

test("a complete type row wins its profile", () => {
  const { profiles, errors } = resolveCostProfiles([
    row({ project_id: "p1", type_id: "t1", bm: "time_and_materials", fp: customProfile, has_ip: true, has_bp: true }),
  ]);
  assert.equal(profiles.get("p1"), customProfile);
  assert.equal(errors.size, 0);
});

test("a type row missing its billing classification errors by name, never a profile", () => {
  const { profiles, errors } = resolveCostProfiles([
    row({ project_id: "p1", type_id: "t-broken", bm: null, fp: customProfile, has_ip: true, has_bp: true }),
  ]);
  assert.ok(!profiles.has("p1"), "no profile may resolve for the misconfigured row");
  assert.match(errors.get("p1") ?? "", /t-broken.*billing classification/);
});

test("an empty billing method string errors the same as a missing one", () => {
  const { profiles, errors } = resolveCostProfiles([
    row({ project_id: "p1", type_id: "t-broken", bm: "", fp: customProfile, has_ip: true, has_bp: true }),
  ]);
  assert.ok(!profiles.has("p1"));
  assert.ok(errors.has("p1"));
});

test("typeless and incomplete rows fall back to built-in time-and-materials", () => {
  const { profiles, errors } = resolveCostProfiles([
    row({ project_id: "p1" }),
    row({ project_id: "p2", type_id: "t-partial", bm: "time_and_materials", fp: null, has_ip: true, has_bp: true }),
  ]);
  assert.equal(profiles.get("p1"), builtinTm);
  assert.equal(profiles.get("p2"), builtinTm);
  assert.equal(errors.size, 0);
});

test("sibling rows are unaffected by one misconfigured row", () => {
  const { profiles, errors } = resolveCostProfiles([
    row({ project_id: "good", type_id: "t1", bm: "fixed_price", fp: customProfile, has_ip: true, has_bp: true }),
    row({ project_id: "bad", type_id: "t2", bm: null, fp: customProfile, has_ip: true, has_bp: true }),
  ]);
  assert.equal(profiles.get("good"), customProfile);
  assert.ok(!profiles.has("bad"));
  assert.deepEqual([...errors.keys()], ["bad"]);
});
