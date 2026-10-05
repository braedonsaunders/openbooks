import { getTranslations } from "next-intl/server";
import { AutopayError, publicSetupPage } from "@openbooks/engine/src/payments/autopay.ts";
import { SetupContinueButton } from "./SetupContinueButton";
import { setupProviderLabel } from "./provider-label";

export const dynamic = "force-dynamic";

/**
 * Hosted setup flow: the customer-facing half of "Send setup link". The token
 * in the URL is the credential; no session is required. A pending link shows
 * what will be saved and continues to the provider; anything else names its
 * state and the remedy (a fresh link from the sender).
 */
export default async function PaySetupPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await getTranslations("payments.setup");

  let view: Awaited<ReturnType<typeof publicSetupPage>> | null = null;
  let unknownToken = false;
  try {
    view = await publicSetupPage(token);
  } catch (e) {
    if (e instanceof AutopayError) {
      unknownToken = true;
    } else {
      throw e;
    }
  }

  if (!view || unknownToken) {
    return (
      <SetupShell title={t("invalidTitle")}>
        <p className="text-center text-sm text-slate-500 dark:text-slate-400">{t("invalidDetail")}</p>
      </SetupShell>
    );
  }
  const provider = setupProviderLabel(view.provider);

  if (view.status === "active") {
    return (
      <SetupShell title={t("alreadySaved")}>
        <p className="text-center text-sm text-slate-500 dark:text-slate-400">
          {view.brand && view.last4
            ? t("alreadySavedDetail", { brand: view.brand, last4: view.last4 })
            : t("alreadySavedNoDetail")}
        </p>
      </SetupShell>
    );
  }
  if (view.status !== "pending") {
    return (
      <SetupShell title={t("withdrawnTitle")}>
        <p className="text-center text-sm text-slate-500 dark:text-slate-400">{t("withdrawnDetail")}</p>
      </SetupShell>
    );
  }

  return (
    <SetupShell title={view.orgName} subtitle={t("intro", { party: view.partyName, org: view.orgName })}>
      <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
        <p>{t("noChargeToday")}</p>
        <p className="mt-2">{t("singleUse")}</p>
      </div>
      <SetupContinueButton token={token} provider={view.provider} />
      <p className="mt-4 text-center text-xs text-slate-400 dark:text-slate-500">
        {t("providerLine", { provider })}
      </p>
    </SetupShell>
  );
}

function SetupShell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-gradient-to-b from-white to-slate-100 p-4 dark:from-slate-950 dark:to-slate-900">
      <div className="w-full max-w-md rounded-3xl border border-slate-200/80 bg-white p-8 shadow-xl shadow-slate-900/5 dark:border-slate-800 dark:bg-slate-900 dark:shadow-black/30">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white">{title}</h1>
          {subtitle ? (
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>
          ) : null}
        </div>
        {children}
      </div>
    </div>
  );
}
