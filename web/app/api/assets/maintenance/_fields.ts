import { z } from "zod";
import { calendarDate, id, optionalMoney, optionalText } from "../_depth";

/** Maintenance schedule terms shared by create and update. */
export const scheduleFields = {
  name: z.string().trim().min(1, "name the maintenance task").max(200),
  description: optionalText(4000),
  intervalMonths: z.number().int().min(1).max(600).nullable().optional(),
  intervalUsage: optionalMoney("intervalUsage"),
  usageUnit: optionalText(40),
  startsOn: calendarDate("startsOn"),
  vendorPartyId: id.nullable().optional(),
  estimatedCost: optionalMoney("estimatedCost"),
  leadDays: z.number().int().min(0).max(365).nullable().optional(),
};
