"use client";

import { useEffect, useState } from "react";
import { Badge, Button, Card, Input, Label, Select } from "@openbooks/ui";

interface Schedule {
  id: string;
  name: string;
  cadence: string;
  cron: string | null;
  nextRunOn: string;
  endsOn: string | null;
  autoPost: boolean;
  isActive: boolean;
  runCount: number;
  lastError: string | null;
  templateNumber: string;
  templateKind: string;
  partyName: string | null;
}

interface Stage {
  sequence: number;
  name: string;
  offsetDays: number;
  subjectTemplate: string;
  bodyTemplate: string;
  escalate?: boolean;
}
interface Policy {
  id: string;
  name: string;
  appliesToKind: string;
  gracePeriodDays: number;
  minBalance: string;
  isActive: boolean;
  stages: Stage[];
}

const CADENCES = ["weekly", "biweekly", "monthly", "quarterly", "annually", "custom_cron"];

export function CollectionsClient() {
  const [tab, setTab] = useState<"recurring" | "dunning">("recurring");
  return (
    <div className="mt-6">
      <div className="mb-4 flex gap-2">
        <Button variant={tab === "recurring" ? "default" : "ghost"} onClick={() => setTab("recurring")}>
          Recurring invoices
        </Button>
        <Button variant={tab === "dunning" ? "default" : "ghost"} onClick={() => setTab("dunning")}>
          Dunning ladders
        </Button>
      </div>
      {tab === "recurring" ? <RecurringPanel /> : <DunningPanel />}
    </div>
  );
}

