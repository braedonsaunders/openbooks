import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { lockBankMatchRuleSet } from "./banking-rule-set-lock";
import { validateCriteria, validateOutcome } from "./banking-rules-validate";

export class BankMatchRuleManagementError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "BankMatchRuleManagementError";
  }
}

type BankRuleInput = {
  name: string;
  criteria: unknown;
  outcome: unknown;
  priority?: number;
  isActive?: boolean;
};

function normalizeInput(input: BankRuleInput) {
  const name = input.name.trim();
  if (!name || name.length > 200)
    throw new BankMatchRuleManagementError("name required (max 200 chars)");
  const criteria = validateCriteria(input.criteria);
  if (!criteria.ok) throw new BankMatchRuleManagementError(criteria.error);
  const outcome = validateOutcome(input.outcome);
  if (!outcome.ok) throw new BankMatchRuleManagementError(outcome.error);
  const priority = input.priority ?? 100;
  if (!Number.isInteger(priority) || priority > 2147483647 || priority < -2147483648)
    throw new BankMatchRuleManagementError(
      "priority must be a whole number the rule list can store",
    );
  return {
    name,
    criteria: criteria.value,
    outcome: outcome.value,
    priority,
    isActive: input.isActive !== false,
  };
}

export async function createBankMatchRule(
  orgId: string,
  actorId: string,
  input: BankRuleInput,
): Promise<{ id: string }> {
  const value = normalizeInput(input);
  return db.transaction(async (tx) => {
    await lockBankMatchRuleSet(tx, orgId);
    const created = (
      await tx.execute<Record<string, unknown> & { id: string }>(
        sql`
      insert into bank_match_rules (org_id, name, criteria, outcome, priority, is_active, created_by)
      values (${orgId}, ${value.name}, ${JSON.stringify(value.criteria)}::jsonb, ${JSON.stringify(value.outcome)}::jsonb,
              ${value.priority}, ${value.isActive}, ${actorId}) returning *
    `,
        "objects",
      )
    )[0];
    if (!created) throw new Error("Bank matching rule was not created.");
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'bank_match_rules', ${created.id}, 'insert',
              ${JSON.stringify({ after: created })}::jsonb, ${actorId})
    `);
    return { id: created.id };
  });
}

export async function updateBankMatchRule(
  orgId: string,
  actorId: string,
  id: string,
  input: BankRuleInput,
): Promise<void> {
  const value = normalizeInput(input);
  await db.transaction(async (tx) => {
    await lockBankMatchRuleSet(tx, orgId);
    const before = (
      await tx.execute<Record<string, unknown>>(
        sql`select * from bank_match_rules where id=${id} and org_id=${orgId} for update`,
        "objects",
      )
    )[0];
    if (!before) throw new BankMatchRuleManagementError("record not found", 404);
    const after = (
      await tx.execute<Record<string, unknown>>(
        sql`
      update bank_match_rules set name=${value.name}, criteria=${JSON.stringify(value.criteria)}::jsonb,
             outcome=${JSON.stringify(value.outcome)}::jsonb, priority=${value.priority}, is_active=${value.isActive},
             updated_at=now(), updated_by=${actorId}
       where id=${id} and org_id=${orgId} returning *
    `,
        "objects",
      )
    )[0];
    if (!after) throw new Error("Bank matching rule update matched no row.");
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'bank_match_rules', ${id}, 'update', ${JSON.stringify({ before, after })}::jsonb, ${actorId})
    `);
  });
}

export async function deleteBankMatchRule(
  orgId: string,
  actorId: string,
  id: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockBankMatchRuleSet(tx, orgId);
    const before = (
      await tx.execute<Record<string, unknown>>(
        sql`select * from bank_match_rules where id=${id} and org_id=${orgId} for update`,
        "objects",
      )
    )[0];
    if (!before) throw new BankMatchRuleManagementError("record not found", 404);
    const removed = (
      await tx.execute<{ id: string }>(
        sql`delete from bank_match_rules where id=${id} and org_id=${orgId} returning id`,
        "objects",
      )
    )[0];
    if (!removed) throw new Error("Bank matching rule deletion matched no row.");
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'bank_match_rules', ${id}, 'delete', ${JSON.stringify({ before })}::jsonb, ${actorId})
    `);
  });
}
