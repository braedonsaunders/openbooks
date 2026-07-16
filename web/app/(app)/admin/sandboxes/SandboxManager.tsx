"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Card, Input, Label, Select } from "@openbooks/ui";
import {
  createSandboxAction,
  deleteSandboxAction,
  promoteSandboxAction,
  refreshSandboxAction,
  resetSandboxAction,
  setScheduleAction,
} from "./actions";
import { enterOrg } from "../../../../lib/sandbox-session";

export interface SandboxRow {
  id: string;
  orgId: string;
  name: string;
  tier: string;
  masked: boolean;
  status: string;
  lastError: string | null;
  lastRefreshAt: string | null;
  refreshSchedule: string | null;
  storageRows: number;
  createdAt: string;
}

const STATUS_VARIANT: Record<string, "default" | "warning" | "destructive" | "success" | "secondary"> = {
  ready: "success",
  provisioning: "warning",
  refreshing: "warning",
  deleting: "warning",
  failed: "destructive",
};

export function SandboxManager({ sandboxes }: { sandboxes: SandboxRow[] }) {
  const [name, setName] = useState("");
  const [tier, setTier] = useState("masked");
  const [pending, start] = useTransition();

  return (
    <div className="space-y-6">
      <Card className="p-4">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">New environment</h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          A sandbox is an instant, isolated clone of production. Masked sandboxes scramble PII on copy;
          all sandboxes have email, payments, and integrations neutered automatically.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="grow">
            <Label htmlFor="sbx-name">Name</Label>
            <Input
              id="sbx-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="QA sandbox"
            />
          </div>
          <div>
            <Label htmlFor="sbx-tier">Tier</Label>
            <Select id="sbx-tier" value={tier} onChange={(e) => setTier(e.target.value)}>
              <option value="masked">Masked full copy (recommended)</option>
              <option value="full">Full copy (unmasked)</option>
              <option value="dev">Dev (customizations only)</option>
              <option value="as_of">As-of (books at a period close)</option>
            </Select>
          </div>
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                await createSandboxAction({ name, tier: tier as any });
                setName("");
              })
            }
          >
            Create sandbox
          </Button>
        </div>
      </Card>

      <div className="space-y-3">
        {sandboxes.length === 0 && (
          <p className="text-sm text-slate-500 dark:text-slate-400">No environments yet.</p>
        )}
        {sandboxes.map((s) => (
          <Card key={s.id} className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-900 dark:text-slate-100">{s.name}</span>
                  <Badge variant={STATUS_VARIANT[s.status] ?? "secondary"}>{s.status}</Badge>
                  <Badge variant="outline">{s.tier}</Badge>
                  {s.masked && <Badge variant="secondary">masked</Badge>}
                </div>
                <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  {s.storageRows.toLocaleString()} rows ·{" "}
                  {s.lastRefreshAt ? `refreshed ${new Date(s.lastRefreshAt).toLocaleString()}` : "never refreshed"}
                  {s.refreshSchedule ? ` · auto-refresh ${s.refreshSchedule}` : ""}
                </div>
                {s.lastError && (
                  <div className="mt-1 text-xs text-red-600 dark:text-red-400">{s.lastError}</div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="default"
                  size="sm"
                  disabled={s.status !== "ready"}
                  onClick={() => start(async () => void (await enterOrg(s.orgId)))}
                >
                  Enter
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending || s.status !== "ready"}
                  onClick={() => start(async () => void (await refreshSandboxAction(s.id, true)))}
                  title="Re-pull production data, keep your customizations"
                >
                  Refresh
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending || s.status !== "ready"}
                  onClick={() =>
                    start(async () => {
                      if (confirm("Full reset discards sandbox customizations. Continue?"))
                        await resetSandboxAction(s.id);
                    })
                  }
                >
                  Reset
                </Button>
                <PromoteButton sandboxId={s.id} disabled={pending || s.status !== "ready"} />
                <Select
                  aria-label="Auto-refresh"
                  className="h-8 w-28"
                  value={s.refreshSchedule ?? ""}
                  onChange={(e) => start(async () => void (await setScheduleAction(s.id, e.target.value || null)))}
                >
                  <option value="">Manual</option>
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </Select>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      if (confirm(`Delete "${s.name}" permanently?`)) await deleteSandboxAction(s.id);
                    })
                  }
                >
                  Delete
                </Button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function PromoteButton({ sandboxId, disabled }: { sandboxId: string; disabled: boolean }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="secondary"
        size="sm"
        disabled={disabled || pending}
        onClick={() =>
          start(async () => {
            const name = prompt("Change set name", "Sandbox changes");
            if (!name) return;
            const r = await promoteSandboxAction(sandboxId, name);
            setMsg(`${r.itemCount} change(s) captured`);
          })
        }
        title="Capture the sandbox's customization changes as a reviewable change set"
      >
        Promote
      </Button>
      {msg && <span className="text-xs text-slate-500 dark:text-slate-400">{msg}</span>}
    </div>
  );
}
