import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { decideGate } from "../flows/gates.ts";
import { getBenefitAward } from "../hrm/benefits/awards.ts";
import { activateBenefitProgram, addProgramMembership, createBenefitProgram, type CreateBenefitProgramQuery } from "../hrm/benefits/programs.ts";
import { mkHr } from "./hrm-harness.ts";

interface BenefitFixtureContext {
  orgId: string;
  actorId: string;
  subsidiaryId: string;
  componentId: string;
  currency?: string;
  effectiveFrom?: string;
}

/** Common native payroll-program construction; policy differences stay explicit at each call. */
export async function seedPayrollBenefitProgram(
  context: BenefitFixtureContext,
  policy: Pick<CreateBenefitProgramQuery, "code" | "name" | "family"> & Partial<CreateBenefitProgramQuery>,
  options: { employmentIds?: readonly string[]; activate?: boolean } = {},
) {
  const created = await createBenefitProgram({
    orgId: context.orgId,
    actorId: context.actorId,
    currency: context.currency ?? "CAD",
    effectiveFrom: context.effectiveFrom ?? "2026-01-01",
    legalEntityId: context.subsidiaryId,
    payComponentId: context.componentId,
    deliveryMethod: "payroll",
    ...policy,
  });
  for (const employmentId of options.employmentIds ?? []) {
    await addProgramMembership({ orgId: context.orgId, actorId: context.actorId, programId: created.id,
      employmentId, effectiveFrom: context.effectiveFrom ?? "2026-01-01" });
  }
  return options.activate === false ? created
    : activateBenefitProgram({ orgId: context.orgId, actorId: context.actorId, programId: created.id });
}

/** Role grants and entity restrictions use the existing native actor fixture, never user overrides. */
export async function seedBenefitRoleActors<const K extends string>(orgId: string, actors: Record<K, {
  name: string; roleKey: string; permissions: string[]; subsidiaryIds?: string[] | null;
}>): Promise<Record<K, string>> {
  const ids = {} as Record<K, string>;
  for (const key of Object.keys(actors) as K[]) {
    const actor = actors[key];
    ids[key] = await mkHr(orgId, actor.name, actor.roleKey, actor.subsidiaryIds ?? null, actor.permissions);
  }
  return ids;
}

/** Decide the real pending gate; financial scenarios never manufacture an approved award. */
export async function approveBenefitFixture(query: { orgId: string; actorId: string; awardId: string }, message = "the configured approval policy must create a real pending gate") {
  const gate = (await db.execute<{ id: string }>(sql`
    select id from flow_gates where org_id=${query.orgId} and subject_kind='hrm_benefit_award'
      and subject_id=${query.awardId} and status='pending'
  `)).rows[0];
  assert.ok(gate, message);
  await decideGate({ gateId: gate.id, userId: query.actorId, decision: "approved" });
  return getBenefitAward(db, query.orgId, query.actorId, query.awardId);
}
