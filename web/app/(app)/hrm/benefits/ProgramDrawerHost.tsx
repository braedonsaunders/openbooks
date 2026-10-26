"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { DrawerNavigateContext } from "@openbooks/ui";
import { AsyncServerDrawer } from "../../../../components/async-server-drawer";
import { isListDrawerHrefChange } from "../../../../lib/list/drawer-routes";
import {
  benefitsProgramCloseHref,
  isBenefitsProgramDrawerSelection,
} from "../../../../lib/hrm/benefits-drawer-route";
import { loadBenefitProgramDrawer } from "./program-drawer-action";

/** Program-only history changes keep the catalog, its paging and scroll mounted. */
export function ProgramDrawerHost({ refreshKey }: { refreshKey: string }) {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations("common");
  const query = params.toString();
  const id =
    pathname === "/hrm/benefits" && isBenefitsProgramDrawerSelection(new URLSearchParams(query))
      ? params.get("program")
      : null;
  const [retry, setRetry] = useState(0);
  const requestKey = `${refreshKey}:${retry}:${query}`;
  const [resource, setResource] = useState<{
    key: string;
    query: string;
    content?: ReactNode;
    error?: string;
  } | null>(null);
  if (!id && resource) setResource(null);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    loadBenefitProgramDrawer(query)
      .then((result) => {
        if (!cancelled) {
          setResource({ key: requestKey, query, ...result });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResource({ key: requestKey, query, error: t("feedback.loadFailed") });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, query, requestKey, t]);
  if (!id) return null;
  const current =
    resource?.key === requestKey ||
    (resource?.query === query && resource.content && !resource.error)
      ? resource
      : null;
  return (
    <DrawerNavigateContext.Provider
      value={(href) => {
        if (isListDrawerHrefChange(window.location.href, href))
          window.history.pushState(null, "", href);
        else router.push(href as never);
      }}
    >
      <AsyncServerDrawer
        resourceKey={`${retry}:${query}`}
        open
        openKey={id}
        title={t("feedback.loading")}
        closeHref={benefitsProgramCloseHref(new URLSearchParams(query))}
        pending={!current}
        error={current?.error}
        onRetry={() => setRetry((value) => value + 1)}
      >
        {current?.content}
      </AsyncServerDrawer>
    </DrawerNavigateContext.Provider>
  );
}
