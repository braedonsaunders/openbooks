import { z } from "zod";
import { uuidId, isoDate } from "@/lib/api/json";
export const standingBody = z
  .object({
    subsidiaryId: uuidId
      .nullable()
      .optional()
      .describe("Legal entity covered by this withholding standing."),
    partyId: uuidId.describe("Contractor party id from find_parties."),
    schemeCode: z.string().trim().min(1).max(100).describe("Supported withholding scheme code."),
    bandCode: z.string().trim().min(1).max(100).describe("Scheme band or exemption code."),
    verificationReference: z
      .string()
      .max(500)
      .nullable()
      .optional()
      .describe("Authority verification reference."),
    verifiedOn: isoDate().nullable().optional().describe("Date the standing was verified."),
    validFrom: isoDate().describe("First effective date."),
    validTo: isoDate()
      .nullable()
      .optional()
      .describe("Last effective date, if the standing expires."),
    payeeReference: z
      .string()
      .max(500)
      .nullable()
      .optional()
      .describe("Contractor reference used on statutory reports."),
    payeeTaxOffice: z
      .string()
      .max(500)
      .nullable()
      .optional()
      .describe("Tax office or authority destination."),
    applyFromFirstPayment: z
      .boolean()
      .optional()
      .describe("Whether this standing applies from the contractor's first payment."),
    notes: z.string().max(10000).nullable().optional().describe("Supporting setup notes."),
  })
  .strict();
