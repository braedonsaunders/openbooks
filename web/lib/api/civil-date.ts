import { z } from "zod";
import { isCivilDate } from "@openbooks/engine/hrm/temporal";

/** Zod boundary for Gregorian civil dates; shape alone admits impossible days. */
export function civilDateInput(message = "must be a real YYYY-MM-DD calendar date") {
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isCivilDate, message);
}
