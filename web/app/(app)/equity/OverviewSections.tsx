"use client";

import Link from "next/link";
import { useLocale } from "next-intl";
import { Donut } from "../analytics/_ui/charts";
import { toChartNumber } from "@/lib/chart-number";
import { normalizeDecimal, roundMoney } from "@openbooks/engine/money";
import { formatExactPercent } from "@/lib/format";

/**
 * The overview's ownership hero: the fully diluted capitalization by class,
 * awards and the unallocated pool, each slice in its stable equity colour
 * (web/lib/equity-colors.ts), the same colour the waterfall charts use.
 */
export function EquityOwnership({
  slices,
  empty,
}: {
  slices: { key: string; label: string; shares: string; percent: string; color: string }[];
  empty: string;
}) {
  const locale = useLocale();
  const count = (value: string) => new Intl.NumberFormat(locale).format(BigInt(value));
  if (slices.length === 0)
    return (
      <p className="px-2 py-10 text-center text-sm text-slate-400 dark:text-slate-500">{empty}</p>
    );
  const colors = slices.map((slice) => slice.color);
  return (
    <div className="grid grid-cols-1 items-center gap-4 md:grid-cols-5">
      <div className="md:col-span-2">
        <Donut
          compact
          height={190}
          colors={colors}
          valueFormat={(value) => new Intl.NumberFormat(locale).format(value)}
          data={slices.map((slice) => ({ name: slice.label, value: toChartNumber(slice.shares) }))}
        />
      </div>
      <ul className="divide-y divide-slate-100 md:col-span-3 dark:divide-slate-800">
        {slices.map((slice, index) => (
          <li key={slice.key} className="flex items-center gap-3 py-2 text-sm">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: colors[index] }}
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200">
              {slice.label}
            </span>
            <span className="whitespace-nowrap tabular-nums text-slate-500 dark:text-slate-400">
              {count(slice.shares)}
            </span>
            <span className="w-16 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-100">
              {formatExactPercent(normalizeDecimal(roundMoney(slice.percent, 1), 1), locale, 1)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The latest recorded equity activity, newest first, each line opening its security. */
export function EquityActivityList({
  items,
  empty,
}: {
  items: { key: string; date: string; text: string; href: string | null }[];
  empty: string;
}) {
  if (items.length === 0)
    return (
      <p className="px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">{empty}</p>
    );
  return (
    <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
      {items.map((item) => {
        const body = (
          <>
            <span className="w-24 shrink-0 text-xs whitespace-nowrap tabular-nums text-slate-400 dark:text-slate-500">
              {item.date}
            </span>
            <span className="min-w-0 flex-1 text-slate-700 dark:text-slate-300">{item.text}</span>
          </>
        );
        return (
          <li key={item.key}>
            {item.href ? (
              <Link
                href={item.href as never}
                className="flex items-baseline gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
              >
                {body}
              </Link>
            ) : (
              <div className="flex items-baseline gap-3 px-4 py-2.5 text-sm">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
