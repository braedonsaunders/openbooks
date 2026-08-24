"use client";

import { cloneElement, isValidElement, useId } from "react";
import { Badge, Label, cn } from "@openbooks/ui";
import { HomeStatTile } from "../../../components/module-home/client";
import type { Accent } from "../../../components/cockpit/ui";

export type Option = {
  id: string;
  name: string;
  currency?: string;
  partyId?: string;
  openBalance?: string;
};

export function Metric({
  label,
  value,
  hint,
  tone,
  icon,
  accent,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "danger";
  icon: string;
  accent: Accent;
}) {
  return (
    <HomeStatTile
      label={label}
      value={value}
      sub={hint}
      icon={icon}
      accent={accent}
      tone={tone === "danger" ? "negative" : "neutral"}
    />
  );
}

export function Status({ value }: { value: string }) {
  const variant = ["active", "occupied", "invoiced", "finalized"].includes(
    value,
  )
    ? "success"
    : ["notice", "open", "scheduled"].includes(value)
      ? "warning"
      : "secondary";
  return <Badge variant={(variant)}>{value.replaceAll("_", " ")}</Badge>;
}
export function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="p-12 text-center">
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-1 text-sm text-slate-500">{detail}</div>
    </div>
  );
}

export function RecordTabs({
  label,
  active,
  tabs,
  onChange,
}: {
  label: string;
  active: string;
  tabs: Array<{ key: string; label: string }>;
  onChange: (key: string) => void;
}) {
  return (
    <nav
      className="-mb-px flex gap-1 overflow-x-auto"
      role="tablist"
      aria-label={label}
    >
      {tabs.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={active === item.key}
          onClick={() => onChange(item.key)}
          className={cn(
            "border-b-2 px-3 py-3 text-sm font-medium transition-colors",
            active === item.key
              ? "border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-300"
              : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800 dark:text-slate-400 dark:hover:border-slate-700 dark:hover:text-slate-200",
          )}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

export function Small({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function Read({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-sm">{value}</div>
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  const generatedId = useId();
  const labelable =
    isValidElement<{ id?: string }>(children) && children.type !== "div";
  const child = labelable
    ? cloneElement(children, { id: children.props.id ?? generatedId })
    : children;
  const controlId =
    labelable && isValidElement<{ id?: string }>(child)
      ? child.props.id
      : undefined;
  return (
    <div className="min-w-0 space-y-1.5">
      <Label htmlFor={controlId}>{label}</Label>
      {child}
      {hint ? <p className="text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}
