import { getTranslations } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { isUuid } from "../../../../../lib/list-params";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const t = await getTranslations("compliance");
  const { id } = await params;
  if (!isUuid(id)) return { title: t("informationReturns.title") };
  return { title: t("informationReturns.title") };
}

/**
 * One filing's recipient worksheet: the computed box amounts, the adjustments a
 * person made and why, and the actions that move the filing forward.
 *
 * The worksheet is the artefact an accountant reviews before anything is
 * transmitted, so the ledger figure and the filed figure are both visible on
 * every row — never one silently replacing the other.
 */
export default async function FilingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  redirect(`/compliance/information-returns?filing=${encodeURIComponent(id)}`);
}
