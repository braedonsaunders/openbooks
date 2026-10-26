import { sql, getTableColumns, type Table } from "drizzle-orm";
import { getTableName } from "drizzle-orm";
import {
  employeePayrollProfiles,
  paySchedules,
  payComponents,
  payComponentStatutoryTreatments,
  payStubs,
  payStubLines,
} from "@openbooks/schema/src/payroll.ts";
import { documents } from "@openbooks/schema/src/documents.ts";
import { parties, employeeRoles, vendorRoles } from "@openbooks/schema/src/parties.ts";
import { timeEntries } from "@openbooks/schema/src/time.ts";
import { laborCostRates } from "@openbooks/schema/src/labor-costing.ts";
import { payrollVacationTerms } from "@openbooks/schema/src/payroll-service-credit.ts";
import { db } from "../platform/db.ts";
import { assertFixtureDatabase } from "./fixture-database.ts";

/** Fixture writes require a verified disposable database and explicit scenario inputs. */

/** Native fixture rows preserve explicit inputs and let database defaults apply only to omitted fields. */
async function insertDeclaredFixture(table: Table, row: Record<string, unknown>): Promise<void> {
  await assertFixtureDatabase();
  const columns = getTableColumns(table);
  const entries = Object.entries(row).filter(([, value]) => value !== undefined);
  for (const [key] of entries)
    if (!columns[key]) throw new Error(`Unknown fixture field ${getTableName(table)}.${key}`);
  const written = await db.execute(
    sql`insert into ${sql.identifier(getTableName(table))}
    (${sql.join(
      entries.map(([key]) => sql.identifier(columns[key]!.name)),
      sql`, `,
    )})
    values (${sql.join(
      entries.map(([key, value]) => sql.param(value, columns[key]!)),
      sql`, `,
    )}) returning 1 as written`,
    "objects",
  );
  if (written.length !== 1)
    throw new Error(`Native fixture ${getTableName(table)} did not record its declared row`);
}

/** Component flags and accounting destinations remain explicit in each native scenario. */
export async function seedPayrollComponent(
  orgId: string,
  id: string,
  fields: Omit<typeof payComponents.$inferInsert, "orgId" | "id">,
): Promise<void> {
  await insertDeclaredFixture(payComponents, { orgId, id, ...fields });
}

/** Dated statutory policy is an explicit fixture fact, independent of component defaults. */
export async function seedPayrollStatutoryTreatment(
  orgId: string,
  payComponentId: string,
  fields: Omit<typeof payComponentStatutoryTreatments.$inferInsert, "orgId" | "payComponentId">,
): Promise<void> {
  await insertDeclaredFixture(payComponentStatutoryTreatments, {
    orgId,
    payComponentId,
    ...fields,
  });
}

/** Native document ownership, dates, currency and lifecycle are supplied by the scenario. */
export async function seedPayrollDocument(
  orgId: string,
  id: string,
  fields: Omit<typeof documents.$inferInsert, "orgId" | "id">,
): Promise<void> {
  await insertDeclaredFixture(documents, { orgId, id, ...fields });
}

/** Stub evidence is tied to the declared native employment, with no live-policy inference. */
export async function seedPayrollStub(
  orgId: string,
  payRunDocumentId: string,
  employeePartyId: string,
  employmentId: string,
  fields: Omit<
    typeof payStubs.$inferInsert,
    "orgId" | "payRunDocumentId" | "employeePartyId" | "employmentId"
  > & {
    country: string;
    countrySource: "calculation";
  },
): Promise<void> {
  await insertDeclaredFixture(payStubs, {
    orgId,
    payRunDocumentId,
    employeePartyId,
    employmentId,
    ...fields,
  });
}

/** Native line amounts and statutory/accounting flags are declared by the scenario. */
export async function seedPayrollLine(
  orgId: string,
  stubId: string,
  componentId: string | null,
  fields: Omit<typeof payStubLines.$inferInsert, "orgId" | "stubId" | "componentId">,
): Promise<void> {
  await insertDeclaredFixture(payStubLines, { orgId, stubId, componentId, ...fields });
}

/** Payroll counterparties use native party records with their declared kind and ownership. */
export async function seedPayrollParty(
  orgId: string,
  id: string,
  fields: Omit<typeof parties.$inferInsert, "orgId" | "id">,
): Promise<void> {
  await insertDeclaredFixture(parties, { orgId, id, ...fields });
}

