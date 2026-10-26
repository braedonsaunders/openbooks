import { registerAssetsPostingContributors } from "../assets/posting-contributors.ts";
import { registerCompliancePostingContributors } from "../compliance/posting-contributors.ts";
import { registerCrmPostingContributors } from "../crm/posting-contributors.ts";
import { registerScriptingPostingContributors } from "../scripting/posting-contributors.ts";

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
  registerAssetsPostingContributors();
  registerCompliancePostingContributors();
  registerCrmPostingContributors();
  registerScriptingPostingContributors();
}