function RecurringPanel() {
  const [rows, setRows] = useState<Schedule[]>([]);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ templateDocumentNumber: "", cadence: "monthly", cron: "", nextRunOn: "", autoPost: false });
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const r = await fetch("/api/recurring");
    if (r.ok) setRows((await r.json()).schedules ?? []);
  };
  useEffect(() => { void load(); }, []);

  const create = async () => {
    setError(null);
    setBusy(true);
    const r = await fetch("/api/recurring", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        templateDocumentNumber: form.templateDocumentNumber,
        cadence: form.cadence,
        cron: form.cadence === "custom_cron" ? form.cron : null,
        nextRunOn: form.nextRunOn || undefined,
        autoPost: form.autoPost,
      }),
    });
    setBusy(false);
    if (!r.ok) { setError((await r.json().catch(() => ({}))).error ?? "Could not create"); return; }
    setForm({ templateDocumentNumber: "", cadence: "monthly", cron: "", nextRunOn: "", autoPost: false });
    void load();
  };

  const act = async (id: string, method: "PATCH" | "DELETE" | "POST", body?: unknown) => {
    await fetch(`/api/recurring/${id}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    void load();
  };

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold">New recurring schedule</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <Label>Template document #</Label>
            <Input
              placeholder="INV-000123"
              value={form.templateDocumentNumber}
              onChange={(e) => setForm({ ...form, templateDocumentNumber: e.target.value })}
            />
          </div>
          <div>
            <Label>Cadence</Label>
            <Select value={form.cadence} onChange={(e) => setForm({ ...form, cadence: e.target.value })}>
              {CADENCES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </div>
          {form.cadence === "custom_cron" && (
            <div>
              <Label>Cron</Label>
              <Input placeholder="0 9 1 * *" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} />
            </div>
          )}
          <div>
            <Label>First run</Label>
            <Input type="date" value={form.nextRunOn} onChange={(e) => setForm({ ...form, nextRunOn: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 self-end text-sm">
            <input type="checkbox" checked={form.autoPost} onChange={(e) => setForm({ ...form, autoPost: e.target.checked })} />
            Auto-post generated documents
          </label>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-3">
          <Button onClick={create} disabled={busy || !form.templateDocumentNumber}>Create schedule</Button>
        </div>
      </Card>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-2">Template</th><th>Customer</th><th>Cadence</th><th>Next run</th>
              <th>Runs</th><th>Auto-post</th><th>Status</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="border-t">
                <td className="py-2 font-medium">{s.templateNumber}</td>
                <td>{s.partyName ?? "—"}</td>
                <td>{s.cadence}{s.cron ? ` (${s.cron})` : ""}</td>
                <td>{s.nextRunOn}</td>
                <td>{s.runCount}{s.lastError ? <span className="ml-1 text-red-600" title={s.lastError}>⚠</span> : null}</td>
                <td>{s.autoPost ? "Yes" : "No"}</td>
                <td>{s.isActive ? <Badge>Active</Badge> : <Badge variant="secondary">Paused</Badge>}</td>
                <td className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" onClick={() => act(s.id, "POST")}>Run now</Button>
                  <Button size="sm" variant="ghost" onClick={() => act(s.id, "PATCH", { isActive: !s.isActive })}>
                    {s.isActive ? "Pause" : "Resume"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => act(s.id, "DELETE")}>Delete</Button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="py-6 text-center text-muted-foreground">No recurring schedules yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const BLANK_STAGE: Stage = {
  sequence: 1,
  name: "First reminder",
  offsetDays: 7,
  subjectTemplate: "Invoice {{invoice}} is past due",
  bodyTemplate: "Hi {{party}},\n\nInvoice {{invoice}} for {{amount}} was due {{dueDate}} ({{daysOverdue}} days ago). Please arrange payment.\n\n{{orgName}}",
  escalate: false,
};

function DunningPanel() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [draft, setDraft] = useState<{ name: string; gracePeriodDays: number; stages: Stage[] }>({
    name: "", gracePeriodDays: 0, stages: [BLANK_STAGE],
  });
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const r = await fetch("/api/dunning");
    if (r.ok) setPolicies((await r.json()).policies ?? []);
  };
  useEffect(() => { void load(); }, []);

  const create = async () => {
    setError(null);
    const r = await fetch("/api/dunning", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (!r.ok) { setError((await r.json().catch(() => ({}))).error ?? "Could not create"); return; }
    setDraft({ name: "", gracePeriodDays: 0, stages: [BLANK_STAGE] });
    void load();
  };

  const remove = async (id: string) => { await fetch(`/api/dunning/${id}`, { method: "DELETE" }); void load(); };

  const setStage = (i: number, patch: Partial<Stage>) =>
    setDraft({ ...draft, stages: draft.stages.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <h3 className="mb-3 text-sm font-semibold">New dunning policy</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Policy name</Label>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Standard net-30 collections" />
          </div>
          <div>
            <Label>Grace period (days past due)</Label>
            <Input type="number" value={draft.gracePeriodDays} onChange={(e) => setDraft({ ...draft, gracePeriodDays: Number(e.target.value) })} />
          </div>
        </div>
        <div className="mt-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Reminder ladder</span>
            <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, stages: [...draft.stages, { ...BLANK_STAGE, sequence: draft.stages.length + 1, name: `Reminder ${draft.stages.length + 1}`, offsetDays: (draft.stages.at(-1)?.offsetDays ?? 0) + 14 }] })}>
              + Add stage
            </Button>
          </div>
          {draft.stages.map((s, i) => (
            <div key={i} className="rounded border p-3">
              <div className="grid gap-2 sm:grid-cols-3">
                <div><Label>Name</Label><Input value={s.name} onChange={(e) => setStage(i, { name: e.target.value })} /></div>
                <div><Label>Days past due</Label><Input type="number" value={s.offsetDays} onChange={(e) => setStage(i, { offsetDays: Number(e.target.value) })} /></div>
                <div><Label>Sequence</Label><Input type="number" value={s.sequence} onChange={(e) => setStage(i, { sequence: Number(e.target.value) })} /></div>
              </div>
              <div className="mt-2"><Label>Subject</Label><Input value={s.subjectTemplate} onChange={(e) => setStage(i, { subjectTemplate: e.target.value })} /></div>
              <div className="mt-2">
                <Label>Body</Label>
                <textarea className="w-full rounded border px-2 py-1 text-sm" rows={4} value={s.bodyTemplate} onChange={(e) => setStage(i, { bodyTemplate: e.target.value })} />
              </div>
              {draft.stages.length > 1 && (
                <Button size="sm" variant="ghost" className="mt-2" onClick={() => setDraft({ ...draft, stages: draft.stages.filter((_, j) => j !== i) })}>Remove stage</Button>
              )}
            </div>
          ))}
          <p className="text-xs text-muted-foreground">Tokens: {"{{party}} {{invoice}} {{amount}} {{dueDate}} {{daysOverdue}} {{orgName}}"}</p>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-3"><Button onClick={create} disabled={!draft.name}>Create policy</Button></div>
      </Card>

      <div className="space-y-3">
        {policies.map((p) => (
          <Card key={p.id} className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium">{p.name}</span>
                <span className="ml-2 text-sm text-muted-foreground">
                  {p.stages.length} stage{p.stages.length === 1 ? "" : "s"} · grace {p.gracePeriodDays}d
                </span>
              </div>
              <div className="flex items-center gap-2">
                {p.isActive ? <Badge>Active</Badge> : <Badge variant="secondary">Off</Badge>}
                <Button size="sm" variant="ghost" onClick={() => remove(p.id)}>Delete</Button>
              </div>
            </div>
            <ul className="mt-2 text-sm text-muted-foreground">
              {[...p.stages].sort((a, b) => a.sequence - b.sequence).map((s) => (
                <li key={s.sequence}>· Day {s.offsetDays}: {s.name}</li>
              ))}
            </ul>
          </Card>
        ))}
        {policies.length === 0 && <p className="text-center text-muted-foreground">No dunning policies yet.</p>}
      </div>
    </div>
  );
}
