import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function TaxProvisionDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/tax/provisions?run=${encodeURIComponent(id)}`);
}
