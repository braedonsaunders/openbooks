"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select } from "@openbooks/ui";
import { PagedTable, type PagedColumn } from "../../../../components/paged-table";

interface EmployeeChoice { employmentId: string; employeeName: string; subsidiaryName: string }
interface AllocationRow {
  id: string; region: string; subregion: string | null; serviceDays: number | null;
  workShare: string | null; source: string; evidenceDocumentId: string | null; changeReason: string;
}

async function fetchWorkLocations(employmentId: string, periodStart: string, periodEnd: string) {
  const params = new URLSearchParams();
  if (employmentId) params.set("employmentId", employmentId);
  if (periodStart) params.set("periodStart", periodStart);
  if (periodEnd) params.set("periodEnd", periodEnd);
  const response = await fetch(`/api/payroll/work-locations?${params}`);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `Could not load payroll work locations (${response.status})`);
  }
  return response.json() as Promise<{ employees: EmployeeChoice[]; rows?: AllocationRow[] }>;
}

const columns: PagedColumn<AllocationRow>[] = [
  { key: "region", header: "Region", cell: (row) => `${row.region}${row.subregion ? ` · ${row.subregion}` : ""}`, search: (row) => `${row.region} ${row.subregion ?? ""}` },
  { key: "measure", header: "Period input", cell: (row) => row.serviceDays == null ? `${row.workShare ?? "—"} share` : `${row.serviceDays} days` },
  { key: "source", header: "Evidence type", cell: (row) => row.source.replaceAll("_", " ") },
  { key: "document", header: "Evidence document", cell: (row) => row.evidenceDocumentId ?? "—" },
  { key: "reason", header: "Reason", cell: (row) => row.changeReason },
];

