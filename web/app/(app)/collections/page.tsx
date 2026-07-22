import { redirect } from "next/navigation";
import { PageHeader } from "@openbooks/ui";
import { requirePermission } from "../../../lib/authz";
import { CollectionsClient } from "./CollectionsClient";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return { title: "Recurring & Collections" };
}

/**
 * Recurring billing + dunning control surface. Recurring schedules clone a
 * template document on a cadence (engine/src/recurring.ts); dunning policies
 * fire an overdue-invoice reminder ladder (engine/src/dunning.ts). Both run from
 * the scheduler — this page configures and monitors them.
 */
export default async function CollectionsPage() {
  const authz = await requirePermission("documents.manage").catch(() => null);
  if (!authz) redirect("/dashboard");
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <PageHeader
        title="Recurring & Collections"
        description="Automate repeating invoices and chase overdue receivables."
      />
      <CollectionsClient />
    </div>
  );
}
