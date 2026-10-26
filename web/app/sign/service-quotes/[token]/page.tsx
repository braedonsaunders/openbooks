import { getTranslations } from "next-intl/server";
import { ServiceQuoteForm } from "./ServiceQuoteForm";

export const dynamic = "force-dynamic";

/**
 * Hosted service-quote page: the customer reviews the quote, chooses the
 * optional add-ons and accepts with a typed name and drawn signature, or
 * declines. The link token authenticates; every request re-validates it.
 */
export default async function ServiceQuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await getTranslations("service.sign");
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center gap-4 px-4 py-10">
      <header className="text-center">
        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {t("quoteTitle")}
        </p>
      </header>
      <ServiceQuoteForm token={token} />
      <p className="text-center text-xs text-slate-500">{t("quoteNote")}</p>
    </div>
  );
}
