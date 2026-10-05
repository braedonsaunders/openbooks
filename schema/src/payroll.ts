import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { accounts } from "./coa";
import { departments } from "./core";
import { parties } from "./parties";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

/**
 * Payroll module (feature `payroll`, off by default).
 *
 * Design doctrine:
 * - Wages have ONE home: labor_cost_rates (employee scope) — payroll resolves
 *   the same effective-dated wage the costing engine snapshots into time
 *   entries. No second wage table, ever (see the reverted 9ff64c18 prior art).
 * - Statutory amounts (CPP/CPP2/EI/QPIP/income tax) are computed by the
 *   versioned T4127 engine in engine/src/payroll/canada — they are never
 *   user-authored component formulas. User components cover everything else.
 * - A pay run is a posting `documents` kind ('pay_run') with this 1:1
 *   extension, so numbering, approval, posting, voiding, and period control
 *   ride the standard document machinery.
 * - YTD state = payroll_opening_balances + payroll_opening_balance_components
 *   (mid-year adoption, statutory and per-component) + posted stubs. Nothing
 *   else accumulates, so recalculating a stub is always safe.
 */

/** Pay frequency calendar: drives P (periods per year) and period boundaries. */
export const paySchedules = pgTable(
  "pay_schedules",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    frequency: text("frequency", {
      enum: ["weekly", "biweekly", "semi_monthly", "monthly"],
    }).notNull(),
    /** T4127 factor P: 52/53, 26/27, 24, 12. Explicit to support 53/27 years. */
    periodsPerYear: integer("periods_per_year").notNull(),
    /** End date of any one period; other periods derive from it. */
    anchorPeriodEnd: date("anchor_period_end").notNull(),
    /** Days from period end to the cheque/deposit date. */
    payDateOffsetDays: integer("pay_date_offset_days").notNull().default(0),
    /** Legal entity this calendar pays. Null = org-wide (root subsidiary).
     * Scoped schedules pin their runs' entity + currency and only include
     * employees belonging to that subsidiary — one org can run a Canadian
     * CAD schedule beside a US USD schedule this way. */
    subsidiaryId: uuid("subsidiary_id"),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("pay_schedules_org_name").on(t.orgId, t.name),
    index("pay_schedules_subsidiary").on(t.orgId, t.subsidiaryId),
    check("pay_schedules_periods", sql`${t.periodsPerYear} in (12, 24, 26, 27, 52, 53)`),
    check("pay_schedules_offset", sql`${t.payDateOffsetDays} >= 0 and ${t.payDateOffsetDays} <= 31`),
  ],
);

/**
 * Pay components — the earnings/deductions/employer-contribution atoms.
 * Statutory components carry a systemKey and are engine-computed; their rows
 * exist so tenants can map GL accounts and remittance vendors per component.
 */
