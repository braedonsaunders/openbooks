import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { stubModules } from "../../../../testing/stub-modules";
import { BenefitsError } from "@openbooks/engine/hrm/benefits/errors";

Object.assign(globalThis, { React: await import("react") });

const state = { calls: [] as unknown[][], nativeKind: "insured", refused: false };
(globalThis as Record<string, unknown>).__programDrawerAction = state;
const authz = { user: { orgId: "authorized-tenant", id: "authorized-actor" } };
(globalThis as Record<string, unknown>).__programDrawerAuthz = authz;
const errorsUrl = new URL("../../../../../engine/src/hrm/benefits/errors.ts", import.meta.url).href;
stubModules({
  extra: {
    "server-only": "export {}",
    "../../../../lib/authz": `export async function requirePermission(permission) { globalThis.__programDrawerAction.calls.push(['permission',permission]); return globalThis.__programDrawerAuthz }`,
    "../../../../lib/feature-gates": `export async function requireFeatureEnabled(org,feature) { globalThis.__programDrawerAction.calls.push(['feature',org,feature]) }`,
    "@openbooks/engine/platform/database": "export const db = {}",
    "@openbooks/engine/hrm/benefits": `
    export { BenefitsError } from ${JSON.stringify(errorsUrl)};
    export async function resolveBenefitsProgram(exec,org,actor,id) {
      const s=globalThis.__programDrawerAction; s.calls.push(['identity',org,actor,id]);
      if(s.refused) throw globalThis.__programDrawerRefusal;
      return { program:{id,nativeKind:s.nativeKind} };
    }
    export async function getBenefitsProgramWorkspace(exec,org,actor,id,query) {
      const s=globalThis.__programDrawerAction; s.calls.push(['evidence',org,actor,id,query]);
      return {program:{id,nativeKind:s.nativeKind}};
    }`,
    "../../../../lib/hrm/benefits": `export async function loadBenefits(authz,sp) { globalThis.__programDrawerAction.calls.push(['portfolio',sp.program]); return {programDrawer:{},programEditOpen:false} }`,
    "../../../../components/viewspec/blocks": "export function BlockList() { return null }",
    "./ProgramWorkspace": "export function ProgramWorkspace() { return null }",
    "./view": "export function benefitsProgramRecordBlocks() { return [] }",
  },
});
const { loadBenefitProgramDrawer } = await import("./program-drawer-action");
const id = "00000000-0000-4000-8000-000000000042";
beforeEach(() => {
  state.calls.length = 0;
  state.nativeKind = "insured";
  state.refused = false;
});

test("every program read uses the authenticated tenant and actor, validates page bounds and preserves native scope refusals", async () => {
  const result = await loadBenefitProgramDrawer(
    `view=programs&program=${id}&orgId=untrusted-tenant&participantsPage=2`,
  );
  assert.ok(result.content);
  assert.ok(
    state.calls.some(
      (call) =>
        call[0] === "identity" &&
        call[1] === authz.user.orgId &&
        call[2] === authz.user.id &&
        call[3] === id,
    ),
  );
  assert.deepEqual(state.calls.find((call) => call[0] === "evidence")?.[4], {
    participantOffset: 100,
    activityOffset: 0,
  });
  assert.ok(!state.calls.some((call) => call[0] === "portfolio"));
  state.calls.length = 0;
  const invalid = await loadBenefitProgramDrawer(`program=${id}&activityPage=0`);
  assert.match(invalid.error ?? "", /page is invalid/);
  assert.ok(!state.calls.some((call) => call[0] === "identity"));
  state.refused = true;
  (globalThis as Record<string, unknown>).__programDrawerRefusal = new BenefitsError(
    "NOT_FOUND",
    "Unavailable in your legal-entity scope; reopen Programs.",
  );
  const refused = await loadBenefitProgramDrawer(`program=${id}`);
  assert.match(refused.error ?? "", /legal-entity scope/);
  assert.equal(refused.content, undefined);
});

test("employer programs use their native record loader without duplicating participant and activity reads", async () => {
  state.nativeKind = "employer";
  assert.ok((await loadBenefitProgramDrawer(`view=programs&program=${id}`)).content);
  assert.ok(state.calls.some((call) => call[0] === "portfolio"));
  assert.ok(!state.calls.some((call) => call[0] === "evidence"));
});

test("entitlement programs retain their Payroll dependency and invalid or conflicting selections refuse before a record read", async () => {
  state.nativeKind = "entitlement";
  assert.ok((await loadBenefitProgramDrawer(`view=programs&program=${id}`)).content);
  assert.ok(state.calls.some((call) => call[0] === "feature" && call[2] === "payroll"));
  for (const query of [
    "program=new",
    "program=invalid",
    `program=${id}&award=new`,
    `program=${id}&plan=new`,
  ]) {
    state.calls.length = 0;
    assert.ok((await loadBenefitProgramDrawer(query)).error);
    assert.ok(!state.calls.some((call) => call[0] === "identity"));
  }
});
