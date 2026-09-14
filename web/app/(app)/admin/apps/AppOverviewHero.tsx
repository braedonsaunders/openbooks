"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Package } from "lucide-react";
import { Badge, Card, CardHeader, CardTitle, CardDescription, CardContent } from "@openbooks/ui";

/** The same overview chrome for installed apps and draft review, with either renderer. */
export function AppOverviewHero({ name, description, version, renderer, status, stats, actions }: {
  name: string;
  description: string | null;
  version: string | null;
  renderer?: "native" | "sandbox";
  status: ReactNode;
  stats: { label: string; value: number }[];
  actions?: ReactNode;
}) {
  const t = useTranslations("admin.extensions.draft");
  return <Card className="overflow-hidden border-teal-200 dark:border-teal-900">
    <CardHeader className="bg-gradient-to-br from-teal-50 via-white to-sky-50 dark:from-teal-950/50 dark:via-slate-900 dark:to-sky-950/30">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="grid h-12 w-12 place-items-center rounded-xl bg-teal-600 text-white shadow-sm"><Package size={24} aria-hidden /></span>
        {status}
      </div>
      <CardTitle className="text-2xl">{name}</CardTitle>
      {description ? <CardDescription className="max-w-prose leading-relaxed">{description}</CardDescription> : null}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        {version ? <Badge variant="outline">v{version}</Badge> : null}
        {renderer ? <span>{t(renderer === "native" ? "nativeApp" : "customApp")}</span> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2 pt-3">{actions}</div> : null}
    </CardHeader>
    <CardContent className="border-t pt-4">
      <div className="grid grid-cols-3 gap-4">
        {stats.map(item => <div key={item.label}>
          <div className="text-2xl font-semibold tabular-nums">{item.value}</div>
          <div className="text-xs text-slate-500">{item.label}</div>
        </div>)}
      </div>
    </CardContent>
  </Card>;
}