export const payComponents = pgTable(
  "pay_components",
  {
    id: id(),
    orgId: orgRef(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: text("kind", {
      enum: ["earning", "deduction", "employer_contribution"],
    }).notNull(),
    /** Country pack the component belongs to; null = shared across packs.
     * Statutory rows get it from their seeder; user components may scope
     * themselves so they only apply to that country's employees.
     * Deliberately NOT an enum (0189): 0175 widened the storage CHECK to any
     * two-letter code, and fourteen packs are installable — a closed
     * two-country type rejects at compile time what the database accepts. */
    country: text("country"),
    /**
     * Engine-computed statutory components; null for user components.
     * The country pack declares which keys exist (cpp/cpp2/ei/qpip for CA,
     * ss/medicare for US, and whatever levy the next pack brings) — this
     * column deliberately carries no enum, so a pack never needs a schema
     * change to declare a key. Membership is the pack registry's answer;
     * the database enforces SHAPE only (pay_components_system_key).
     *
     * A state's or province's own income tax, and the taxing unit below it
     * (New York City, Philadelphia, an Ohio municipality), share ONE key
     * each (state_income_tax / local_income_tax), with the jurisdiction on
     * the LINE rather than in the key: fifty state keys would be fifty rows
     * in a table an operator reads, and it still would not answer the
     * remittance question, which is per registration.
     */
    systemKey: text("system_key"),
    /** How a user component's amount is produced (statutory rows ignore this). */
    basis: text("basis", {
      enum: ["fixed_amount", "per_hour", "percent_of_gross"],
    }).notNull().default("fixed_amount"),
    /** Default amount / hourly rate / percent, overridable per employee. */
    value: money("value"),
    /** Non-cash earnings retain their statutory bases but create no cash entitlement. */
    paymentKind: text("payment_kind", { enum: ["cash", "non_cash"] }).notNull().default("cash"),
    /** Explicit prepaid asset or provider liability credited for non-cash value. */
    nonCashAccountId: uuid("non_cash_account_id"),
    /** Earnings: statutory treatment of the amount. */
    taxable: boolean("taxable").notNull().default(true),
    pensionable: boolean("pensionable").notNull().default(true),
    insurable: boolean("insurable").notNull().default(true),
    /**
     * Contribution program keys this component's earnings do NOT feed
     * (0342, C-13). Empty contributes to every declared program, matching
     * the sibling flags' default-true; a key no pack declares is inert on
     * runs, like an undeclared tax treatment.
     */
    programExclusions: text("program_exclusions").array().notNull().default([]),
    /** Earnings: counts toward vacationable earnings. */
    vacationable: boolean("vacationable").notNull().default(true),
    /** Earnings: taxed with the T4127 bonus (non-periodic) method. */
    nonPeriodic: boolean("non_periodic").notNull().default(false),
    /**
     * Deductions: pre-tax treatment from the employee pack's declared
     * vocabulary (`PayrollCountryPack.deductionTreatments`) — 'pension_f',
     * 'union_dues' and 'alimony' are the T4127 factors F, U1 and F2,
     * 'none' = after-tax. The compute layer keys off the pack's
     * declaration, so a key the pack does not declare is inert on its runs.
     * Values are closed by a CHECK constraint: a new treatment (e.g. AU
     * 'salary_sacrifice') ships with a forward migration.
     */
    taxTreatment: text("tax_treatment", {
      enum: ["none", "pension_f", "union_dues", "alimony"],
    }).notNull().default("none"),
    /**
     * Deduction protection ("protected earnings"): a deduction may not take
     * more than a share of what the employee actually earns. Ontario's Wages
     * Act caps ordinary garnishments at 20% of net wages and family support at
     * 50%; the US CCPA caps at 25% of disposable earnings (50/55/60% for
     * support). The BASE is a setting because real orders measure against
     * different pools — a creditor agreement that says "50% of net, but the
     * coverall allowance and the benefit deduction sit outside the 50%" is
     * configuration here, never a code branch.
     */
    protectionBase: text("protection_base", {
      enum: ["none", "net_pay", "disposable_earnings", "gross"],
    }).notNull().default("none"),
    protectionMaxPercent: numeric("protection_max_percent", { precision: 7, scale: 4 }),
    /** Which order wins when several protected deductions compete for one
     * pool: lowest first (support outranks an ordinary creditor), and whatever
     * does not fit is reported as a shortfall, never silently dropped. */
    protectionPriority: integer("protection_priority").notNull().default(100),
    /**
     * The pack-declared class of protected order (0542): an ordinary
     * creditor garnishment carries an exempt floor the order may not reach,
     * a support order its percentage alone. Null applies the percentage
     * alone; the run refuses a class the employee's pack does not declare.
     */
    protectionClass: text("protection_class"),
    /** Membership of the protected pool: earnings add to it, deductions
     * subtract from it. This flag — not a hardcode — is what excludes an
     * allowance or a benefit from the base a garnishment is measured against. */
    includeInDisposableEarnings: boolean("include_in_disposable_earnings").notNull().default(true),
    /**
     * Basis caps — the basis a percent-of-X / per-hour component computes on
     * is limited BEFORE the amount is produced, so nobody hand-computes it.
     * Hours: "RRSP on at most 40 hours a week"; job-charged overtime is exempt,
     * which is a property of the hour (the time type), not of the component.
     * Amounts: the CRA money-purchase limit and the US 402(g) elective-deferral
     * limit, per period and per tax year.
     */
    basisCapHoursPerPeriod: numeric("basis_cap_hours_per_period", { precision: 12, scale: 2 }),
    basisCapAmountPerPeriod: money("basis_cap_amount_per_period"),
    basisCapAmountPerYear: money("basis_cap_amount_per_year"),
    /** DR for earnings/employer contributions (default wage expense if null). */
    expenseAccountId: uuid("expense_account_id"),
    /** CR for deductions/employer contributions/accruals. */
    liabilityAccountId: uuid("liability_account_id"),
    /** Vendor the withheld/accrued amount is remitted to (CRA, union, fund). */
    remittancePartyId: uuid("remittance_party_id"),
    sequence: integer("sequence").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    // Tenant pair required by composite child FKs (0218). id is the PK, so
    // 0044 never installed this key as a tenant-coherent parent.
    uniqueIndex("pay_components_org_id_id_unique").on(t.orgId, t.id),
    // Code identity is (org, country, code) — two packs may each declare WCB
    // (0248). The live DDL is a unique index with NULLS NOT DISTINCT, which
    // uniqueIndex() cannot express, so the declaration names the columns while
    // 0248 owns the full definition — do not regenerate it from this alone.
    uniqueIndex("pay_components_org_country_code").on(t.orgId, t.country, t.code),
    // Component identity is (org, country, system_key, kind) — two packs may
    // each own e.g. income_tax (0189). The live DDL is a PARTIAL unique index
    // with NULLS NOT DISTINCT (WHERE system_key IS NOT NULL): the NULLS NOT
    // DISTINCT keeps the org-level (NULL country) guarantee, and the
    // predicate keeps NULL-key user rows unconstrained, as before.
    // uniqueIndex() cannot express either clause, so the declaration below
    // names the columns while 0189 owns the full definition — do not
    // regenerate this index from the declaration alone.
    uniqueIndex("pay_components_org_system").on(t.orgId, t.country, t.systemKey, t.kind),
    index("pay_components_org_kind").on(t.orgId, t.kind),
    check("pay_components_payment_kind", sql`${t.paymentKind} in ('cash', 'non_cash')`),
    check("pay_components_non_cash_shape", sql`
      (${t.paymentKind} = 'cash' and ${t.nonCashAccountId} is null) or
      (${t.paymentKind} = 'non_cash' and ${t.kind} = 'earning' and ${t.systemKey} is null and ${t.nonCashAccountId} is not null)
    `),
    foreignKey({ name: "pay_components_non_cash_account_tenant_fkey",
      columns: [t.orgId, t.nonCashAccountId], foreignColumns: [accounts.orgId, accounts.id],
    }),
    // Statutory keys are pack-declared (0176): the database enforces that a
    // system key LOOKS like a stable machine identifier — lowercase
    // snake_case — never which identifiers may exist. A typo ('CPP',
    // 'income tax') still fails here at seed time; a legitimate new levy
    // ('hsf') passes without a schema change. The name is intentionally the
    // same as the pre-0176 enumeration CHECK it replaces.
    check("pay_components_system_key",
      sql`${t.systemKey} is null or ${t.systemKey} ~ '^[a-z][a-z0-9_]{0,63}$'`),
    // Protection is a property of money leaving the employee: an earning or an
    // employer contribution has nothing to protect, and a protected component
    // without a percentage would silently take everything.
    check("pay_components_protection_deduction_only",
      sql`${t.protectionBase} = 'none' or ${t.kind} = 'deduction'`),
    check("pay_components_protection_percent",
      sql`${t.protectionMaxPercent} is null
          or (${t.protectionMaxPercent} >= 0 and ${t.protectionMaxPercent} <= 100)`),
    check("pay_components_protection_shape",
      sql`${t.protectionBase} = 'none' or ${t.protectionMaxPercent} is not null`),
    check("pay_components_protection_priority", sql`${t.protectionPriority} >= 0`),
    check("pay_components_protection_class",
      sql`${t.protectionClass} is null
          or (${t.protectionBase} <> 'none' and ${t.protectionClass} ~ '^[a-z][a-z0-9_]{0,63}$')`),
    check("pay_components_basis_caps_nonnegative",
      sql`(${t.basisCapHoursPerPeriod} is null or ${t.basisCapHoursPerPeriod} >= 0)
          and (${t.basisCapAmountPerPeriod} is null or ${t.basisCapAmountPerPeriod} >= 0)
          and (${t.basisCapAmountPerYear} is null or ${t.basisCapAmountPerYear} >= 0)`),
    // A per-period cap above the annual one can never bind — that is a typo,
    // not a policy.
    check("pay_components_basis_cap_order",
      sql`${t.basisCapAmountPerPeriod} is null or ${t.basisCapAmountPerYear} is null
          or ${t.basisCapAmountPerPeriod} <= ${t.basisCapAmountPerYear}`),
  ],
);

/** Per-employee payroll facts: TD1/W-4 claims, jurisdiction, schedule, exemptions. */
export const employeePayrollProfiles = pgTable(
  "employee_payroll_profiles",
  {
    id: id(),
    orgId: orgRef(),
    employeePartyId: uuid("employee_party_id").notNull(),
    /**
     * HRM employment link (0186): null = not yet stamped by
     * `stampEmploymentContext`, never "no employment". Composite tenant FK
     * to worker_employments below; cross-person writes are refused by the
     * payroll_employment_coherence_guard trigger in the migration.
     */
    employmentId: uuid("employment_id"),
    payScheduleId: uuid("pay_schedule_id").notNull(),
    /** Statutory country pack this employee runs under.
     * Deliberately NOT an enum (0189): 0175 widened the storage CHECK to any
     * two-letter code — a closed two-country type rejects at compile time
     * what the database accepts. The database-side 'CA' default is gone
     * (0190) while NOT NULL stays: an unset country is refused, never
     * silently Canadian. The `.default("CA")` below is type-level only —
     * no Drizzle-query-builder insert on this table exists for it to
     * reach — and historical rows carrying 'CA' are left untouched by
     * design (a defaulted row is indistinguishable from a chosen one). */
    country: text("country").notNull().default("CA"),
    /** Jurisdiction of employment within the country: T4127 province ('ON',
     * 'QC', 'ZZ') for Canada, state postal code ('TX', 'WA', …) for the US. */
    province: text("province").notNull(),
    /**
     * Region the employee RESIDES in, when it differs from the region of
     * EMPLOYMENT (`province`, which is the work region despite its name).
     *
     * Nullable, and null means "not recorded" — resolved to the work region by
     * `resolveWithholding` and REPORTED as an assumption, which is the only
     * choice that lets every row written before this column existed keep
     * calculating identically.
     *
     * Generic, not a US column: a Québec resident working in Ontario is the
     * same problem, and the CA pack needs this attribute unchanged. Codes are
     * the pack's own region vocabulary; validated at the API boundary against
     * the country pack, exactly as `province` and `labour_jurisdiction` are,
     * never by a CHECK naming one country's codes.
     */
    residenceRegion: text("residence_region"),
    /**
     * The labour jurisdiction whose EMPLOYMENT STANDARDS govern this
     * employment, when it is not the default derived from the work region.
     *
     * Nullable, and null means "derive it from the region" — which is the right
     * answer for almost every employment and the only answer rows written
     * before this column existed can give. It is set when the employer of
     * record is regulated by a different labour jurisdiction than the one the
     * employee works in: that jurisdiction has its own statutory holiday
     * calendar AND its own holiday-pay formula, and without an attribute for it
     * the employment silently inherits the work region's.
     *
     * It carries a pack-declared jurisdiction KEY (`payrollJurisdiction`), not
     * a region code, and it moves the employment-standards answers only —
     * withholding still follows `province`, because a person working in a
     * province pays that province's tax whoever regulates their employer. The
     * column names no country; which keys are legal is the pack's declaration,
     * validated at the API boundary (`labourJurisdictionProblem`).
     */
    labourJurisdiction: text("labour_jurisdiction"),
    /**
     * Statutory occupation class (0409), for rules that price by occupation
     * rather than by hours or earnings — New Brunswick's route-salesperson
     * weekly cap (ESA s. 21(2)) is the first reader.
     *
     * Nullable, and null means "unrecorded" — the demanding rule refuses by
     * name rather than guess the class. Generic, not a New Brunswick column:
     * values are the pack's own closed vocabulary (validated at the profile
     * API boundary against the country pack's employee-fact declaration,
     * exactly as `province` and `labour_jurisdiction` are), never by a CHECK
     * naming one country's occupations.
     */
    statutoryOccupationClass: text("statutory_occupation_class"),
    payBasis: text("pay_basis", { enum: ["hourly", "salary"] }).notNull().default("hourly"),
    /** TD1 federal claim: code 0–10, or an exact amount which wins over code. */
    federalClaimCode: integer("federal_claim_code"),
    federalClaimAmount: money("federal_claim_amount"),
    provincialClaimCode: integer("provincial_claim_code"),
    provincialClaimAmount: money("provincial_claim_amount"),
    /** TD1 extras (annual unless noted). */
    additionalTaxPerPeriod: money("additional_tax_per_period"),
    prescribedZoneDeduction: money("prescribed_zone_deduction"),
    authorizedAnnualDeductions: money("authorized_annual_deductions"),
    authorizedFederalCredits: money("authorized_federal_credits"),
    authorizedProvincialCredits: money("authorized_provincial_credits"),
    cppExempt: boolean("cpp_exempt").notNull().default(false),
    eiExempt: boolean("ei_exempt").notNull().default(false),
    /** Sealed SIN/SSN (envelope encryption, like vendor TINs) for T4/W-2
     * filing; last 3 digits shown for identify-without-reveal. The workbench
     * view excludes the ciphertext. */
    sinEncrypted: text("sin_encrypted"),
    sinLast3: text("sin_last3"),
    /** Claim code E / CRA letter / W-4 "Exempt": no income tax withholding
     * (statutory contributions still deducted). */
    taxExempt: boolean("tax_exempt").notNull().default(false),
    /** US W-4 (2020 or later): Step 1(c), Step 2 checkbox, Step 3 annual
     * credits, Step 4(a)/(b) annual amounts. Step 4(c) reuses
     * additional_tax_per_period. */
    filingStatus: text("filing_status", {
      enum: ["single", "married_joint", "head_household"],
    }),
    multipleJobs: boolean("multiple_jobs").notNull().default(false),
    dependentCredits: money("dependent_credits"),
    otherIncomeAnnual: money("other_income_annual"),
    deductionsAnnual: money("deductions_annual"),
    /** 2019-or-earlier W-4 on file: withhold from allowances instead. */
    w4Pre2020: boolean("w4_pre_2020").notNull().default(false),
    w4Allowances: integer("w4_allowances"),
    /** US statutory exemptions (F-1 students, some family employment). */
    ficaExempt: boolean("fica_exempt").notNull().default(false),
    futaExempt: boolean("futa_exempt").notNull().default(false),
    suiExempt: boolean("sui_exempt").notNull().default(false),
    /** Historical vacation evidence; effective policy lives in payroll_vacation_terms. */
    vacationPercent: numeric("vacation_percent", { precision: 7, scale: 4 }),
    vacationMethod: text("vacation_method", {
      enum: ["accrue", "pay_each_period"],
    }),
    /** Union membership: drives dues, fringes, and remittance reporting. */
    unionAgreementId: uuid("union_agreement_id"),
    unionClassificationId: uuid("union_classification_id"),
    /** Payroll program/EIN account this employee is remitted and filed under
     * (payroll_filing_accounts). Null = the country pack's default account. */
    filingAccountId: uuid("filing_account_id"),
    /** How this employee receives a pay stub: emailed, printed in the run's
     * print set, or both. */
    stubDelivery: text("stub_delivery", {
      enum: ["email", "print", "both"],
    }).notNull().default("email"),
    /**
     * Payroll-owned override of how this employee's net pay leaves the bank.
     * NULL = inherit `parties.payment_method` (see
     * engine/src/payroll/payment-method.ts for the full resolution ladder).
     * Payroll keeps its own column because the party-level enum is shared with
     * AP/party maintenance and carries values that are not payroll rails
     * (card/cash/other), and because moving wages onto a different rail is a
     * payroll decision — `payroll.manage`, not `parties.write`.
     */
    paymentMethod: text("payment_method", { enum: ["eft", "cheque"] }),
    /**
     * Whether the employee is paid in whole or in part on commission, for
     * statutory-holiday rules that read it. Three-state by design: null is
     * UNANSWERED and the engine fails closed exactly as a missing per-request
     * entry does — never default this to false (see migration 0181).
     */
    paidOnCommission: boolean("paid_on_commission"),
    /**
     * Pack-declared employee facts for the PL/ES/JP/BR statutory engines
     * (0191): one nullable column per fact, named for the engine key that
     * reads it. Null is "unknown" — never zero, never a guess — and the
     * packs' compute paths fail closed on it by design. Bounds live in the
     * migration CHECKs below, restating what each pack's engine enforces;
     * columns with no declared bounds (PL birth year, JP grade) carry none.
     * kaigo and situación are TEXT holding closed answer strings because
     * their engines compare against "false"/SITUPER strings — a boolean
     * column would refuse forever (false is not "false").
     */
    plRokUrodzenia: integer("pl_rok_urodzenia"),
    esAnoNacimiento: integer("es_ano_nacimiento"),
    esGrupoCotizacion: integer("es_grupo_cotizacion"),
    esSituacionLaboral: text("es_situacion_laboral"),
    esContratoTemporal: text("es_contrato_temporal"),
    jpHyojunHoshu: integer("jp_hyojun_hoshu"),
    jpKaigoDainigou: text("jp_kaigo_dainigou"),
    brDependentes: integer("br_dependentes"),
    brPensaoMensal: money("br_pensao_mensal"),
    brSalarioFamiliaFilhos: integer("br_salario_familia_filhos"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("employee_payroll_profiles_employee").on(t.orgId, t.employeePartyId),

    index("employee_payroll_profiles_employment").on(t.orgId, t.employmentId),
    // One profile per employment once stamped; mirrors
    // employee_payroll_profiles_employment_unique (0186).
    uniqueIndex("employee_payroll_profiles_employment_unique").on(t.orgId, t.employmentId)
      .where(sql`employment_id is not null`),
    index("employee_payroll_profiles_schedule").on(t.orgId, t.payScheduleId),
    check("employee_payroll_profiles_fed_code",
      sql`${t.federalClaimCode} is null or (${t.federalClaimCode} >= 0 and ${t.federalClaimCode} <= 10)`),
    check("employee_payroll_profiles_prov_code",
      sql`${t.provincialClaimCode} is null or (${t.provincialClaimCode} >= 0 and ${t.provincialClaimCode} <= 10)`),
    check("employee_payroll_profiles_vacation",
      sql`${t.vacationPercent} is null or ${t.vacationPercent} >= 0`),
    check("employee_payroll_profiles_allowances",
      sql`${t.w4Allowances} is null or ${t.w4Allowances} >= 0`),
    // 0191 pack-fact bounds (plus the 0389 salário-família count), mirroring
    // the migration CHECKs exactly: the ES año/grupo bands, the ES situación
    // and JP kaigo closed sets, and the non-negative BR dependent and
    // qualifying-children counts. PL rok urodzenia and JP hyōjun carry
    // no declared bounds, so they carry no CHECK either.
    check("employee_payroll_profiles_es_ano",
      sql`${t.esAnoNacimiento} is null or (${t.esAnoNacimiento} >= 1906 and ${t.esAnoNacimiento} <= 2026)`),
    check("employee_payroll_profiles_es_grupo",
      sql`${t.esGrupoCotizacion} is null or (${t.esGrupoCotizacion} >= 1 and ${t.esGrupoCotizacion} <= 11)`),
    check("employee_payroll_profiles_es_situacion",
      sql`${t.esSituacionLaboral} is null or ${t.esSituacionLaboral} in ('activo', 'pensionista', 'desempleado')`),
    check("employee_payroll_profiles_es_contrato",
      sql`${t.esContratoTemporal} is null or ${t.esContratoTemporal} in ('true', 'false')`),
    check("employee_payroll_profiles_jp_kaigo",
      sql`${t.jpKaigoDainigou} is null or ${t.jpKaigoDainigou} in ('true', 'false')`),
    check("employee_payroll_profiles_br_dependentes",
      sql`${t.brDependentes} is null or ${t.brDependentes} >= 0`),
    check("employee_payroll_profiles_br_salario_familia",
      sql`${t.brSalarioFamiliaFilhos} is null or ${t.brSalarioFamiliaFilhos} >= 0`),
  ],
);

/** Recurring per-employee component assignments (effective-dated). */
export const employeePayComponents = pgTable(
  "employee_pay_components",
  {
    id: id(),
    orgId: orgRef(),
    employeePartyId: uuid("employee_party_id").notNull(),
    /** HRM employment link (0186): null = not yet stamped, never "no employment". */
    employmentId: uuid("employment_id"),
    componentId: uuid("component_id").notNull(),
    /** Overrides the component default (amount, hourly rate, or percent). */
    value: money("value"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [

    index("employee_pay_components_employment").on(t.orgId, t.employmentId),
    index("employee_pay_components_employee").on(t.orgId, t.employeePartyId, t.effectiveFrom),
    check("employee_pay_components_range",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
  ],
);

/**
 * Per-component department override of the payroll expense (debit) account:
 * one active expense account per component, department and date. Resolution
 * at calculate prefers the line's department mapping over the component
 * default; the liability side is unchanged.
 */
export const payComponentDepartmentExpenses = pgTable(
  "pay_component_department_expenses",
  {
    id: id(),
    orgId: orgRef(),
    payComponentId: uuid("pay_component_id").notNull(),
    departmentId: uuid("department_id").notNull(),
    expenseAccountId: uuid("expense_account_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    foreignKey({
      name: "pay_component_department_expenses_component_fkey",
      columns: [t.orgId, t.payComponentId],
      foreignColumns: [payComponents.orgId, payComponents.id],
    }),
    foreignKey({
      name: "pay_component_department_expenses_department_fkey",
      columns: [t.departmentId],
      foreignColumns: [departments.id],
    }),
    foreignKey({
      name: "pay_component_department_expenses_account_tenant_fkey",
      columns: [t.orgId, t.expenseAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    index("pay_component_department_expenses_component").on(t.orgId, t.payComponentId),
    index("pay_component_department_expenses_lookup").on(t.orgId, t.payComponentId, t.departmentId),
    check("pay_component_department_expenses_effective_pair",
      sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
  ],
);

/** One employee's pay for one run, with the full T4127 explainability trace. */
export const payStubs = pgTable(
  "pay_stubs",
  {
    id: id(),
    orgId: orgRef(),
    payRunDocumentId: uuid("pay_run_document_id").notNull(),
    employeePartyId: uuid("employee_party_id").notNull(),
    /**
     * HRM employment snapshot (0186): written once at calculate from
     * `resolveEmploymentForPayroll`, never re-resolved — the stub is the
     * historical record. Null = calculated before stamping existed.
     */
    employmentId: uuid("employment_id"),
    /** Statutory pack identity captured at calculation, not the live profile. */
    country: text("country"),
    countrySource: text("country_source", {
      enum: ["calculation", "legacy_region", "unknown"],
    }).notNull().default("unknown"),
    /** Explicit null means unassigned, never a live default-account fallback. */
    filingAccountId: uuid("filing_account_id"),
    filingAccountSource: text("filing_account_source", {
      enum: ["unknown", "calculation", "insertion", "reconciled"],
    }).notNull().default("unknown"),
    filingAccountEvidence: jsonb("filing_account_evidence"),
    /** Snapshot: recalculation never depends on the live profile. */
    province: text("province").notNull(),
    periodsPerYear: integer("periods_per_year").notNull(),
    payDate: date("pay_date").notNull(),
    taxYear: integer("tax_year").notNull(),
    federalClaim: money("federal_claim").notNull().default("0"),
    provincialClaim: money("provincial_claim").notNull().default("0"),
    currency: currencyCode("currency_code").notNull(),
    gross: money("gross").notNull().default("0"),
    pensionableEarnings: money("pensionable_earnings").notNull().default("0"),
    insurableEarnings: money("insurable_earnings").notNull().default("0"),
    netPay: money("net_pay").notNull().default("0"),
    employerCost: money("employer_cost").notNull().default("0"),
    vacationAccrued: money("vacation_accrued").notNull().default("0"),
    /** Every T4127 factor (A, K1…K4, T1…T4, V1, V2, S, TB…) for the trace UI. */
    factors: jsonb("factors").notNull().default(sql`'{}'::jsonb`),
    /**
     * Snapshot: the rail this pay actually went out on, resolved at calculate
     * time. Re-resolving from the live party/profile would let a later edit
     * reinterpret a paid run — the stub is the historical record.
     */
    paymentMethod: text("payment_method", { enum: ["eft", "cheque"] }),
    /** Allocated from the `payroll_cheque` number sequence when the cheque is
     *  issued; unique per org so a number is never printed twice. */
    chequeNumber: text("cheque_number"),
    ...auditColumns,
  },
  (t) => [


    index("pay_stubs_employment").on(t.orgId, t.employmentId),
    index("pay_stubs_filing_account").on(t.orgId, t.filingAccountId),
    check("pay_stubs_filing_account_evidence", sql`
      (${t.filingAccountSource} = 'unknown' and ${t.filingAccountId} is null and ${t.filingAccountEvidence} is null) or
      (${t.filingAccountSource} in ('calculation', 'insertion') and ${t.filingAccountEvidence} is null) or
      (${t.filingAccountSource} = 'reconciled' and ${t.filingAccountEvidence} is not null
        and jsonb_typeof(${t.filingAccountEvidence}) = 'object'
        and coalesce(jsonb_typeof(${t.filingAccountEvidence}->'reason') = 'string', false)
        and coalesce(jsonb_typeof(${t.filingAccountEvidence}->'reference') = 'string', false)
        and length(trim(${t.filingAccountEvidence}->>'reason')) > 0
        and length(trim(${t.filingAccountEvidence}->>'reference')) > 0)
    `),
    check("pay_stubs_country_evidence", sql`
      (${t.country} is null and ${t.countrySource} = 'unknown') or
      (${t.country} is not null and ${t.country} ~ '^[A-Z]{2}$'
        and ${t.countrySource} in ('calculation', 'legacy_region'))
    `),
    uniqueIndex("pay_stubs_run_employee").on(t.payRunDocumentId, t.employeePartyId),
    index("pay_stubs_employee_year").on(t.orgId, t.employeePartyId, t.taxYear, t.payDate),
    uniqueIndex("pay_stubs_cheque_number").on(t.orgId, t.chequeNumber)
      .where(sql`${t.chequeNumber} is not null`),
    check("pay_stubs_net_nonnegative", sql`${t.netPay} >= 0`),
    check("pay_stubs_payment_method",
      sql`${t.paymentMethod} is null or ${t.paymentMethod} in ('eft', 'cheque')`),
    // A cheque number can only exist on a cheque.
    check("pay_stubs_cheque_number_method",
      sql`${t.chequeNumber} is null or ${t.paymentMethod} = 'cheque'`),
  ],
);

/** Component lines under a stub; job-cost splits carry dimensions. */
export const payStubLines = pgTable(
  "pay_stub_lines",
  {
    id: id(),
    orgId: orgRef(),
    stubId: uuid("stub_id").notNull(),
    componentId: uuid("component_id"),
    kind: text("kind", {
      enum: ["earning", "deduction", "employer_contribution"],
    }).notNull(),
    description: text("description").notNull(),
    hours: numeric("hours", { precision: 12, scale: 2 }),
    rate: money("rate"),
    earnedFrom: date("earned_from", { mode: "string" }),
    earnedTo: date("earned_to", { mode: "string" }),
    amount: money("amount").notNull(),
    /** Calculated payment representation, frozen independently of component edits. */
    paymentKind: text("payment_kind", { enum: ["cash", "non_cash"] }).notNull().default("cash"),
    nonCashAccountId: uuid("non_cash_account_id"),
    projectId: uuid("project_id"),
    departmentId: uuid("department_id"),
    timeTypeId: uuid("time_type_id"),
    /** Service item the hours on this line were worked on, carried from the
     * time entry like project_id/time_type_id. Null for lines with no
     * operational item (salary, bonus, per diem). */
    itemId: uuid("item_id"),
    sequence: integer("sequence").notNull().default(100),
    /** Snapshot at calculate: the account this earning line was costed to.
     * Posting debits this, never the component's or item's current setup.
     * Resolution is item > department mapping > component > org default;
     * see migrations 0180 and 0485. */
    expenseAccountId: uuid("expense_account_id"),
    expenseAccountSource: text("expense_account_source", {
      enum: ["unknown", "item", "component", "department", "org_default"],
    }).notNull().default("unknown"),
    expenseAccountEvidence: jsonb("expense_account_evidence").$type<{ reason: string; reference: string }>(),
    /** Effective-date-resolved pack reporting code, snapshotted at payroll calculation. */
    statutoryReportingCode: jsonb("statutory_reporting_code").$type<{
      formCode: string; boxCode: string; code: string; label: string;
    }>(),
    /** Snapshot at commit: the vendor this line accrued to. Remittances route
     * by this, never the component's current vendor (migration 0296). A
     * union agreement needs no separate column: its destination reaches the
     * line only through its auto-provisioned component. */
    remittancePartyId: uuid("remittance_party_id"),
    /** Snapshot at commit: the account this line was credited to. Remittances
     * debit this, never the component's current setup. */
    liabilityAccountId: uuid("liability_account_id"),
    liabilityAccountSource: text("liability_account_source", {
      enum: ["unknown", "commit", "legacy_component", "reconciled"],
    }).notNull().default("unknown"),
    liabilityAccountEvidence: jsonb("liability_account_evidence").$type<{ reason: string; reference: string }>(),
    ...auditColumns,
  },
  (t) => [
    index("pay_stub_lines_stub").on(t.stubId, t.sequence),
    check("pay_stub_lines_payment_kind", sql`${t.paymentKind} in ('cash', 'non_cash')`),
    check("pay_stub_lines_non_cash_shape", sql`
      (${t.paymentKind} = 'cash' and ${t.nonCashAccountId} is null) or
      (${t.paymentKind} = 'non_cash' and ${t.kind} = 'earning' and ${t.nonCashAccountId} is not null)
    `),
    foreignKey({ name: "pay_stub_lines_non_cash_account_tenant_fkey",
      columns: [t.orgId, t.nonCashAccountId], foreignColumns: [accounts.orgId, accounts.id],
    }),
    index("pay_stub_lines_project").on(t.orgId, t.projectId),
    check("pay_stub_lines_earning_dates_pair", sql`
      (${t.earnedFrom} is null and ${t.earnedTo} is null) or
      (${t.earnedFrom} is not null and ${t.earnedTo} is not null and ${t.earnedFrom} <= ${t.earnedTo})
    `),
    foreignKey({ name: "pay_stub_lines_remittance_party_tenant_fkey",
      columns: [t.orgId, t.remittancePartyId],
      foreignColumns: [parties.orgId, parties.id],
    }),
    index("pay_stub_lines_remittance_party").on(t.orgId, t.remittancePartyId),
    foreignKey({ name: "pay_stub_lines_liability_account_tenant_fkey",
      columns: [t.orgId, t.liabilityAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    index("pay_stub_lines_liability_account").on(t.orgId, t.liabilityAccountId),
    check("pay_stub_lines_liability_account_evidence", sql`
      (${t.liabilityAccountSource} = 'unknown' and ${t.liabilityAccountId} is null and ${t.liabilityAccountEvidence} is null) or
      (${t.liabilityAccountSource} in ('commit', 'legacy_component') and ${t.liabilityAccountId} is not null and ${t.liabilityAccountEvidence} is null) or
      (${t.liabilityAccountSource} = 'reconciled' and ${t.liabilityAccountId} is not null and ${t.liabilityAccountEvidence} is not null
        and jsonb_typeof(${t.liabilityAccountEvidence}) = 'object'
        and coalesce(jsonb_typeof(${t.liabilityAccountEvidence}->'reason') = 'string',false)
        and coalesce(jsonb_typeof(${t.liabilityAccountEvidence}->'reference') = 'string',false)
        and length(trim(${t.liabilityAccountEvidence}->>'reason')) > 0
        and length(trim(${t.liabilityAccountEvidence}->>'reference')) > 0)
    `),
    foreignKey({ name: "pay_stub_lines_expense_account_tenant_fkey",
      columns: [t.orgId, t.expenseAccountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
    index("pay_stub_lines_expense_account").on(t.orgId, t.expenseAccountId),
    index("pay_stub_lines_item").on(t.orgId, t.itemId),
    check("pay_stub_lines_expense_account_evidence", sql`
      (${t.expenseAccountSource} = 'unknown' and ${t.expenseAccountId} is null and ${t.expenseAccountEvidence} is null) or
      (${t.expenseAccountSource} in ('item', 'component', 'org_default') and ${t.expenseAccountId} is not null and ${t.expenseAccountEvidence} is not null
        and jsonb_typeof(${t.expenseAccountEvidence}) = 'object'
        and coalesce(jsonb_typeof(${t.expenseAccountEvidence}->'reason') = 'string',false)
        and coalesce(jsonb_typeof(${t.expenseAccountEvidence}->'reference') = 'string',false)
        and length(trim(${t.expenseAccountEvidence}->>'reason')) > 0
        and length(trim(${t.expenseAccountEvidence}->>'reference')) > 0)
    `),
  ],
);

/**
 * IT addizionali assessed-saldo carry-in (0393): the prior-year
 * regional/municipal assessment per (org, employee, tax year) that the year's
 * saldo installments withhold. Row presence IS the declaration — an explicit
 * zero records a worker with no prior-year Italian employment — so this lives
 * in its own table rather than on payroll_opening_balances, whose save
 * deletes all-zero rows ("zero is no carry-in, not a row") and would make
 * that remedy unrecordable. Written by the carry-in save under the employee
 * tax-year fence; read with the December settlement factors.
 */
export const itAddizionaliOpeningBalances = pgTable(
  "it_addizionali_opening_balances",
  {
    id: id(),
    orgId: orgRef(),
    employeePartyId: uuid("employee_party_id").notNull(),
    /** The tax year whose installments withhold this assessment (year N for a year N-1 assessment). */
    taxYear: integer("tax_year").notNull(),
    /** Prior-year addizionale regionale assessment (D.Lgs. 446/1997 art. 50). Never negative. */
    regionaleSaldo: money("regionale_saldo").notNull().default("0"),
    /** Prior-year addizionale comunale assessment (D.Lgs. 360/1998 art. 1). Never negative. */
    comunaleSaldo: money("comunale_saldo").notNull().default("0"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("it_addizionali_opening_balances_employee_year").on(
      t.orgId, t.employeePartyId, t.taxYear,
    ),
    check(
      "it_addizionali_opening_balances_nonnegative",
      sql`${t.regionaleSaldo} >= 0 AND ${t.comunaleSaldo} >= 0`,
    ),
    index("it_addizionali_opening_balances_org_year").on(t.orgId, t.taxYear),
  ],
);

export const unionFringes = pgTable(
  "union_fringes",
  {
    id: id(),
    orgId: orgRef(),
    agreementId: uuid("agreement_id").notNull(),
    /** Null = applies to every classification under the agreement. */
    classificationId: uuid("classification_id"),
    code: text("code").notNull(),
    name: text("name").notNull(),
    calc: text("calc", {
      enum: ["per_hour_worked", "percent_of_gross"],
    }).notNull(),
    value: money("value").notNull(),
    paidBy: text("paid_by", { enum: ["employer", "employee"] }).notNull(),
    /** Employer fringes tagged job_costed split by project like wages. */
    jobCosted: boolean("job_costed").notNull().default(true),
    /** Auto-provisioned pay component carrying GL accounts + remittance. */
    componentId: uuid("component_id"),
    sequence: integer("sequence").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("union_fringes_agreement_code").on(t.agreementId, t.code),
    index("union_fringes_agreement").on(t.orgId, t.agreementId),
    check("union_fringes_value_nonnegative", sql`${t.value} >= 0`),
  ],
);
