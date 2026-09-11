import { getTranslations } from "next-intl/server"
import { ModuleView } from "../../../../../components/viewspec/module-view"
import { bankFeedsSpec, loadBankFeeds } from "./view"

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const t = await getTranslations("banking");
  return { title: t("bankFeeds.title") };
}

/**
 * Company Settings → Bank Feeds. One cohesive surface for every way statements
 * reach an account: live aggregator feeds (Plaid / GoCardless / TrueLayer),
 * SFTP file drops, and manual upload — all shown as one connection list, added
 * from a global bank directory. Gated by the `bankFeeds` feature.
 */
export default async function BankFeedsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const data = await loadBankFeeds()
  return <ModuleView spec={bankFeedsSpec(data)} data={data} searchParams={sp} trusted />
}
