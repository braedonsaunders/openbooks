import type { ReportEntity } from "./entities";

/**
 * Billing-platform history import reconciliation. Each completed import run
 * persists its reconciliation (MRR by month, open AR by customer, deferred
 * revenue, and the differences that block cut-over) on billing_import_runs;
 * this entity expands that stored evidence into report rows so the
 * cut-over report is first-class in the Reports hub with the native filter
 * bar — never a bespoke screen.
 */
export const BILLING_IMPORT_REPORT_ENTITIES: ReportEntity[] = [
  {
    key: "billing_import_reconciliation",
    label: "Billing import reconciliation",
    category: "saas_metrics",
    description:
      "Per-run billing-platform import reconciliation: MRR by month source vs OpenBooks, open AR by customer, and the differences that block cut-over.",
    from: `(
      select r.org_id, r.id as run_id, r.provider as provider, 'mrr' as section,
             m.value ->> 'month' as ref,
             (m.value ->> 'sourceMrrMajor')::numeric as source_major,
             (m.value ->> 'openbooksMrrMajor')::numeric as openbooks_major,
             (m.value ->> 'diffMajor')::numeric as diff_major,
             null::text as explanation
        from billing_import_runs r,
             jsonb_array_elements(coalesce(r.reconciliation -> 'mrr', '[]'::jsonb)) as m(value)
       where r.reconciliation is not null
      union all
      select r.org_id, r.id as run_id, r.provider as provider, 'open_ar' as section,
             a.value ->> 'customerExternalId' as ref,
             (a.value ->> 'sourceOpenMajor')::numeric as source_major,
             (a.value ->> 'openbooksOpenMajor')::numeric as openbooks_major,
             (a.value ->> 'diffMajor')::numeric as diff_major,
             null::text as explanation
        from billing_import_runs r,
             jsonb_array_elements(coalesce(r.reconciliation -> 'openAr', '[]'::jsonb)) as a(value)
       where r.reconciliation is not null
      union all
      select r.org_id, r.id as run_id, r.provider as provider, 'difference' as section,
             d.value ->> 'ref' as ref,
             (d.value ->> 'sourceMajor')::numeric as source_major,
             (d.value ->> 'openbooksMajor')::numeric as openbooks_major,
             null::numeric as diff_major,
             (d.value ->> 'kind') || ': ' || (d.value ->> 'explanation') as explanation
        from billing_import_runs r,
             jsonb_array_elements(coalesce(r.reconciliation -> 'differences', '[]'::jsonb)) as d(value)
       where r.reconciliation is not null
    ) recon`,
    orgColumn: "recon.org_id",
    requiredPermission: "sync.run",
    featureKey: "billingHistoryImport",
    defaultPeriodField: null,
    columns: [
      { key: "run_id", label: "Import run (id)", kind: "uuid", expr: "recon.run_id" },
      { key: "provider", label: "Provider", kind: "text", expr: "recon.provider" },
      {
        key: "section", label: "Section", kind: "enum", expr: "recon.section",
        options: ["mrr", "open_ar", "difference"],
      },
      { key: "ref", label: "Month / customer / record", kind: "text", expr: "recon.ref" },
      { key: "source_major", label: "Source amount", kind: "number", expr: "recon.source_major" },
      { key: "openbooks_major", label: "OpenBooks amount", kind: "number", expr: "recon.openbooks_major" },
      { key: "diff_major", label: "Difference", kind: "number", expr: "recon.diff_major" },
      { key: "explanation", label: "Explanation", kind: "text", expr: "recon.explanation" },
    ],
    defaultSort: { column: "ref", direction: "asc" },
  },
];