/** A payee role is created independently of party ownership and payment destinations. */
export async function seedPayrollVendorRole(
  orgId: string,
  partyId: string,
  actorId: string,
): Promise<void> {
  await insertDeclaredFixture(vendorRoles, {
    orgId,
    partyId,
    isActive: true,
    createdBy: actorId,
    updatedBy: actorId,
  });
}

/** Declared payroll settings are merged natively without changing unrelated tenant configuration. */
export async function seedPayrollSettings(
  orgId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await assertFixtureDatabase();
  const written = await db.execute(
    sql`update orgs set settings = settings || ${JSON.stringify(settings)}::jsonb
    where id = ${orgId} returning id`,
    "objects",
  );
  if (written.length !== 1)
    throw new Error("Payroll fixture configuration did not match its scratch organization");
}

/** Enable payroll for a posting scenario with only its explicitly supplied accounting configuration. */
export async function seedEnabledPayrollConfiguration(
  orgId: string,
  payroll: Record<string, unknown>,
): Promise<void> {
  await seedPayrollSettings(orgId, { features: { payroll: true } });
  await seedPayrollAccountingConfiguration(orgId, payroll);
}

/** Declare policy and native component accounts; slot declarations install exactly their named packs. */
export async function seedPayrollAccountingConfiguration(
  orgId: string,
  payroll: Record<string, unknown>,
): Promise<void> {
  const { slotAccounts, ...policy } = payroll;
  await seedPayrollSettings(orgId, { payroll: policy });
  if (slotAccounts === undefined) return;
  if (!slotAccounts || typeof slotAccounts !== "object" || Array.isArray(slotAccounts)) {
    throw new Error("Payroll fixtures must declare country-pack slot accounts as an object");
  }
  const { ensureComponents, payRunComponentDeclarations, seedPayrollComponents } =
    await import("../payroll/run-setup.ts");
  const { payrollPack } = await import("../payroll/packs.ts");
  for (const [country, mappings] of Object.entries(slotAccounts)) {
    if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) {
      throw new Error("Each payroll fixture country must declare its native slot accounts");
    }
    const pack = payrollPack(country);
    await ensureComponents(db, orgId, null, payRunComponentDeclarations(country));
    for (const [key, accountId] of Object.entries(mappings)) {
      const slot = pack.statutorySlots.find((candidate) => candidate.key === key);
      if (!slot || slot.components.length === 0)
        throw new Error(`Payroll fixture slot ${country}/${key} is not declared`);
      const changed = await db.execute(
        sql`update pay_components set liability_account_id=${accountId}
        where org_id=${orgId} and country=${country}
          and code in (${sql.join(
            slot.components.map((component) => sql`${component.code}`),
            sql`, `,
          )}) returning id`,
        "objects",
      );
      if (changed.length !== slot.components.length)
        throw new Error(`Payroll fixture slot ${country}/${key} was not fully configured`);
    }
    await seedPayrollComponents(orgId, null, country);
  }
}

type ProfileFixture = Omit<
  Partial<typeof employeePayrollProfiles.$inferInsert>,
  | "orgId"
  | "employeePartyId"
  | "employmentId"
  | "payScheduleId"
  | "createdBy"
  | "updatedBy"
  | "vacationPercent"
  | "vacationMethod"
  | "payBasis"
> & { country: string; province: string; payBasis: string };

type VacationFixture = {
  percentFloor: string | null;
  method: typeof payrollVacationTerms.$inferInsert.method;
};

/** Tax profiles and vacation elections are separate native records, including in test fixtures. */
export async function seedPayrollProfile(
  orgId: string,
  employeePartyId: string,
  employmentId: string,
  payScheduleId: string,
  actorId: string | null,
  profile: ProfileFixture,
  vacation?: VacationFixture,
): Promise<void> {
  await insertDeclaredFixture(employeePayrollProfiles, {
    orgId,
    employeePartyId,
    employmentId,
    payScheduleId,
    isActive: true,
    createdBy: actorId,
    updatedBy: actorId,
    ...profile,
  });
  if (vacation)
    await seedVacationTerms(orgId, employmentId, actorId, vacation.percentFloor, vacation.method);
}

