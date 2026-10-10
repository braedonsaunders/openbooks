import Link from "next/link";
import { z } from "zod";
import { getTranslations } from "next-intl/server";
import { db, withOrgTransaction } from "@openbooks/engine/src/platform/db.ts";
import { traceManufacturingGenealogy } from "@openbooks/engine/src/manufacturing/genealogy.ts";
import { requirePermission } from "@/lib/authz";
import { requireFeatureEnabled } from "@/lib/feature-gates";
import { PageHeader, EmptyState } from "@openbooks/ui";
import { ListPageLayout } from "@/components/page-layout";
import { GenealogyTable } from "./GenealogyTable";

export const dynamic = "force-dynamic";
const Query = z.object({ kind:z.enum(["lot","serial"]),id:z.string().uuid(),direction:z.enum(["forward","backward"]).default("forward"),maxDepth:z.coerce.number().int().min(1).max(32).default(8) });
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const authz=await requirePermission("manufacturing.read");
  await requireFeatureEnabled(authz.user.orgId,"manufacturing");
  const t=await getTranslations("manufacturing.genealogy");
  const parsed=Query.safeParse(await searchParams);
  if(!parsed.success) return <ListPageLayout header={<PageHeader title={t("title")} />}><EmptyState title={t("choose")} description={t("chooseNote")} /></ListPageLayout>;
  const result=await withOrgTransaction(authz.user.orgId,()=>traceManufacturingGenealogy(db,authz.user.orgId,authz.user.id,parsed.data,authz.allowedSubsidiaryIds));
  const href=(direction:"forward"|"backward")=>"/manufacturing/genealogy?"+new URLSearchParams({...parsed.data,maxDepth:String(parsed.data.maxDepth),direction}).toString();
  return <ListPageLayout header={<PageHeader title={t("title")} description={result.seed.itemName+" · "+result.seed.label} />}><nav aria-label={t("direction")} className="flex gap-4 border-b pb-3">{(["forward","backward"] as const).map(direction=><Link key={direction} aria-current={result.direction===direction?"page":undefined} className={result.direction===direction?"font-semibold text-teal-700":"text-slate-500"} href={href(direction) as never}>{t(direction)}</Link>)}</nav><p className="text-sm text-slate-500">{t("association")}{result.visibility==="authorized_entities"?" "+t("scoped"):""}</p>{result.truncated?<p role="status" className="text-sm text-amber-700">{t("truncated")}</p>:null}<GenealogyTable edges={result.edges} /></ListPageLayout>;
}
