"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Input, Label } from "@openbooks/ui";
import { fromUnits, toUnits } from "@openbooks/engine/money/money";
import { useMoney } from "../money-provider";

export type CountRow = { value: string; count: number };

function safeUnits(value: string): bigint | null {
  try {
    return toUnits(value);
  } catch {
    return null;
  }
}

/**
 * Drawer count by denomination. With the register's denominations the
 * cashier enters how many of each note and coin; without them, one total.
 * The count is blind: it never shows what the drawer is expected to hold.
 */
export function CountForm(props: {
  currency: string;
  denominations: string[];
  submitLabel: string;
  busy: boolean;
  onSubmit: (rows: CountRow[]) => void;
  children?: React.ReactNode;
}) {
  const t = useTranslations("pos");
  const { money } = useMoney(props.currency);
  const ordered = useMemo(
    () =>
      [...props.denominations].sort((a, b) => {
        const left = safeUnits(a) ?? 0n;
        const right = safeUnits(b) ?? 0n;
        return left === right ? 0 : left < right ? 1 : -1;
      }),
    [props.denominations],
  );
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [total, setTotal] = useState("");
  const byDenomination = ordered.length > 0;
  const rows: CountRow[] = byDenomination
    ? ordered.map((value) => ({ value, count: Number.parseInt(counts[value] ?? "0", 10) || 0 }))
    : [{ value: total.trim() === "" ? "0" : total.trim(), count: 1 }];
  const invalid = byDenomination
    ? ordered.some(
        (value) =>
          counts[value] !== undefined && counts[value] !== "" && !/^\d{1,6}$/.test(counts[value]!),
      )
    : total.trim() !== "" && safeUnits(total.trim()) === null;
  const totalUnits = byDenomination
    ? rows.reduce((sum, row) => sum + (safeUnits(row.value) ?? 0n) * BigInt(row.count), 0n)
    : (safeUnits(total.trim() === "" ? "0" : total.trim()) ?? 0n);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!invalid) props.onSubmit(byDenomination ? rows.filter((row) => row.count > 0) : rows);
      }}
    >
      {byDenomination ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {ordered.map((value) => (
            <div key={value} className="space-y-1">
              <Label htmlFor={`count-${value}`}>{money(value)}</Label>
              <Input
                id={`count-${value}`}
                inputMode="numeric"
                className="h-12 text-lg"
                value={counts[value] ?? ""}
                placeholder="0"
                onChange={(event) =>
                  setCounts((current) => ({ ...current, [value]: event.target.value }))
                }
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-1">
          <Label htmlFor="count-total">{t("count.total")}</Label>
          <Input
            id="count-total"
            inputMode="decimal"
            className="h-12 text-lg"
            value={total}
            onChange={(event) => setTotal(event.target.value)}
          />
        </div>
      )}
      {props.children}
      <div className="flex items-center justify-between gap-3 border-t border-slate-200 pt-3 dark:border-slate-800">
        <span className="text-sm text-slate-600 dark:text-slate-400">
          {t("count.counted")}{" "}
          <strong className="text-lg text-slate-900 dark:text-slate-100">
            {money(fromUnits(totalUnits))}
          </strong>
        </span>
        <Button type="submit" size="lg" disabled={props.busy || invalid}>
          {props.submitLabel}
        </Button>
      </div>
      {invalid ? <p className="text-sm text-red-600">{t("count.invalid")}</p> : null}
    </form>
  );
}
