/** Statutory holidays: the calendar, and the pay the calendar owes. See the sibling holiday-* modules. */

export { PayrollHolidayError, weekdayOf, isWeekend, easterSunday, resolveHolidayRule, resolveObservedHolidays, loadHolidayOverrides, observedHolidays, holidayDateSet, payrollHolidayJurisdictionKeys, statutoryHolidayCalendarsFor, statutoryHolidayCalendarsOf, isBusinessDay, nextBusinessDay, addBusinessDays, businessDaysBetween } from "./holiday-calendar.ts";
export type { ObservedHoliday, HolidayOverride, PayrollHolidayProfileScope, StatutoryHolidayCalendar, StatutoryHolidayCalendarRefusal, StatutoryHolidayCalendarReading } from "./holiday-calendar.ts";
export { statutoryHolidayPayRule, emptyLookbackEarnings, describeDayCounting, holidayPayBase, computeStatutoryHolidayPay, computeWorkTriggeredHolidayPay } from "./holiday-pay-computation.ts";
export type { HolidayLookbackEarnings, HolidayPayContext, HolidayPayResult } from "./holiday-pay-computation.ts";
export { ruleDeclaresOccupationArms, assertOccupationClass, applyOccupationWeeklyCap, statutoryHolidayEmploymentSource, resolveStatutoryHolidayPay } from "./holiday-pay-resolution.ts";
export type { StatutoryHolidayEarningLine, StatutoryHolidayPayInput, StatutoryHolidayEligibilityFacts, StatutoryHolidayEmploymentSource } from "./holiday-pay-resolution.ts";
export { lookbackWindowEnd, lookbackWindow, attributeStubEarningsToWindow, countHolidayQualifyingDays, loadHolidayDayEvidence, evidencedEntitledPayDays, hoursOn, undeclaredJurisdictionHolidayConflict } from "./holiday-lookback-evidence.ts";
export type { HolidayDayEvidence, UndeclaredJurisdictionHolidayConflict } from "./holiday-lookback-evidence.ts";
export { jurisdictionKey, payrollJurisdictionDeclared } from "./packs.ts";
