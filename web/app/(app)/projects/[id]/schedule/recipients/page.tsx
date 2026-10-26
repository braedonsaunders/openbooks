import { ResourceRecipients } from "../../../../scheduling/recipients/view";
import { isUuid } from "@openbooks/engine/platform/identifiers";
import { notFound } from "next/navigation";
export const dynamic = "force-dynamic";
export default async function ProjectRecipients({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  return <ResourceRecipients searchParams={searchParams} projectId={id} />;
}
