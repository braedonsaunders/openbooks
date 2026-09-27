/** Payment-format metadata shared by AP operations and payroll export. */
export const PAYMENT_RAIL_DESCRIPTORS = {
  cpa005: {
    currency: "CAD",
    paymentFormatRails: ["cpa005_credit"],
    payrollRails: ["cpa005_credit"],
    extension: "txt",
    contentType: "text/plain; charset=us-ascii",
  },
  nacha: {
    currency: "USD",
    paymentFormatRails: ["nacha_credit", "nacha_debit"],
    payrollRails: ["nacha_credit"],
    extension: "ach",
    contentType: "text/plain; charset=us-ascii",
  },
  sepa: {
    currency: "EUR",
    paymentFormatRails: ["sepa_credit", "sepa_debit"],
    payrollRails: ["sepa_credit"],
    extension: "xml",
    contentType: "application/xml",
  },
  cemtex: {
    currency: "AUD",
    paymentFormatRails: ["cemtex_credit"],
    payrollRails: ["cemtex_credit"],
    extension: "aba",
    contentType: "text/plain; charset=us-ascii",
  },
  bacs: {
    currency: "GBP",
    paymentFormatRails: ["bacs_credit"],
    payrollRails: ["bacs_credit"],
    extension: "txt",
    contentType: "text/plain; charset=us-ascii",
  },
  zengin: {
    currency: "JPY",
    paymentFormatRails: ["zengin_credit"],
    payrollRails: ["zengin_credit"],
    extension: "txt",
    contentType: "text/plain; charset=Shift_JIS",
  },
  cnab240: {
    currency: "BRL",
    paymentFormatRails: ["cnab240_bb_credit"],
    payrollRails: ["cnab240_bb_credit"],
    extension: "rem",
    contentType: "text/plain; charset=us-ascii",
  },
} as const;

export type PaymentRailDescriptorKey = keyof typeof PAYMENT_RAIL_DESCRIPTORS;

/** SQL list for a descriptor's accepted payment_formats.rail values. */
export function paymentFormatRails(key: PaymentRailDescriptorKey): readonly string[] {
  return PAYMENT_RAIL_DESCRIPTORS[key].paymentFormatRails;
}
