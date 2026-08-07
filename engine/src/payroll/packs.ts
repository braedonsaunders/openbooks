import { sql } from "drizzle-orm";
import { db } from "../db.ts";

/**
 * Payroll country packs — the jurisdiction layer.
 *
 * A pack declares its statutory liability SLOTS: named account destinations
 * for the withholdings its engine computes, each declaring the seeded
 * components it covers. Slot values live on pay_components.liability_account_id
 * (set for every mapped component at once), so the posting path needs no
 * jurisdiction knowledge at all — it just follows the component's account.
 * Legacy orgs configured before packs existed fall back to the old
 * orgs.settings.payroll keys named here; new configuration always writes
 * the components.
 *
 * The pack's component declarations are also the SEED for those components
 * (engine/src/payroll-run.ts `seedPayrollComponents` provisions exactly this
 * set) and the source of each one's `assessedOn` class, so a jurisdiction's
 * statutory set is declared once, in one place, and nowhere else.
 *
 * The US pack declares its slots (FIT withholding, FICA, FUTA, SUTA) the
 * same way — nothing in the settings UI or the commit path is
 * Canada-specific.
 */

/**
 * What a statutory amount is computed FROM. This is the property — and the
 * ONLY property — that decides whether the amount must be recomputed when a
 * deduction changes, which is what the deduction-protection fixpoint in
 * `calculateStub` needs to know (.local/payroll-pipeline-contract.md).
 *
 * - `earnings` — assessed on gross / pensionable / insurable earnings or on
 *   hours. Protection only ever changes DEDUCTIONS, so an earnings-assessed
 *   amount is invariant across passes and is computed exactly once: WCB/WSIB,
 *   EHT, FUTA, SUTA, employer FICA, employer CPP/EI/QPIP — and also EMPLOYEE
 *   CPP, CPP2, EI and QPIP, which T4127 computes from pensionable income (PI)
 *   and insurable earnings (IE) and which no factor-F/F2/U1 deduction reduces.
 * - `taxable_income` — assessed on income AFTER pre-tax deductions, so a
 *   pre-tax protected order moves it and it must be re-derived on every pass.
 *   Income tax (CRA factors A → T) and US FIT only.
 *
 * Getting this wrong is silent money: a levy wrongly declared `earnings` goes
 * stale against the deductions actually taken, and one wrongly declared
 * `taxable_income` is recomputed and re-pushed every pass (project splits
 * included). The engine asserts the `earnings` half of the claim after the
 * loop converges rather than trusting it.
 */
export type PayrollAssessedOn = "earnings" | "taxable_income";

/**
 * One statutory component of a pack: what the engine seeds, what it pushes a
 * line under, and what that line is assessed on. `assessedOn` is required, so
 * a pack cannot add a statutory component without answering the question.
 */
export interface PayrollStatutoryComponent {
  /** pay_components.code. */
  code: string;
  /** pay_components.name. */
  name: string;
  /** pay_components.system_key — the key the engine pushes the line under. */
  systemKey: string;
  kind: "deduction" | "employer_contribution";
  /** pay_components.sequence — presentation order on the stub. */
  sequence: number;
  assessedOn: PayrollAssessedOn;
}

export interface PayrollStatutorySlot {
  key: string;
  /** The seeded components this slot's account applies to. */
  components: readonly PayrollStatutoryComponent[];
  /** Pre-pack orgs.settings.payroll key honoured as a read fallback. */
  legacySettingsKey?: string;
}

export interface PayrollCountryPack {
  country: string;
  installable: boolean;
  statutorySlots: readonly PayrollStatutorySlot[];
}

