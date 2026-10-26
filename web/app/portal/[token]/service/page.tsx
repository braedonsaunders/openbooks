import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { sql } from "drizzle-orm";
import { db, withOrgContext } from "@openbooks/engine/platform/database";
import { listPortalServiceRequests } from "@openbooks/engine/service/requests";
import { portalPage } from "@/lib/portal/pages";
import { isFeatureEnabled } from "@/lib/features";
import { PortalEmpty, PortalSection, PortalShell } from "@/components/portal/portal-shell";
import { ServiceRequestForm } from "@/components/portal/service-request-form";

export const runtime = "nodejs";

/** The customer's service requests and the form to ask for more work. */
export default async function PortalServicePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const { home, orgId, partyId } = await portalPage(token, "serviceRequests");
  const loaded = await withOrgContext(orgId, async () => {
    if (!(await isFeatureEnabled(orgId, "serviceDispatch"))) return null;
    const [requests, addresses] = await Promise.all([
      listPortalServiceRequests(orgId, partyId),
      db.execute<{ value: string; label: string }>(
        sql`select id as value,
          coalesce(nullif(btrim(label), ''), nullif(concat_ws(', ', line1, city, region), ''), '—') as label
        from addresses where org_id = ${orgId} and party_id = ${partyId} order by is_default_shipping desc, label nulls last, id`,
        "objects",
      ),
    ]);
    return { requests, addresses };
  });
  if (!loaded) notFound();
  const t = await getTranslations("service.portal");
  const locale = await getLocale();
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  return (
    <PortalShell orgName={home.settings.portalName} title={t("title")}>
      <a href={`/portal/${token}`} className="text-sm font-medium text-teal-700 hover:underline">
        ← {t("back")}
      </a>
      <div className="mt-4 space-y-6">
        <PortalSection title={t("newTitle")}>
          <ServiceRequestForm sessionToken={token} addresses={loaded.addresses} />
        </PortalSection>
        <PortalSection title={t("listTitle")}>
          {loaded.requests.length === 0 ? (
            <PortalEmpty>{t("empty")}</PortalEmpty>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-700">
              {loaded.requests.map((request) => (
                <li
                  key={request.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-3"
                >
                  <div>
                    <p className="font-medium text-slate-900 dark:text-white">{request.title}</p>
                    <p className="text-sm text-slate-500">
                      {request.requestNumber} · {date.format(new Date(request.createdAt))}
                      {request.nextVisitAt
                        ? ` · ${t("nextVisit", { when: dateTime.format(new Date(request.nextVisitAt)) })}`
                        : ""}
                    </p>
                  </div>
                  <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                    {t(
                      `status.${request.jobStatus === "completed" ? "completed" : request.status}`,
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </PortalSection>
      </div>
    </PortalShell>
  );
}
