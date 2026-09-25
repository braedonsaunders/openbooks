
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
 * (engine/src/payroll/run.ts `seedPayrollComponents` provisions exactly this
 * set) and the source of each one's `assessedOn` class, so a jurisdiction's
 * statutory set is declared once, in one place, and nowhere else.
 *
 * The US pack declares its slots (FIT withholding, FICA, FUTA, SUTA) the
 * same way — nothing in the settings UI or the commit path is
 * Canada-specific.
 */

export { factorLabelForPack, holidayPayLookbackBasis } from "./pack-types"
export type { PayrollAssessedOn, PayrollRemittanceTreatment, PayrollRetroactiveTreatment, PayrollCoreTaxBaseKey, PayrollStateTaxBaseKey, PayrollTaxBaseKey, PayrollTaxBases, PayrollDeductionTreatment, PayrollStatutoryReportingCode, PayrollAggregateBaseSource, PayrollAggregateScope, PayrollAggregateTiming, PayrollAggregateBand, PayrollAggregateClassBands, PayrollAggregateRate, PayrollAggregateAllowance, PayrollEmployerAggregateLevy, PayrollStatutoryComponent, PayrollStatutorySlot, PayrollCountry, PayrollContributoryBases, PayrollContributionProgram, PayrollAccountOpeningBase, PayrollOpeningYtdField, PayrollProfileExemptionFlag, PayrollEmployeeIdentifier, EmployeeIdentifierVerdict, PayrollCountryPack, PayrollTaxYearDefinition, PayrollRegionCoverage, PayrollHolidayRule, PayrollHolidayObservance, PayrollHoliday, PayrollWorkTriggeredHoliday, PayrollHolidayDayCounting, PayrollHolidayLookbackBoundary, PayrollHolidayPayLookbackBasis, PayrollHolidayPayBasis, PayrollHolidayPayInclusions, PayrollHolidayQualifying, PayrollHolidayPremium, PayrollHolidayPayRule, PayrollHolidayPayEdition, PayrollRemembranceAlternateDayRule, PayrollOccupationWeeklyCap, PayrollJurisdiction, RemittanceDueRule, PayrollRemittanceFrequencyBand, PayrollRemittanceSchedule, StatutoryRemittanceDeclaration } from "./pack-types"
export { PAYROLL_COUNTRY_PACKS, publishPackDeclarations, packStatutoryComponents, occupationCapValues, incomeTaxWithholdingSystemKeys, employeeSocialInsuranceSystemKeys, eiColumnSystemKeys, installablePayrollCountries, installablePayrollPacks, payrollRegionLabel, payrollPack, resolvePayrollStatutoryReportingCode, payrollCountry } from "./pack-registry"
export { validatePackEmployeeIdentifier, packWarnsOnMissingIdentifier } from "./pack-identifiers"
export { payrollTaxYear, assertPayrollRegionSupported, payrollRegionSupported, declaredPayrollTaxYears, registerPayrollTaxYears, unregisterPayrollTaxYears, payrollTaxYearSupport, payrollTaxYearOperatorMessage, payrollTaxYearProblem, assertPayrollTaxYearSupported, payrollTaxYearCoverage, payrollTaxYearForDate, payrollFilingYearOptions } from "./pack-tax-years"
export type { PayrollTaxYearProblem, PayrollTaxYearCoverage } from "./pack-tax-years"
export { resolvePayrollRunContext, resolveEmployeePayrollContext, declaredPackRates, packRates, statutoryRateSlot, statutoryAssessment } from "./pack-run-context"
export type { PayrollRunContext, EmployeePayrollContext } from "./pack-run-context"
export { declaredJurisdictions, payrollJurisdiction, jurisdictionKey, labourJurisdictionProblem, payrollJurisdictionDeclared, employmentJurisdictionsOf } from "./pack-jurisdictions"
export { statutoryRemittanceDeclaration, allRemittanceSchedules, remittanceScheduleInForce, remittanceFrequencyBand, remittanceBandForAverage, packRemittanceSchedules, remittanceScheduleForFrequencyKey, declaredRemittanceFrequencySettingsKeys, declaredRemittanceVendorSettingsKeys, packRemittanceVendorSettingsKeys, packAllowsRegistrationTimetableFallback, legacyStatutoryLiabilityAccount } from "./pack-remittance-schedules"
export { assertContributoryBasesDeclared, packSlotAppliesToPopulation, packSlotState, uninstallPayrollPack, setPackSlotAccount, ensurePackSlotRoleAccounts } from "./pack-slots"
export type { PackSlotState } from "./pack-slots"
export { taxYearFor } from "./tax-year-math.ts"
export { PayrollJurisdictionError, PayrollPackError } from "./payroll-error.ts"