export const PAYROLL_COUNTRY_PACKS: Record<string, PayrollCountryPack> = {
  CA: {
    country: "CA",
    installable: true,
    statutorySlots: [
      {
        key: "income_tax",
        legacySettingsKey: "taxPayableAccountId",
        components: [
          // T4127 factor T: annual taxable income A is income LESS the
          // factor-F / F2 / U1 deductions, so a pre-tax protected order moves
          // it. The only Canadian line the fixpoint re-derives.
          { code: "TAX", name: "Income tax", systemKey: "income_tax", kind: "deduction", sequence: 110, assessedOn: "taxable_income" },
        ],
      },
      {
        key: "cpp",
        legacySettingsKey: "cppPayableAccountId",
        components: [
          // C and C2 are rate × (pensionable income − exemption), capped on
          // YTD contributions. No deduction enters the formula.
          { code: "CPP", name: "CPP", systemKey: "cpp", kind: "deduction", sequence: 120, assessedOn: "earnings" },
          { code: "CPP2", name: "CPP (second additional)", systemKey: "cpp2", kind: "deduction", sequence: 130, assessedOn: "earnings" },
          { code: "CPP-ER", name: "CPP (employer)", systemKey: "cpp", kind: "employer_contribution", sequence: 210, assessedOn: "earnings" },
        ],
      },
      {
        key: "ei",
        legacySettingsKey: "eiPayableAccountId",
        components: [
          // EI is rate × insurable earnings; the employer share is a multiple
          // of the employee's.
          { code: "EI", name: "EI", systemKey: "ei", kind: "deduction", sequence: 140, assessedOn: "earnings" },
          { code: "EI-ER", name: "EI (employer)", systemKey: "ei", kind: "employer_contribution", sequence: 220, assessedOn: "earnings" },
        ],
      },
      {
        key: "qpip",
        legacySettingsKey: "eiPayableAccountId",
        components: [
          { code: "QPIP", name: "QPIP", systemKey: "qpip", kind: "deduction", sequence: 150, assessedOn: "earnings" },
          { code: "QPIP-ER", name: "QPIP (employer)", systemKey: "qpip", kind: "employer_contribution", sequence: 230, assessedOn: "earnings" },
        ],
      },
      {
        key: "vacation",
        legacySettingsKey: "vacationPayableAccountId",
        components: [
          // A percentage of vacationable EARNINGS (the entitlement engine
          // emits it, phase 7), never of anything net of a deduction.
          { code: "VAC", name: "Vacation accrual", systemKey: "vacation_accrual", kind: "employer_contribution", sequence: 240, assessedOn: "earnings" },
        ],
      },
      {
        key: "wcb",
        components: [
          // Assessable earnings × the worker-comp group's rate, job-split
          // proportional to the earnings it assesses.
          { code: "WCB", name: "Workers' compensation (WCB/WSIB)", systemKey: "wcb", kind: "employer_contribution", sequence: 260, assessedOn: "earnings" },
        ],
      },
      {
        key: "eht",
        components: [
          // Ontario remuneration past the annual exemption — remuneration is
          // an earnings measure.
          { code: "EHT", name: "Employer Health Tax", systemKey: "eht", kind: "employer_contribution", sequence: 270, assessedOn: "earnings" },
        ],
      },
    ],
  },
  US: {
    country: "US",
    installable: true,
    statutorySlots: [
      {
        key: "fit",
        components: [
          // Pub 15-T works from annualized taxable wages, so a pre-tax
          // deduction (§125, 401(k)) moves it exactly as factor F moves T.
          { code: "FIT", name: "Federal income tax", systemKey: "fit", kind: "deduction", sequence: 110, assessedOn: "taxable_income" },
        ],
      },
      {
        key: "fica",
        components: [
          // Rate × FICA wages against the wage base — deductions do not enter.
          { code: "SS", name: "Social Security", systemKey: "ss", kind: "deduction", sequence: 120, assessedOn: "earnings" },
          { code: "MED", name: "Medicare", systemKey: "medicare", kind: "deduction", sequence: 130, assessedOn: "earnings" },
          { code: "MED2", name: "Additional Medicare", systemKey: "medicare_addl", kind: "deduction", sequence: 135, assessedOn: "earnings" },
          { code: "SS-ER", name: "Social Security (employer)", systemKey: "ss", kind: "employer_contribution", sequence: 210, assessedOn: "earnings" },
          { code: "MED-ER", name: "Medicare (employer)", systemKey: "medicare", kind: "employer_contribution", sequence: 220, assessedOn: "earnings" },
        ],
      },
      {
        key: "futa",
        components: [
          { code: "FUTA", name: "Federal unemployment (FUTA)", systemKey: "futa", kind: "employer_contribution", sequence: 230, assessedOn: "earnings" },
        ],
      },
      {
        key: "suta",
        components: [
          { code: "SUTA", name: "State unemployment (SUI)", systemKey: "suta", kind: "employer_contribution", sequence: 250, assessedOn: "earnings" },
        ],
      },
    ],
  },
};

/** Every statutory component a pack provisions, in slot order. */
export function packStatutoryComponents(country: string): readonly PayrollStatutoryComponent[] {
  const pack = PAYROLL_COUNTRY_PACKS[country];
  if (!pack) throw new PayrollPackError(`unknown payroll country pack ${country}`);
  return pack.statutorySlots.flatMap((slot) => slot.components);
}

/**
 * What the pack says this statutory line is assessed on — the engine's only
 * input for deciding whether a protection pass must re-derive it.
 *
 * Undeclared is a hard error, never a default: a new levy that nobody
 * classified must stop the run rather than silently pick a class and either go
 * stale or be double-pushed.
 */
export function statutoryAssessment(
  country: string,
  systemKey: string,
  kind: "deduction" | "employer_contribution",
): PayrollAssessedOn {
  const declared = packStatutoryComponents(country)
    .filter((component) => component.systemKey === systemKey && component.kind === kind);
  const assessedOn = declared[0]?.assessedOn;
  if (!assessedOn) {
    throw new PayrollPackError(
      `the ${country} payroll pack does not declare what ${systemKey}/${kind} is assessed on — `
      + "add the component to its statutory slot in engine/src/payroll/packs.ts with an "
      + "assessedOn of 'earnings' (gross/pensionable/insurable) or 'taxable_income' "
      + "(income after pre-tax deductions)",
    );
  }
  if (declared.some((component) => component.assessedOn !== assessedOn)) {
    throw new PayrollPackError(
      `the ${country} payroll pack declares conflicting assessedOn values for ${systemKey}/${kind}`,
    );
  }
  return assessedOn;
}