/** Payroll cadence and dates are supplied by each scenario, never inferred from a country. */
export async function seedPayrollSchedule(
  orgId: string,
  id: string,
  actorId: string | null,
  schedule: Omit<
    Partial<typeof paySchedules.$inferInsert>,
    "orgId" | "id" | "createdBy" | "updatedBy" | "frequency"
  > & {
    name: string;
    frequency: string;
    periodsPerYear: number;
    anchorPeriodEnd: string;
    payDateOffsetDays: number;
  },
): Promise<void> {
  await insertDeclaredFixture(paySchedules, {
    orgId,
    id,
    isActive: true,
    createdBy: actorId,
    updatedBy: actorId,
    ...schedule,
  });
}

/** Exact declared wage, with no inferred rate, currency, annual-hours divisor or validity date. */
export async function seedPayrollWage(
  orgId: string,
  employeePartyId: string,
  actorId: string | null,
  wage: Omit<
    Partial<typeof laborCostRates.$inferInsert>,
    "orgId" | "employeePartyId" | "createdBy" | "updatedBy" | "basis" | "annualHours"
  > & {
    currency: string;
    rate: string;
    basis: string;
    effectiveFrom: string;
    annualHours?: string | number;
  },
): Promise<void> {
  await insertDeclaredFixture(laborCostRates, {
    orgId,
    employeePartyId,
    isActive: true,
    createdBy: actorId,
    updatedBy: actorId,
    ...wage,
  });
}

/** Explicit vacation elections for native payroll fixtures; tax profiles carry no policy. */
export async function seedVacationTerms(
  orgId: string,
  employmentId: string,
  actorId: string | null,
  percentFloor: string | null = "4",
  method: VacationFixture["method"] = "accrue",
  executor: Pick<typeof db, "execute"> = db,
): Promise<void> {
  await assertFixtureDatabase();
  const plan = (
    await executor.execute<{ id: string }>(
      sql`select id from entitlement_plans where org_id=${orgId} and system_key='vacation'`,
      "objects",
    )
  )[0];
  if (!plan)
    throw new Error(
      "Vacation-term fixtures require an explicitly configured native vacation program.",
    );
  await executor.execute(sql`
    insert into payroll_vacation_terms (org_id, employment_id, plan_id, method, percent_floor, effective_from, reason, source_snapshot, created_by, updated_by)
    values (${orgId}, ${employmentId}, ${plan.id}, ${method}, ${percentFloor}, '0001-01-01', 'Declared employee vacation terms', '{"source":"fixture"}'::jsonb, ${actorId}, ${actorId})
  `);
}

/** A person party retains its declared ownership and contact fields; employment is seeded separately. */
export async function seedPayrollPerson(
  orgId: string,
  id: string,
  displayName: string,
  fields: Omit<Partial<typeof parties.$inferInsert>, "orgId" | "id" | "displayName" | "kind"> = {},
): Promise<void> {
  await insertDeclaredFixture(parties, {
    orgId,
    id,
    displayName,
    kind: "person",
    isActive: true,
    custom: {},
    ...fields,
  });
}

/** Employee role evidence is declared independently of the native employment and tax profile. */
export async function seedPayrollEmployeeRole(
  orgId: string,
  partyId: string,
  fields: Omit<Partial<typeof employeeRoles.$inferInsert>, "orgId" | "partyId">,
): Promise<void> {
  await insertDeclaredFixture(employeeRoles, { orgId, partyId, ...fields });
}

/** Time-entry inputs are explicit, including approval, costing and billing state. */
export async function seedPayrollTime(
  orgId: string,
  employeePartyId: string,
  actorId: string | null,
  entry: Omit<
    Partial<typeof timeEntries.$inferInsert>,
    | "orgId"
    | "employeePartyId"
    | "createdBy"
    | "updatedBy"
    | "hours"
    | "status"
    | "costingBasis"
    | "billingStatus"
  > & {
    workedOn: string;
    hours: string | number;
    status: string;
    costingBasis: string;
    billingStatus: string;
  },
): Promise<void> {
  await insertDeclaredFixture(timeEntries, {
    orgId,
    employeePartyId,
    createdBy: actorId,
    updatedBy: actorId,
    ...entry,
  });
}
