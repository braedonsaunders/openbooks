"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button, Drawer, Input, Label, Select } from "@openbooks/ui";
import { PagedTable, type PagedColumn } from "../../../../components/paged-table";
import { ListFilterSelect } from "../../../../components/list-filter-select";
import { DateRangeFilter } from "../../../../components/date-range-filter";
import { readApiErrorMessage } from "../../../../lib/api-error";
import { useHeaderAction } from "../_ui/use-header-action";
import { DateField } from "../../../../components/date-field";

interface EmployeeChoice {
  employmentId: string;
  employeeName: string;
  subsidiaryName: string;
}
interface AllocationRow {
  id: string;
  region: string;
  subregion: string | null;
  serviceDays: number | null;
  workShare: string | null;
  source: string;
  evidenceDocumentId: string | null;
  changeReason: string;
}

type EvidenceSource = "hr_records" | "certificate" | "adequate_records";
const SOURCES: EvidenceSource[] = ["hr_records", "certificate", "adequate_records"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The list's scope lives in the address: employment plus period. */
export interface WorkLocationScope {
  employmentId: string;
  periodStart: string;
  periodEnd: string;
}

/** Saved allocations are read only for one complete, ordered scope; the API
 * refuses a partial one, so an incomplete filter reads the employee choices
 * alone. */
export function completeScope(scope: WorkLocationScope): boolean {
  return Boolean(
    scope.employmentId &&
    DATE.test(scope.periodStart) &&
    DATE.test(scope.periodEnd) &&
    scope.periodStart <= scope.periodEnd,
  );
}

async function fetchWorkLocations(scope: WorkLocationScope | null, fallback: string) {
  const params = new URLSearchParams();
  if (scope) {
    params.set("employmentId", scope.employmentId);
    params.set("periodStart", scope.periodStart);
    params.set("periodEnd", scope.periodEnd);
  }
  const query = params.toString();
  const response = await fetch(`/api/payroll/work-locations${query ? `?${query}` : ""}`);
  if (!response.ok) throw new Error(await readApiErrorMessage(response, fallback));
  return response.json() as Promise<{
    employees: EmployeeChoice[];
    rows?: AllocationRow[];
  }>;
}

/**
 * Payroll work locations: the allocation evidence recorded for employments
 * whose work is not covered by approved dated time entries. Search, the
 * employment filter and the period sit on the shared list toolbar; the
 * header's Record allocation action (?new=1) and a row click open one editor
 * drawer.
 */
export function WorkLocationsView() {
  const t = useTranslations("payroll.workLocations");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const scope: WorkLocationScope = {
    employmentId: searchParams?.get("employment") ?? "",
    periodStart: searchParams?.get("from") ?? "",
    periodEnd: searchParams?.get("to") ?? "",
  };
  const currentParams = Object.fromEntries(searchParams?.entries() ?? []);
  const scoped = completeScope(scope);

  const [employees, setEmployees] = useState<EmployeeChoice[]>([]);
  const [rows, setRows] = useState<AllocationRow[]>([]);
  const [reload, setReload] = useState(0);
  const [editorOpen, setEditorOpen] = useHeaderAction("new");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftScope, setDraftScope] = useState<WorkLocationScope>(scope);
  const [region, setRegion] = useState("");
  const [subregion, setSubregion] = useState("");
  const [measure, setMeasure] = useState<"days" | "share">("days");
  const [serviceDays, setServiceDays] = useState("");
  const [workShare, setWorkShare] = useState("");
  const [source, setSource] = useState<EvidenceSource>("hr_records");
  const [evidenceDocumentId, setEvidenceDocumentId] = useState("");
  const [changeReason, setChangeReason] = useState("");
  const [busy, setBusy] = useState(false);

  // A new allocation starts from the list's current scope each time the
  // header action opens the editor.
  const [wasOpen, setWasOpen] = useState(editorOpen);
  if (editorOpen !== wasOpen) {
    setWasOpen(editorOpen);
    if (editorOpen && editingId === null) setDraftScope(scope);
  }

  useEffect(() => {
    let cancelled = false;
    const requested = scoped ? scope : null;
    fetchWorkLocations(requested, t("loadFailed"))
      .then((body) => {
        if (cancelled) return;
        setEmployees(body.employees ?? []);
        setRows(requested ? (body.rows ?? []) : []);
      })
      .catch((error: unknown) => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : t("loadFailed"));
      });
    return () => {
      cancelled = true;
    };
    // The scope fields are the dependency; the object is rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.employmentId, scope.periodStart, scope.periodEnd, scoped, reload]);

  const draftEmployee = employees.find(
    (employee) => employee.employmentId === draftScope.employmentId,
  );

  function resetFields() {
    setRegion("");
    setSubregion("");
    setMeasure("days");
    setServiceDays("");
    setWorkShare("");
    setSource("hr_records");
    setEvidenceDocumentId("");
    setChangeReason("");
  }

  function close() {
    setEditorOpen(false);
    setEditingId(null);
    resetFields();
  }

  function edit(row: AllocationRow) {
    setEditingId(row.id);
    setDraftScope(scope);
    setRegion(row.region);
    setSubregion(row.subregion ?? "");
    setMeasure(row.serviceDays == null ? "share" : "days");
    setServiceDays(row.serviceDays == null ? "" : String(row.serviceDays));
    setWorkShare(row.workShare ?? "");
    setSource(row.source as EvidenceSource);
    setEvidenceDocumentId(row.evidenceDocumentId ?? "");
    setChangeReason("");
    setEditorOpen(true);
  }

  async function save() {
    setBusy(true);
    try {
      const response = await fetch("/api/payroll/work-locations", {
        method: editingId ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: editingId,
          employmentId: draftScope.employmentId,
          periodStart: draftScope.periodStart,
          periodEnd: draftScope.periodEnd,
          region: region.trim(),
          subregion: subregion.trim() || null,
          serviceDays: measure === "days" ? Number(serviceDays) : null,
          workShare: measure === "share" ? workShare : null,
          source,
          evidenceDocumentId: evidenceDocumentId.trim() || null,
          changeReason: changeReason.trim(),
        }),
      });
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t("saveFailed")));
      await response.json();
      toast.success(editingId ? t("updated") : t("recorded"));
      const saved = draftScope;
      close();
      // Show the saved allocation in its own scope.
      if (
        saved.employmentId !== scope.employmentId ||
        saved.periodStart !== scope.periodStart ||
        saved.periodEnd !== scope.periodEnd
      ) {
        const next = new URLSearchParams(searchParams?.toString() ?? "");
        next.delete("new");
        next.set("employment", saved.employmentId);
        next.set("from", saved.periodStart);
        next.set("to", saved.periodEnd);
        router.replace(`${pathname}?${next.toString()}` as never);
      } else {
        setReload((count) => count + 1);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const columns: PagedColumn<AllocationRow>[] = [
    {
      key: "region",
      header: t("columns.region"),
      cell: (row) => `${row.region}${row.subregion ? ` · ${row.subregion}` : ""}`,
      search: (row) => `${row.region} ${row.subregion ?? ""}`,
    },
    {
      key: "measure",
      header: t("columns.measure"),
      cell: (row) =>
        row.serviceDays == null
          ? t("shareValue", { share: row.workShare ?? "—" })
          : t("daysValue", { days: row.serviceDays }),
    },
    {
      key: "source",
      header: t("columns.source"),
      cell: (row) =>
        SOURCES.includes(row.source as EvidenceSource)
          ? t(`sources.${row.source as EvidenceSource}`)
          : row.source,
      search: (row) => row.source,
    },
    {
      key: "document",
      header: t("columns.document"),
      cell: (row) => row.evidenceDocumentId ?? "—",
    },
    {
      key: "reason",
      header: t("columns.reason"),
      cell: (row) => row.changeReason,
      search: (row) => row.changeReason,
    },
  ];

  const draftComplete = completeScope(draftScope);
  const invalid =
    busy ||
    !draftEmployee ||
    !draftComplete ||
    !region.trim() ||
    !changeReason.trim() ||
    (measure === "days" ? serviceDays === "" : workShare === "");

  return (
    <>
      <PagedTable
        source="payroll_work_locations"
        rows={rows}
        columns={columns}
        rowKey={(row) => row.id}
        searchable
        emptyAsRow
        pageSize={10}
        rowLabel={(row) => row.region}
        onRowClick={edit}
        empty={scoped ? t("emptyScope") : t("empty")}
        toolbarAfter={
          <>
            <ListFilterSelect
              basePath={pathname ?? "/payroll/work-locations"}
              currentParams={currentParams}
              paramKey="employment"
              label={t("filters.employment")}
              allLabel={t("fields.chooseEmployment")}
              options={employees.map((employee) => ({
                value: employee.employmentId,
                label: `${employee.employeeName} · ${employee.subsidiaryName}`,
              }))}
            />
            <DateRangeFilter
              fromLabel={t("fields.periodStart")}
              toLabel={t("fields.periodEnd")}
              clearLabel={t("filters.clearPeriod")}
            />
          </>
        }
      />
      <Drawer
        open={editorOpen}
        onClose={() => {
          if (!busy) close();
        }}
        title={editingId ? t("update") : t("record")}
        description={t("editorDescription")}
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={close}>
              {tCommon("actions.cancel")}
            </Button>
            <Button disabled={invalid} onClick={() => void save()}>
              {busy ? tCommon("actions.saving") : editingId ? t("update") : t("record")}
            </Button>
          </div>
        }
      >
        <div className="grid gap-4 md:grid-cols-2">
          {editingId ? (
            // An allocation belongs to its employment and period; an update
            // corrects the evidence, never the scope.
            <p className="text-sm text-slate-500 md:col-span-2 dark:text-slate-400">
              {draftEmployee
                ? `${draftEmployee.employeeName} · ${draftEmployee.subsidiaryName} · `
                : ""}
              {draftScope.periodStart} – {draftScope.periodEnd}
            </p>
          ) : (
            <>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="work-location-employment">{t("fields.employment")}</Label>
                <Select
                  id="work-location-employment"
                  value={draftScope.employmentId}
                  onChange={(event) =>
                    setDraftScope((current) => ({ ...current, employmentId: event.target.value }))
                  }
                >
                  <option value="">{t("fields.chooseEmployment")}</option>
                  {employees.map((employee) => (
                    <option key={employee.employmentId} value={employee.employmentId}>
                      {employee.employeeName} · {employee.subsidiaryName}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="work-location-start">{t("fields.periodStart")}</Label>
                <DateField
                  id="work-location-start"
                  value={draftScope.periodStart}
                  onChange={(value) =>
                    setDraftScope((current) => ({ ...current, periodStart: value }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="work-location-end">{t("fields.periodEnd")}</Label>
                <DateField
                  id="work-location-end"
                  value={draftScope.periodEnd}
                  onChange={(value) =>
                    setDraftScope((current) => ({ ...current, periodEnd: value }))
                  }
                />
              </div>
            </>
          )}
          <div className="space-y-2">
            <Label htmlFor="region">{t("fields.region")}</Label>
            <Input
              id="region"
              value={region}
              onChange={(event) => setRegion(event.target.value)}
              placeholder={t("fields.regionPlaceholder")}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="subregion">{t("fields.subregion")}</Label>
            <Input
              id="subregion"
              value={subregion}
              onChange={(event) => setSubregion(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="measure">{t("fields.measure")}</Label>
            <Select
              id="measure"
              value={measure}
              onChange={(event) => setMeasure(event.target.value as "days" | "share")}
            >
              <option value="days">{t("fields.serviceDays")}</option>
              <option value="share">{t("fields.wageShareOption")}</option>
            </Select>
          </div>
          {measure === "days" ? (
            <div className="space-y-2">
              <Label htmlFor="service-days">{t("fields.serviceDays")}</Label>
              <Input
                id="service-days"
                inputMode="numeric"
                value={serviceDays}
                onChange={(event) => setServiceDays(event.target.value)}
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="work-share">{t("fields.wageShare")}</Label>
              <Input
                id="work-share"
                value={workShare}
                onChange={(event) => setWorkShare(event.target.value)}
                placeholder="0.4000000000"
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="source">{t("columns.source")}</Label>
            <Select
              id="source"
              value={source}
              onChange={(event) => setSource(event.target.value as EvidenceSource)}
            >
              {SOURCES.map((value) => (
                <option key={value} value={value}>
                  {t(`sources.${value}`)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="evidence-document">{t("fields.evidenceDocument")}</Label>
            <Input
              id="evidence-document"
              value={evidenceDocumentId}
              onChange={(event) => setEvidenceDocumentId(event.target.value)}
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="change-reason">{t("columns.reason")}</Label>
            <Input
              id="change-reason"
              value={changeReason}
              onChange={(event) => setChangeReason(event.target.value)}
            />
          </div>
        </div>
      </Drawer>
    </>
  );
}