export interface PackSlotState {
  country: string;
  slots: { key: string; accountId: string | null }[];
}

/**
 * Installed packs with each slot's current account: the mapped components'
 * liability account when set, else the legacy settings fallback.
 */
export async function packSlotState(
  orgId: string,
  installedCountries: string[],
  legacySettings: Record<string, unknown>,
): Promise<PackSlotState[]> {
  const packs = installedCountries
    .map((country) => PAYROLL_COUNTRY_PACKS[country])
    .filter((pack): pack is PayrollCountryPack => Boolean(pack));
  if (packs.length === 0) return [];
  const components = (await db.execute(sql`
    select code, liability_account_id from pay_components
     where org_id = ${orgId} and system_key is not null
  `)) as unknown as { rows: { code: string; liability_account_id: string | null }[] };
  const byCode = new Map(components.rows.map((c) => [c.code, c.liability_account_id]));
  return packs.map((pack) => ({
    country: pack.country,
    slots: pack.statutorySlots.map((slot) => {
      const fromComponents = slot.components
        .map((component) => byCode.get(component.code))
        .find((accountId) => accountId != null);
      const legacy = slot.legacySettingsKey
        ? ((legacySettings[slot.legacySettingsKey] as string | null | undefined) ?? null)
        : null;
      return { key: slot.key, accountId: fromComponents ?? legacy };
    }),
  }));
}

export class PayrollPackError extends Error {}

/**
 * Uninstall a country pack: remove its seeded statutory components and the
 * settings marker. Guarded — refuses while anything still depends on the
 * pack, with every blocker named:
 *   - active employee payroll profiles set to the country (their next
 *     calculation would need the pack's engine and components);
 *   - pay stubs whose lines reference the pack's components (payroll
 *     records must keep their component references forever).
 * User-authored components scoped to the country are left alone — they are
 * org configuration, not the pack's.
 */
export async function uninstallPayrollPack(
  orgId: string, actorId: string, country: string,
): Promise<{ componentsRemoved: number }> {
  const pack = PAYROLL_COUNTRY_PACKS[country];
  if (!pack) throw new PayrollPackError(`unknown payroll country pack ${country}`);

  const [profiles, stubRefs] = (await Promise.all([
    db.execute(sql`
      select count(*)::int as n from employee_payroll_profiles
       where org_id = ${orgId} and country = ${country} and is_active`),
    db.execute(sql`
      select count(distinct l.stub_id)::int as n
        from pay_stub_lines l
        join pay_components c on c.id = l.component_id
       where l.org_id = ${orgId} and c.country = ${country} and c.system_key is not null`),
  ])) as unknown as { rows: { n: number }[] }[];

  const blockers: string[] = [];
  const profileCount = Number(profiles.rows[0]?.n ?? 0);
  const stubCount = Number(stubRefs.rows[0]?.n ?? 0);
  if (profileCount > 0) {
    blockers.push(`${profileCount} active employee payroll profile(s) are set to ${country} — move or deactivate them first`);
  }
  if (stubCount > 0) {
    blockers.push(`${stubCount} pay stub(s) reference this pack's statutory components — payroll records keep the pack installed`);
  }
  if (blockers.length > 0) {
    throw new PayrollPackError(`cannot uninstall the ${country} pack: ${blockers.join("; ")}`);
  }

  return await db.transaction(async (tx) => {
    // Draft (uncommitted) stubs could still reference the components between
    // the check above and this delete; the FK makes that a loud failure, not
    // a silent orphan.
    const removed = (await tx.execute(sql`
      delete from pay_components
       where org_id = ${orgId} and country = ${country} and system_key is not null
       returning id`)) as unknown as { rows: { id: string }[] };
    await tx.execute(sql`
      update orgs
         set settings = jsonb_set(
           coalesce(settings, '{}'::jsonb), '{payroll,countries}',
           coalesce((
             select jsonb_agg(value) from jsonb_array_elements_text(settings#>'{payroll,countries}')
              where value <> ${country}
           ), '[]'::jsonb))
       where id = ${orgId}`);
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'pay_components', ${orgId}, 'delete',
              ${JSON.stringify({ uninstalledPayrollPack: country })}, ${actorId})`);
    return { componentsRemoved: removed.rows.length };
  });
}

/** Write one slot's account onto every component the slot covers. */
export async function setPackSlotAccount(
  orgId: string,
  actorId: string,
  country: string,
  slotKey: string,
  accountId: string | null,
): Promise<void> {
  const pack = PAYROLL_COUNTRY_PACKS[country];
  const slot = pack?.statutorySlots.find((s) => s.key === slotKey);
  if (!slot) throw new Error(`unknown payroll pack slot ${country}/${slotKey}`);
  await db.execute(sql`
    update pay_components
       set liability_account_id = ${accountId}, updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and code = any(${`{${slot.components.map((c) => c.code).join(",")}}`}::text[])
  `);
}
