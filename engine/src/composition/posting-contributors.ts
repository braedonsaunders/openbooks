import { registerAllocationsPostingContributors } from "../allocations/posting-contributors.ts";
import { registerAssetsPostingContributors } from "../assets/posting-contributors.ts";
import { registerCompliancePostingContributors } from "../compliance/posting-contributors.ts";
import { registerCrmPostingContributors } from "../crm/posting-contributors.ts";
import { registerInventoryPostingContributors } from "../inventory/posting-contributors.ts";
import { registerPaymentsCorePostingContributors } from "../payments-core/posting-contributors.ts";
import { registerPayrollPostingContributors } from "../payroll/posting-contributors.ts";
import { registerScriptingPostingContributors } from "../scripting/posting-contributors.ts";
import { registerStoredValuePostingContributors } from "../stored-value/posting-contributors.ts";
import { registerWebhooksPostingContributors } from "../webhooks/posting-contributors.ts";

/**
 * Install every domain's posting, editing and voiding hooks. The ledger
 * resolves each hook at the statement that needs it, so this order only fixes
 * which registration a process performs first; it never reorders hooks.
 *
 * Idempotent: registration is keyed by domain, so a second install replaces
 * each domain's hooks with the same functions. installEngineSeams() calls it
 * at every process start; the scratch-organization fixture calls it for tests.
 */
export function installPostingContributors(): void {
  registerAllocationsPostingContributors();
  registerAssetsPostingContributors();
  registerCompliancePostingContributors();
  registerCrmPostingContributors();
  registerInventoryPostingContributors();
  registerPaymentsCorePostingContributors();
  registerPayrollPostingContributors();
  registerScriptingPostingContributors();
  registerStoredValuePostingContributors();
  registerWebhooksPostingContributors();
}