export function WorkLocationsView() {
  const [employees, setEmployees] = useState<EmployeeChoice[]>([]);
  const [rows, setRows] = useState<AllocationRow[]>([]);
  const [employmentId, setEmploymentId] = useState("");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [region, setRegion] = useState("");
  const [subregion, setSubregion] = useState("");
  const [measure, setMeasure] = useState<"days" | "share">("days");
  const [serviceDays, setServiceDays] = useState("");
  const [workShare, setWorkShare] = useState("");
  const [source, setSource] = useState<"hr_records" | "certificate" | "adequate_records">("hr_records");
  const [evidenceDocumentId, setEvidenceDocumentId] = useState("");
  const [changeReason, setChangeReason] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const body = await fetchWorkLocations(employmentId, periodStart, periodEnd);
    setEmployees(body.employees ?? []);
    setRows(body.rows ?? []);
  }, [employmentId, periodStart, periodEnd]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const body = await fetchWorkLocations(employmentId, periodStart, periodEnd);
        if (!cancelled) {
          setEmployees(body.employees ?? []);
          setRows(body.rows ?? []);
        }
      } catch (error) {
        if (!cancelled) toast.error(error instanceof Error ? error.message : "Could not load payroll work locations");
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [employmentId, periodStart, periodEnd]);

  const selectedEmployee = useMemo(() => employees.find((employee) => employee.employmentId === employmentId), [employees, employmentId]);

  async function save() {
    setBusy(true);
    try {
      const response = await fetch("/api/payroll/work-locations", {
        method: editingId ? "PATCH" : "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: editingId,
          employmentId, periodStart, periodEnd, region: region.trim(), subregion: subregion.trim() || null,
          serviceDays: measure === "days" ? Number(serviceDays) : null,
          workShare: measure === "share" ? workShare : null, source,
          evidenceDocumentId: evidenceDocumentId.trim() || null, changeReason: changeReason.trim(),
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error ?? `Could not save payroll work location (${response.status})`);
      }
      await response.json();
      toast.success(editingId ? "Payroll work location updated" : "Payroll work location recorded");
      setEditingId(null); setRegion(""); setSubregion(""); setServiceDays(""); setWorkShare(""); setEvidenceDocumentId(""); setChangeReason("");
      await refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save payroll work location");
    } finally {
      setBusy(false);
    }
  }

  function edit(row: AllocationRow) {
    setEditingId(row.id); setRegion(row.region); setSubregion(row.subregion ?? "");
    setMeasure(row.serviceDays == null ? "share" : "days");
    setServiceDays(row.serviceDays == null ? "" : String(row.serviceDays));
    setWorkShare(row.workShare ?? ""); setSource(row.source as typeof source);
    setEvidenceDocumentId(row.evidenceDocumentId ?? ""); setChangeReason("");
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle>Period work allocation</CardTitle>
          <CardDescription>Use approved time entries where they cover the period. Enter an HR allocation for untimed work, with its source and reason.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="employment">Employee and legal employer</Label>
            <Select id="employment" value={employmentId} onChange={(event) => setEmploymentId(event.target.value)}>
              <option value="">Choose employment</option>
              {employees.map((employee) => <option key={employee.employmentId} value={employee.employmentId}>{employee.employeeName} · {employee.subsidiaryName}</option>)}
            </Select>
          </div>
          <div className="space-y-2"><Label htmlFor="period-start">Period start</Label><Input id="period-start" type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} /></div>
          <div className="space-y-2"><Label htmlFor="period-end">Period end</Label><Input id="period-end" type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} /></div>
          <div className="space-y-2"><Label htmlFor="region">Region</Label><Input id="region" value={region} onChange={(event) => setRegion(event.target.value)} placeholder="State or jurisdiction code" /></div>
          <div className="space-y-2"><Label htmlFor="subregion">Subregion (optional)</Label><Input id="subregion" value={subregion} onChange={(event) => setSubregion(event.target.value)} /></div>
          <div className="space-y-2"><Label htmlFor="measure">Allocation measure</Label><Select id="measure" value={measure} onChange={(event) => setMeasure(event.target.value as "days" | "share")}><option value="days">Service days</option><option value="share">Wage share</option></Select></div>
          {measure === "days" ? <div className="space-y-2"><Label htmlFor="service-days">Service days</Label><Input id="service-days" inputMode="numeric" value={serviceDays} onChange={(event) => setServiceDays(event.target.value)} /></div> : <div className="space-y-2"><Label htmlFor="work-share">Wage share (0–1)</Label><Input id="work-share" value={workShare} onChange={(event) => setWorkShare(event.target.value)} placeholder="0.4000000000" /></div>}
          <div className="space-y-2"><Label htmlFor="source">Evidence type</Label><Select id="source" value={source} onChange={(event) => setSource(event.target.value as typeof source)}><option value="hr_records">HR records</option><option value="certificate">Certificate</option><option value="adequate_records">Adequate records</option></Select></div>
          <div className="space-y-2"><Label htmlFor="evidence-document">Evidence document ID (optional)</Label><Input id="evidence-document" value={evidenceDocumentId} onChange={(event) => setEvidenceDocumentId(event.target.value)} /></div>
          <div className="space-y-2 md:col-span-2"><Label htmlFor="change-reason">Reason</Label><Input id="change-reason" value={changeReason} onChange={(event) => setChangeReason(event.target.value)} /></div>
          <div className="flex items-end gap-2"><Button disabled={busy || !selectedEmployee || !periodStart || !periodEnd || !region.trim() || !changeReason.trim() || (measure === "days" ? serviceDays === "" : workShare === "")} onClick={() => void save()}>{busy ? "Saving…" : editingId ? "Update allocation" : "Record allocation"}</Button>{editingId ? <Button variant="outline" onClick={() => { setEditingId(null); setRegion(""); setSubregion(""); }}>Cancel edit</Button> : null}</div>
        </CardContent>
      </Card>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Recorded allocations for the selected period</h2>
        <PagedTable rows={rows} columns={columns} rowKey={(row) => row.id} searchable pageSize={10} onRowClick={edit} empty={<p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-slate-500">Choose an employee and period to review saved allocations.</p>} />
      </section>
    </div>
  );
}
