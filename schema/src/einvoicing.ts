import { bigint, customType, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => "bytea" });

export const EINVOICE_PROFILE_KEYS = ["en16931-cii", "en16931-ubl", "xrechnung-cii", "xrechnung-ubl", "facturx", "peppol-bis", "nlcius", "ehf", "peppol-aunz", "peppol-sg", "pint-aunz", "pint-sg"] as const;

/**
 * Seller identity, payment instructions and the VAT treatment of untaxed
 * lines that one legal entity states on its EN 16931 e-invoices. The seller
 * name and country come from the subsidiary; its VAT identifier comes from
 * its tax registration.
 */
export const einvoiceSettings = pgTable(
  "einvoice_settings",
  {
    id: id(),
    orgId: orgRef(),
    subsidiaryId: uuid("subsidiary_id").notNull(),
    defaultProfile: text("default_profile", { enum: EINVOICE_PROFILE_KEYS }).notNull(),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    postcode: text("postcode"),
    subdivision: text("subdivision"),
    tradingName: text("trading_name"),
    legalRegistrationId: text("legal_registration_id"),
    legalRegistrationScheme: text("legal_registration_scheme"),
    taxNumber: text("tax_number"),
    contactName: text("contact_name"),
    contactPhone: text("contact_phone"),
    contactEmail: text("contact_email"),
    electronicAddress: text("electronic_address"),
    electronicAddressScheme: text("electronic_address_scheme"),
    paymentMeansCode: text("payment_means_code").notNull().default("30"),
    payeeAccountId: text("payee_account_id"),
    payeeAccountName: text("payee_account_name"),
    payeeBic: text("payee_bic"),
    untaxedLineCategory: text("untaxed_line_category", { enum: ["Z", "E", "O"] }),
    untaxedExemptionReasonCode: text("untaxed_exemption_reason_code"),
    untaxedExemptionReason: text("untaxed_exemption_reason"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("einvoice_settings_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("einvoice_settings_org_id_subsidiary_id_key").on(t.orgId, t.subsidiaryId),
  ],
);

/** Each e-invoice exactly as issued, retained byte for byte with its digest. */
export const einvoiceDocuments = pgTable(
  "einvoice_documents",
  {
    id: id(),
    orgId: orgRef(),
    documentId: uuid("document_id").notNull(),
    profile: text("profile", { enum: EINVOICE_PROFILE_KEYS }).notNull(),
    typeCode: text("type_code").notNull(),
    buyerReference: text("buyer_reference"),
    fileName: text("file_name").notNull(),
    mediaType: text("media_type", { enum: ["application/xml", "application/pdf"] }).notNull(),
    content: bytea("content").notNull(),
    contentSha256: text("content_sha256").notNull(),
    xmlSha256: text("xml_sha256").notNull(),
    documentRevision: bigint("document_revision", { mode: "bigint" }).notNull(),
    findings: jsonb("findings").notNull().default([]),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    issuedBy: uuid("issued_by").notNull(),
  },
  (t) => [
    uniqueIndex("einvoice_documents_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("einvoice_documents_xml_key").on(t.orgId, t.documentId, t.profile, t.xmlSha256),
    index("einvoice_documents_document").on(t.orgId, t.documentId, t.issuedAt),
  ],
);
