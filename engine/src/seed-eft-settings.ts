import { sql } from "drizzle-orm";
import { db } from "./db.ts";

/**
 * Seed placeholder EFT origination settings (orgs.settings.eft) for the
 * CPA-005 payment-run export:
 *   npx tsx engine/src/seed-eft-settings.ts [orgId]
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

const [orgIdArg] = process.argv.slice(2);
const org = (await db.execute(
  orgIdArg
    ? sql`select id, name from orgs where id = ${orgIdArg}`
    : sql`select id, name from orgs limit 1`,
)) as unknown as { rows: { id: string; name: string }[] };
if (!org.rows[0]) {
  console.error(orgIdArg ? `org ${orgIdArg} not found` : "no orgs exist yet");
  process.exit(1);
}

await db.execute(sql`
  update orgs
     set settings = jsonb_set(
       settings,
       '{eft}',
       ${JSON.stringify(placeholders)}::jsonb || coalesce(settings->'eft', '{}'::jsonb)
     )
   where id = ${org.rows[0].id}
`);
console.log(
  `orgs.settings.eft placeholders set for "${org.rows[0].name}" — replace every FILL-ME value with the bank-assigned EFT origination details`,
);
process.exit(0);
