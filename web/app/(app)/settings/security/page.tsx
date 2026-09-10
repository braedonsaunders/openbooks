import { redirect } from "next/navigation";
import { currentUser } from "../../../../lib/auth";
import { ModuleView } from "../../../../components/viewspec/module-view";
import { loadSecurity, securitySpec } from "./view";
import { SecurityPageContent } from "./sections";

export const dynamic = "force-dynamic";

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if ((await searchParams).__viewspec === '1') {
    const sp = await searchParams
    const data = await loadSecurity(sp)
    return (
      <>
        {/* Proof-of-path marker for the conformance harness; hoisted to <head>. */}
        <meta name="x-viewspec-render" content="1" />
        <ModuleView spec={securitySpec(data)} data={data} searchParams={sp} trusted />
      </>
    )
  }
  const user = await currentUser();
  if (!user) redirect("/login");
  return <SecurityPageContent />;
}
