import { randomUUID } from "node:crypto";
import { getTranslations } from "next-intl/server";
import { AutopayError, completeSetupByToken, publicSetupPage } from "@openbooks/engine/src/payments/autopay.ts";

export const dynamic = "force-dynamic";

/**
 * The provider redirects here after the customer approves the setup. The
 * token identifies the pending method; completion reads the stored method
 * off the provider and activates it. Refreshing this page is safe: an
 * already-active method reads back as saved instead of charging anything.
 */
export default async function PaySetupReturnPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await getTranslations("payments.setup");

  let saved: { brand: string | null; last4: string | null; orgName: string } | null = null;
  let refusal: string | null = null;
  try {
    const method = await completeSetupByToken(token);
    const page = await publicSetupPage(token);
    saved = { brand: method.brand, last4: method.last4, orgName: page.orgName };
  } catch (e) {
    if (e instanceof AutopayError) {
      refusal = e.message;
    } else {
      // Anonymous callers must never see engine internals: log the detail
      // against a request id and hand them the id to quote back.
      const requestId = randomUUID();
      console.error(`pay setup return failed [requestId=${requestId}]`, e);
      throw e;
    }
  }

  if (!saved) {
    return (
      <SetupCard title={t("invalidTitle")}>
        <p className="text-center text-sm text-slate-500 dark:text-slate-400">{refusal ?? t("invalidDetail")}</p>
      </SetupCard>
    );
  }
  return (
    <SetupCard title={t("savedTitle")}>
      <p className="text-center text-sm text-slate-500 dark:text-slate-400">
        {saved.brand && saved.last4
          ? t("savedDetail", { brand: saved.brand, last4: saved.last4, org: saved.orgName })
          : t("savedNoDetail", { org: saved.orgName })}
      </p>
    </SetupCard>
  );
}

function SetupCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-gradient-to-b from-white to-slate-100 p-4 dark:from-slate-950 dark:to-slate-900">
      <div className="w-full max-w-md rounded-3xl border border-slate-200/80 bg-white p-8 shadow-xl shadow-slate-900/5 dark:border-slate-800 dark:bg-slate-900 dark:shadow-black/30">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">{title}</h1>
        </div>
        {children}
      </div>
    </div>
  );
}
