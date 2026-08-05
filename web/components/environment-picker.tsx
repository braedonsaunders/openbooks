"use client";

// The workspace switcher body — rendered inside the account menu. Lists every
// production tenant the login can reach, each with its sandboxes, and switches
// the active workspace via the enterOrg server action. Kept trigger-less so it
// composes into the existing account Popover rather than eating menu space.

import { useTransition } from "react";
import Link from "next/link";
import { Check, FlaskConical, Layers, Settings2, Sparkles } from "lucide-react";
import { Badge, cn } from "@openbooks/ui";
import { enterOrg } from "../lib/sandbox-session";
import type { WorkspaceEnvironments } from "../lib/environments";

export function EnvironmentPicker({
  env,
  onNavigate,
  hideHeading = false,
}: {
  env: WorkspaceEnvironments;
  onNavigate?: () => void;
  /** Hide the built-in "Workspace" label (e.g. when a parent already titles the view). */
  hideHeading?: boolean;
}) {
  const [pending, start] = useTransition();
  const multi = env.tenants.length > 1;

  const go = (orgId: string) =>
    start(async () => {
      try {
        await enterOrg(orgId);
      } finally {
        onNavigate?.();
      }
    });

  return (
    <div>
      {!hideHeading && (
        <div className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">
          Workspace
        </div>
      )}
      <div className="max-h-72 overflow-y-auto px-1 pb-1">
        {env.tenants.map((t) => {
          const topLevelActive = env.currentOrgId === t.productionOrgId;
          const isPreview = t.envKind === "preview";
          return (
            <div key={t.productionOrgId} className="mb-0.5">
              {multi && (
                <div className="px-3 pt-1.5 pb-0.5 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                  {t.productionOrgName}
                </div>
              )}
              <Row
                icon={isPreview ? <Sparkles size={15} className="text-teal-500" /> : <Layers size={15} />}
                label={multi && !isPreview ? "Production" : t.productionOrgName}
                hint={isPreview ? "Sample company" : multi ? undefined : "Production"}
                active={topLevelActive}
                disabled={pending}
                onClick={() => go(t.productionOrgId)}
              />
              {t.sandboxes.map((s) => (
                <Row
                  key={s.orgId}
                  icon={<FlaskConical size={15} className="text-amber-500" />}
                  label={s.name}
                  tier={s.tier}
                  status={s.status}
                  active={env.envKind !== "production" && env.currentOrgId === s.orgId}
                  disabled={pending || s.status !== "ready"}
                  onClick={() => go(s.orgId)}
                />
              ))}
            </div>
          );
        })}
      </div>
      {env.canManage && (
        <div className="border-t border-slate-100 p-1 dark:border-slate-800">
          <Link
            href="/admin/sandboxes"
            onClick={onNavigate}
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800/60"
          >
            <Settings2 size={15} className="text-slate-500 dark:text-slate-400" />
            Manage environments
          </Link>
        </div>
      )}
    </div>
  );
}

function Row({
  icon,
  label,
  hint,
  tier,
  status,
  active,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  tier?: string;
  status?: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-slate-200 dark:hover:bg-slate-800/60"
    >
      <Check
        size={14}
        className={cn("shrink-0", active ? "text-teal-600 dark:text-teal-400" : "text-transparent")}
      />
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{label}</span>
        {hint && <span className="truncate text-[11px] text-slate-400 dark:text-slate-500">{hint}</span>}
      </span>
      {tier && (
        <Badge variant="outline" className="shrink-0 text-[10px]">
          {tier}
        </Badge>
      )}
      {status && status !== "ready" && (
        <Badge variant="warning" className="shrink-0 text-[10px]">
          {status}
        </Badge>
      )}
    </button>
  );
}
