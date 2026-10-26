import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ServiceError } from "@openbooks/engine/service/errors";
import {
  publicVisitSignatureView,
  type PublicVisitSignature,
  verifyVisitSignatureToken,
} from "@openbooks/engine/service/signatures";
import { VisitSignForm } from "./VisitSignForm";

export const dynamic = "force-dynamic";

/**
 * The customer's sign-off of a service visit, authenticated by the token in
 * the link: the work done, the parts used and who did it (no prices), then
 * a drawn signature. A used, replaced or expired link explains itself.
 */
export default async function ServiceVisitSignPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!verifyVisitSignatureToken(token)) notFound();
  const t = await getTranslations("service.sign");
  let view: PublicVisitSignature | null = null;
  let refusal: { message: string; remedy: string | null } | null = null;
  try {
    view = await publicVisitSignatureView(token);
  } catch (error) {
    if (!(error instanceof ServiceError)) throw error;
    if (error.status === 404) notFound();
    refusal = { message: error.message, remedy: error.remedy ?? null };
  }
  return (
    <main className="mx-auto min-h-screen max-w-2xl bg-white px-6 py-10 dark:bg-slate-950">
      {refusal || !view ? (
        <div
          role="alert"
          className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          <p>{refusal?.message ?? t("linkInvalid")}</p>
          {refusal?.remedy ? <p className="mt-1 text-xs">{refusal.remedy}</p> : null}
        </div>
      ) : (
        <>
          <div className="mb-6">
            <p className="text-xs uppercase tracking-widest text-slate-400">
              {view.orgName} · {view.customerName}
            </p>
            <h1 className="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-100">
              {view.jobNumber} · {view.title}
            </h1>
            {view.address ? <p className="mt-1 text-sm text-slate-500">{view.address}</p> : null}
            {view.technicians.length ? (
              <p className="mt-1 text-sm text-slate-500">
                {t("technicians", { names: view.technicians.join(", ") })}
              </p>
            ) : null}
          </div>
          {view.workNotes ? (
            <section className="mb-5">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                {t("workDone")}
              </h2>
              <p className="mt-1 whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-sm text-slate-700 dark:bg-slate-900 dark:text-slate-200">
                {view.workNotes}
              </p>
            </section>
          ) : null}
          {view.parts.length ? (
            <table className="mb-5 w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-400">
                  <th className="pb-1">{t("parts")}</th>
                  <th className="pb-1 text-right">{t("quantity")}</th>
                </tr>
              </thead>
              <tbody>
                {view.parts.map((part, index) => (
                  <tr key={index} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1.5">{part.name}</td>
                    <td className="py-1.5 text-right tabular-nums">
                      {part.quantity.includes(".")
                        ? part.quantity.replace(/0+$/, "").replace(/\.$/, "")
                        : part.quantity}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <VisitSignForm token={token} />
        </>
      )}
    </main>
  );
}
