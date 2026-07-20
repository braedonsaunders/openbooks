"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Drawer } from "@openbooks/ui";
import { ListOrdered, ArrowUpRight } from "lucide-react";
import { Panel } from "../../analytics/_ui/Panel";

/**
 * How collections are predicted — the AR side of the forecast model, read-only
 * because collections have no capacity scheduler (there is nothing to cap:
 * customers pay when they pay; the engine predicts when). The editable
 * forecast surfaces live in their homes: recurring flows on the Cash cockpit,
 * the AP pay rule on the AP cockpit.
 */
export function ArCollectionsInfoDrawer({
  onClose,
  title,
  description,
  dso,
}: {
  onClose: () => void;
  title: string;
  description: string;
  dso: number;
}) {
  const t = useTranslations("ar.cockpit.model");
  const items: { label: string; value: string; note: string }[] = [
    {
      label: t("worklistOrder.label"),
      value: t("worklistOrder.value"),
      note: t("worklistOrder.note"),
    },
    {
      label: t("prediction.label"),
      value: t("prediction.value"),
      note: t("prediction.note"),
    },
    {
      label: t("overduePush.label"),
      value: t("overduePush.value"),
      note: t("overduePush.note"),
    },
    {
      label: t("businessDay.label"),
      value: t("businessDay.value"),
      note: t("businessDay.note"),
    },
    {
      label: t("dso.label"),
      value: t("dso.value", { dso }),
      note: t("dso.note"),
    },
  ];

  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={title}
      description={description}
      bodyClassName="overflow-y-auto"
    >
      <div className="space-y-5">
        <Panel title={t("title")} icon={ListOrdered} bodyClassName="p-0">
          <ul className="divide-y divide-slate-50 dark:divide-slate-800/60">
            {items.map((i) => (
              <li
                key={i.label}
                className="flex items-start justify-between gap-4 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                    {i.label}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {i.note}
                  </p>
                </div>
                <span className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-right text-sm font-semibold tabular-nums text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                  {i.value}
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <p className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
          {t.rich("recurring", {
            cashCockpit: (chunks) => (
              <Link
                href="/banking/cash"
                className="inline-flex items-center gap-0.5 font-medium text-teal-600 hover:underline dark:text-teal-400"
              >
                {chunks} <ArrowUpRight size={12} />
              </Link>
            ),
          })}
        </p>
        <Link
          href="/docs/sales-workflow"
          className="inline-flex items-center gap-1 text-sm font-medium text-teal-600 hover:underline dark:text-teal-400"
        >
          {t("documentation")} <ArrowUpRight size={14} />
        </Link>
      </div>
    </Drawer>
  );
}
