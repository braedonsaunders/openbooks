import assert from "node:assert/strict";
import { enableHrm, grantPermissions } from "./hrm-harness.ts";
import { requestExport, buildExport, downloadExport } from "../hrm/documents/dsar.ts";
import { readZipJson, withZipFixture } from "./zip-fixture.ts";

/** Request, build and read the native subject export; partial requested domains fail. */
export async function exportedSubjectEvidence(query: { orgId: string; actorId: string; partyId: string }, modules: readonly string[]) {
  await enableHrm(query.orgId, "hrmDocuments");
  await grantPermissions(query.orgId, query.actorId, ["hrm.documents.read", "hrm.documents.manage"]);
  const requested = await requestExport(query);
  await buildExport(query.orgId, requested.id);
  const { bytes } = await downloadExport({ ...query, exportId: requested.id });
  const payload = await withZipFixture(bytes, path => readZipJson<{
    [key: string]: unknown;
    employerAssignments: Record<string, unknown>[]; periodOpenings: Record<string, unknown>[];
    manifest: { gathered: { module: string; status: string; detail?: string }[] };
  }>(path));
  for (const module of modules) {
    const gathered = payload.manifest.gathered.find(entry => entry.module === module);
    assert.equal(gathered?.status, "included", JSON.stringify(gathered));
  }
  return payload;
}

export function exportedPayrollEvidence(query: { orgId: string; actorId: string; partyId: string }) {
  return exportedSubjectEvidence(query, ["payroll"]);
}
