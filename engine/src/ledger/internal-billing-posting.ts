import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import {
  PostingError,
  type Doc,
  type DocLine,
  type InternalBillingAccountFacts,
  type InternalBillingPostingContext,
  type InternalBillingRuleFacts,
} from "../journal/posting-contracts.ts";

/**
 * Load the rule version an internal_billing document names, both of its
 * accounts and the providing legal entity, for the posting rule to check.
 * A first posting also re-checks the Features switches under the org row
 * lock, so a posting cannot land after Internal billing (or Projects, for
 * lines that reference a project) was turned off. Regeneration of an
 * existing journal keeps the original treatment and skips that check.
 */
export async function resolveInternalBillingPostingContext(
  runner: SqlExecutor,
  doc: Doc,
  lines: readonly Pick<DocLine, "projectId">[],
  options: { enforceFeatures: boolean },
): Promise<InternalBillingPostingContext> {
  if (options.enforceFeatures) {
    if (!(await lockAndCheckOrgFeature(runner, doc.orgId, "internalBilling"))) {
      throw new PostingError("Internal billing is turned off; turn it on in Company Settings → Features before posting");
    }
    const referencesProject = doc.projectId != null || lines.some((line) => line.projectId != null);
    if (referencesProject && !(await lockAndCheckOrgFeature(runner, doc.orgId, "projects"))) {
      throw new PostingError("this internal billing references a project and Projects is turned off; turn it on in Company Settings → Features");
    }
  }
  if (!doc.internalBillingRuleId) {
    throw new PostingError(`internal billing ${doc.documentNumber} names no rule; open it in Internal billing and choose a rule`);
  }
  const rule = (await runner.execute<{
    id: string; code: string; name: string; method: InternalBillingRuleFacts["method"];
    debit_account_id: string; credit_account_id: string;
    effective_from: string; effective_to: string | null; is_active: boolean;
  }>(sql`
    select id, code, name, method, debit_account_id, credit_account_id,
           effective_from::text as effective_from, effective_to::text as effective_to, is_active
      from internal_billing_rules
     where org_id = ${doc.orgId} and id = ${doc.internalBillingRuleId}`)).rows[0];
  if (!rule) throw new PostingError(`internal billing rule for ${doc.documentNumber} was not found`);
  const accounts = (await runner.execute<{
    id: string; number: string | null; name: string; type: string; eliminate: boolean; is_active: boolean; is_summary: boolean;
  }>(sql`
    select id, number, name, type, eliminate, is_active, is_summary
      from accounts
     where org_id = ${doc.orgId} and id in (${rule.debit_account_id}, ${rule.credit_account_id})`)).rows;
  const facts = (id: string): InternalBillingAccountFacts => {
    const row = accounts.find((account) => account.id === id);
    if (!row) throw new PostingError(`internal billing rule ${rule.code} names an account that does not exist`);
    return {
      id: row.id,
      label: [row.number, row.name].filter(Boolean).join(" "),
      type: row.type,
      eliminate: row.eliminate,
      isActive: row.is_active,
      isSummary: row.is_summary,
    };
  };
  let providerSubsidiaryId = doc.subsidiaryId;
  if (!providerSubsidiaryId) {
    providerSubsidiaryId = (await runner.execute<{ id: string }>(sql`
      select id from subsidiaries where org_id = ${doc.orgId} and parent_id is null order by created_at limit 1`)).rows[0]?.id ?? null;
  }
  if (!providerSubsidiaryId) throw new PostingError("the organization has no root subsidiary");
  return {
    rule: {
      id: rule.id,
      code: rule.code,
      name: rule.name,
      method: rule.method,
      debitAccountId: rule.debit_account_id,
      creditAccountId: rule.credit_account_id,
      effectiveFrom: rule.effective_from,
      effectiveTo: rule.effective_to,
      isActive: rule.is_active,
    },
    debitAccount: facts(rule.debit_account_id),
    creditAccount: facts(rule.credit_account_id),
    providerSubsidiaryId,
    multiSubsidiary: await lockAndCheckOrgFeature(runner, doc.orgId, "multiSubsidiary"),
  };
}
