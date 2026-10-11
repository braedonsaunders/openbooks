import { z } from "zod";
import { calendarDate, id, optionalMoney, optionalText } from "../_depth";

/** Insurance policy terms shared by create and update. */
export const policyFields = {
  insurerPartyId: id,
  policyNumber: z.string().trim().min(1, "enter the policy number").max(120),
  description: optionalText(2000),
  coverageStartsOn: calendarDate("coverageStartsOn"),
  coverageEndsOn: calendarDate("coverageEndsOn"),
  premium: optionalMoney("premium"),
  deductible: optionalMoney("deductible"),
  renewalLeadDays: z.number().int().min(0).max(365).nullable().optional(),
};
