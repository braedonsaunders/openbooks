"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Settings2 } from "lucide-react";
import { Button } from "@openbooks/ui";
import type { ServiceHomeSummary } from "@openbooks/engine/service/reads";

export type ServiceHomeProps = {
  summary: ServiceHomeSummary;
  canConfigure: boolean;
};

/**
 * A missing policy needs an actionable, permission-aware remedy on the
 * Service home. The rest of the home is composed from shared cockpit widgets.
 */
export function ServiceHome({ summary, canConfigure }: ServiceHomeProps) {
  const t = useTranslations("service.home");
  if (summary.policyConfigured) return null;
  return (
    <div
      role="status"
      className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <p className="font-medium">{t("policyMissing")}</p>
      <p className="mt-1">{t("policyMissingRemedy")}</p>
      {canConfigure ? (
        <Button asChild size="sm" variant="outline" className="mt-2">
          <Link href="/admin/setup/service-dispatch-policies">
            <Settings2 className="mr-1 h-4 w-4" />
            {t("openPolicy")}
          </Link>
        </Button>
      ) : null}
    </div>
  );
}
