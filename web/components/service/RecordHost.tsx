"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { DrawerNavigateContext } from "@openbooks/ui";
import { isUuid } from "@openbooks/engine/platform/identifiers";
import type {
  ServiceAgreementDetail,
  ServiceJobDetail,
  ServiceRequestDetail,
  ServiceVisitDetail,
} from "@openbooks/engine/service/reads";
import { AsyncUrlDrawer } from "../async-url-drawer";
import { ServiceAgreementBody } from "./AgreementDrawer";
import { ServiceCreateForm, type CreateKind } from "./CreateForms";
import { ServiceJobBody } from "./JobDrawer";
import { ServiceRequestBody } from "./RequestDrawer";
import { ServiceVisitBody } from "./VisitDrawer";
import { useServiceRecord } from "./use-record";

const PARAMS = ["visit", "job", "request", "agreement"] as const;
type Param = (typeof PARAMS)[number];
const NEW_KINDS: readonly CreateKind[] = ["request", "job", "agreement"];

/**
 * The service area's record host: one drawer shell for whichever service
 * record the address names (`?request=`, `?job=`, `?visit=`, `?agreement=`)
 * or the create form (`?new=request|job|agreement`). The shell stays
 * mounted through loading, refusal and retry; records link to each other by
 * replacing the parameter, so the list underneath keeps its filters.
 */
export function ServiceRecordHost() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations("service");
  const selected = PARAMS.find((param) => params.get(param)) ?? null;
  const id = selected ? params.get(selected) : null;
  const newKind = params.get("new") as CreateKind | null;
  const creating = !selected && newKind && NEW_KINDS.includes(newKind) ? newKind : null;

  const hrefWith = (param: Param | "new" | null, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    for (const key of [...PARAMS, "new"]) next.delete(key);
    if (param && value) next.set(param, value);
    const query = next.toString();
    return query ? `${pathname}?${query}` : pathname;
  };
  const open = (param: Param, value: string) =>
    window.history.pushState(null, "", hrefWith(param, value));
  const closeHref = hrefWith(null, null);

  const url = selected && id && isUuid(id) ? `/api/service/${selected}s/${id}` : null;
  const record = useServiceRecord<
    ServiceRequestDetail | ServiceJobDetail | ServiceVisitDetail | ServiceAgreementDetail
  >(url, t("loadFailed"));
  const reload = () => {
    record.reload();
    router.refresh();
  };

  if (creating) {
    return (
      <AsyncUrlDrawer
        open
        openKey={`new-${creating}`}
        closeHref={closeHref}
        size="lg"
        title={t(`create.${creating}`)}
        pending={false}
      >
        <ServiceCreateForm
          kind={creating}
          onCreated={(created) => {
            window.history.replaceState(null, "", hrefWith(creating, created));
            router.refresh();
          }}
        />
      </AsyncUrlDrawer>
    );
  }
  if (!selected || !id) return null;
  const data = record.data;
  const title = !data
    ? t(`titles.${selected}`)
    : selected === "request"
      ? (data as ServiceRequestDetail).request.requestNumber
      : selected === "job"
        ? (data as ServiceJobDetail).job.jobNumber
        : selected === "agreement"
          ? (data as ServiceAgreementDetail).agreement.agreementNumber
          : `${(data as ServiceVisitDetail).parent.number} · ${t("visit.sequence", { sequence: (data as ServiceVisitDetail).visit.sequence })}`;
  const description = !data
    ? undefined
    : selected === "request"
      ? (data as ServiceRequestDetail).request.title
      : selected === "job"
        ? (data as ServiceJobDetail).job.title
        : selected === "agreement"
          ? (data as ServiceAgreementDetail).agreement.title
          : (data as ServiceVisitDetail).parent.title;

  return (
    <DrawerNavigateContext.Provider value={(href) => window.history.pushState(null, "", href)}>
      <AsyncUrlDrawer
        open
        openKey={`${selected}-${id}`}
        closeHref={closeHref}
        size="lg"
        title={title}
        description={description}
        pending={record.pending}
        error={record.error ?? (isUuid(id) ? null : t("loadFailed"))}
        onRetry={record.reload}
      >
        {data && selected === "request" ? (
          <ServiceRequestBody
            detail={data as ServiceRequestDetail}
            reload={reload}
            onOpenVisit={(value) => open("visit", value)}
            onOpenJob={(value) => open("job", value)}
          />
        ) : null}
        {data && selected === "job" ? (
          <ServiceJobBody
            detail={data as ServiceJobDetail}
            reload={reload}
            onOpenVisit={(value) => open("visit", value)}
          />
        ) : null}
        {data && selected === "visit" ? (
          <ServiceVisitBody detail={data as ServiceVisitDetail} reload={reload} />
        ) : null}
        {data && selected === "agreement" ? (
          <ServiceAgreementBody
            detail={data as ServiceAgreementDetail}
            reload={reload}
            onOpenVisit={(value) => open("visit", value)}
            onOpenJob={(value) => open("job", value)}
          />
        ) : null}
      </AsyncUrlDrawer>
    </DrawerNavigateContext.Provider>
  );
}
