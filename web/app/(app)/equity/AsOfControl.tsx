"use client";

import type { ReactNode } from "react";
import { ReportFilterBar } from "../reports/ReportFilterBar";
import type { AsOfControl } from "./view";

/**
 * The native as-of control (the balance sheet's: one date, the point-in-time
 * presets, today by default) bound to the equity URL: a preset travels as
 * `asOfPeriod`, a custom date as `asOf`. Changing it re-reads the view as of
 * the new date and closes any open drawer.
 */
export function EquityAsOfControl({
  control,
  compact = true,
  leading,
  actions,
}: {
  control: AsOfControl;
  compact?: boolean;
  /** A scenario's own inputs, on the same report-style bar before the date. */
  leading?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <ReportFilterBar
      leading={leading}
      actions={actions}
      controls={{ period: true, asOf: true }}
      defaultPeriod={control.defaultPeriod}
      periodPresets={control.periodPresets}
      periodParamKey="asOfPeriod"
      fromParamKey="asOf"
      toParamKey="asOf"
      resetParamKeys={AS_OF_RESETS}
      compact={compact}
    />
  );
}

const AS_OF_RESETS = [
  "security",
  "new",
  "newHolder",
  "newKind",
  "history",
  "model",
  "amend",
  "reserve",
  "round",
  "page",
] as const;
