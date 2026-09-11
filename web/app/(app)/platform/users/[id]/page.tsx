import {
} from "@openbooks/ui";
import {
} from "../../../../../lib/platform-admin";
import {
} from "./sections";
import { ModuleView } from "../../../../../components/viewspec/module-view"
import { loadPlatformUser, platformUserSpec } from "./view"

export const dynamic = "force-dynamic";


export default async function PlatformUserPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = (await searchParams) ?? {};
  const data = await loadPlatformUser(id);
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={platformUserSpec(data)} data={data} searchParams={sp} trusted />
    </>
  );
}
