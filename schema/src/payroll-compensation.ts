import { sql } from "drizzle-orm";
import { bigint, date, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { id, orgRef } from "./helpers";

/** Tenant FKs, state constraints, approval separation, range exclusions and history guards are enforced by migration 0551. */
const configurationEvidence = () => ({
  revision: integer("revision").notNull().default(1), reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), createdBy: uuid("created_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(), updatedBy: uuid("updated_by").notNull(),
});
const approvalEvidence = () => ({
  authorship: jsonb("authorship").notNull().default([]),
  submittedBy: uuid("submitted_by"), submittedAt: timestamp("submitted_at", { withTimezone: true }),
  decidedBy: uuid("decided_by"), decidedAt: timestamp("decided_at", { withTimezone: true }),
});
export const payrollCompensationConfiguration = pgTable("payroll_compensation_configuration", {
  orgId: uuid("org_id").primaryKey(), revision: bigint("revision", { mode: "bigint" }).notNull().default(sql`1`),
});
export const payrollCompensationPackages = pgTable("payroll_compensation_packages", {
  id: id(), orgId: orgRef(), subsidiaryId: uuid("subsidiary_id").notNull(), code: text("code").notNull(), name: text("name").notNull(),
  description: text("description"), country: text("country").notNull(), currency: text("currency").notNull(),
  status: text("status", { enum: ["active", "retired"] }).notNull().default("active"), ...configurationEvidence(),
}, (t) => [uniqueIndex("payroll_compensation_packages_org_id_id_key").on(t.orgId, t.id), uniqueIndex("payroll_compensation_packages_org_id_subsidiary_id_code_key").on(t.orgId, t.subsidiaryId, t.code)]);
export const payrollCompensationVersions = pgTable("payroll_compensation_versions", {
  id: id(), orgId: orgRef(), packageId: uuid("package_id").notNull(), version: integer("version").notNull(),
  effectiveFrom: date("effective_from").notNull(), effectiveTo: date("effective_to"),
  definition: jsonb("definition").notNull(), definitionHash: text("definition_hash").notNull(),
  status: text("status", { enum: ["draft", "submitted", "approved", "rejected"] }).notNull().default("draft"),
  ...approvalEvidence(), ...configurationEvidence(),
}, (t) => [uniqueIndex("payroll_compensation_versions_org_id_id_key").on(t.orgId, t.id), uniqueIndex("payroll_compensation_versions_org_id_package_id_version_key").on(t.orgId, t.packageId, t.version)]);
export const payrollCompensationAssignments = pgTable("payroll_compensation_assignments", {
  id: id(), orgId: orgRef(), packageId: uuid("package_id").notNull(), versionId: uuid("version_id").notNull(),
  employmentId: uuid("employment_id").notNull(), employeePartyId: uuid("employee_party_id").notNull(), subsidiaryId: uuid("subsidiary_id").notNull(),
  effectiveFrom: date("effective_from").notNull(), effectiveTo: date("effective_to"), inputs: jsonb("inputs").notNull(),
  status: text("status", { enum: ["draft", "submitted", "active", "rejected", "ended", "cancelled"] }).notNull().default("draft"),
  ...approvalEvidence(), ...configurationEvidence(),
}, (t) => [uniqueIndex("payroll_compensation_assignments_org_id_id_key").on(t.orgId, t.id)]);
export const payrollCompensationCalculations = pgTable("payroll_compensation_calculations", {
  id: id(), orgId: orgRef(), payRunDocumentId: uuid("pay_run_document_id").notNull(), assignmentId: uuid("assignment_id").notNull(), employmentId: uuid("employment_id").notNull(),
  sourceSnapshot: jsonb("source_snapshot").notNull(), resultSnapshot: jsonb("result_snapshot").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), createdBy: uuid("created_by").notNull(),
}, (t) => [uniqueIndex("payroll_compensation_calculations_org_id_id_key").on(t.orgId, t.id), uniqueIndex("payroll_compensation_calculations_org_id_pay_run_document_id_assi_key").on(t.orgId, t.payRunDocumentId, t.assignmentId)]);
