import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { requireExplicitOrgId } from "./org-selection.ts";

/**
 * Seed placeholder EFT origination settings (orgs.settings.eft) for the
 * CPA-005 payment-run export:
 *   npx tsx engine/src/provisioning/seed-eft-settings.ts <org-id>
 *
 * The target org is an explicit first argument: with no argument the script
 * used to seed whatever org happened to sort first, stamping placeholder
 * bank settings into an arbitrary tenant. It now refuses and lists the orgs.
 *
 * Every value below is a placeholder the integrator MUST replace with the
 * numbers assigned by the org's financial institution before generating a
 * real file — loadEftSettings() treats FILL-ME values as unconfigured, so
 * the run page keeps showing its configuration-needed state until then.
 * Existing settings.eft keys are preserved (jsonb merge, placeholder wins
 * only for missing keys — it never overwrites a configured value).
 */

const placeholders = {
  originatorId: "FILL-ME-10", // 10-char originator ID from the bank
  originatorShortName: "FILL-ME-SHORT", // ≤15 chars, shown on payee statements
  originatorLongName: "FILL-ME-LONG-NAME", // ≤30 chars, shown on payee statements
  dataCentre: "FILL-ME", // 5-digit destination data centre code
  originatingDataCentre: "FILL-ME", // 5-digit data centre of YOUR direct clearer (item trace number)
  institution: "FILL-ME", // payer bank: 3-digit institution number
  transit: "FILL-ME", // payer bank: 5-digit transit number
  account: "FILL-ME", // payer bank: account number (1–12 digits)
  transactionCode: "460", // CPA transaction code (460 = accounts payable)
};

export async function seedEftSettings(orgIdArg: string | undefined): Promise<{ id: string; name: string }> {
  const orgs = (await db.execute<{ id: string; name: string }>(sql`
    select id, name from orgs order by created_at
  `)).rows;
  const orgId = requireExplicitOrgId(orgIdArg, orgs, "seed-eft-settings.ts");
  const org = orgs.find((candidate) => candidate.id.toLowerCase() === orgId.toLowerCase());
  if (!org) {
    throw new Error(
      `no organization with id ${orgId} — ` +
        (orgs.length === 0
          ? "no orgs exist yet"
          : `available orgs: ${orgs.map((candidate) => `${candidate.name} (${candidate.id})`).join(", ")}`),
    );
  }

  await db.execute(sql`
    update orgs
       set settings = jsonb_set(
         settings,
         '{eft}',
         ${JSON.stringify(placeholders)}::jsonb || coalesce(settings->'eft', '{}'::jsonb)
       )
     where id = ${org.id}
  `);
  return org;
}

async function main(): Promise<void> {
  const [orgIdArg] = process.argv.slice(2);
  const org = await seedEftSettings(orgIdArg);
  console.log(
    `orgs.settings.eft placeholders set for "${org.name}" — replace every FILL-ME value with the bank-assigned EFT origination details`,
  );
}

/**
 * Run directly (`tsx seed-eft-settings.ts`) but never merely because this
 * module was bundled into another executable — see seed-user.ts.
 */
export function isSeedEftSettingsCli(entrypoint: string | undefined): boolean {
  return /(^|[/\\])seed-eft-settings\.(?:[cm]?[jt]s)$/.test(entrypoint ?? "");
}

if (isSeedEftSettingsCli(process.argv[1])) {
  void main().then(() => process.exit(0)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
