import { notFound, redirect } from "next/navigation";
import { isUuid } from "../../../../../lib/list-params";

export default async function PlatformUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  redirect(`/platform/users?user=${encodeURIComponent(id)}`);
}
