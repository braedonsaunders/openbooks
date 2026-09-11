import {
} from "@openbooks/ui";
import { ModuleView } from "../../../components/viewspec/module-view"
import { loadClose, closeSpec } from "./view"

export const dynamic = "force-dynamic";


export default async function PeriodClose({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams
  const data = await loadClose(sp)
  // The run branch stays native: CloseWizard owns its own WizardLayout
  // shell, which no PageLayout value can express. Keep the wizard on the
  // native path until the vocabulary for it exists.
  if (data.onRun) {
    return null
  }
  return (
    <>
      {/* Hoisted to <head>. The conformance harness reads it to tell a current
          build from a pre-cutover one still serving the old native page. */}
      <meta name="x-viewspec-render" content="1" />
      <ModuleView spec={closeSpec(data)} data={data} searchParams={sp} trusted />
    </>
  )
}
