import { z } from "zod";
import { isCivilDate } from "@openbooks/engine/src/hrm/temporal.ts";

/** Zod boundary for Gregorian civil dates; shape alone admits impossible days. */
export function civilDateInput(message = "must be a real YYYY-MM-DD calendar date") {
  return z.string().refine(isCivilDate, message);
}
