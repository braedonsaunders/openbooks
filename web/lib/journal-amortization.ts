import { z } from "zod";
import { isoDate, nullableUuidId } from "./api/json";

/** Native journal line fields shared by the create and revision-fenced edit boundaries. */
export const journalAmortizationFields = {
  amortizationTemplateId: nullableUuidId.optional(),
  amortizationStartOn: isoDate().nullable().optional(),
  amortizationEndOn: isoDate().nullable().optional(),
};

export const journalAmortizationInput = z.object(journalAmortizationFields);
