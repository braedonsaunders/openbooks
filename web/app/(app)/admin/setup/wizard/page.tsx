import { ModuleView } from '../../../../../components/viewspec/module-view'
import { loadWizard, wizardSpec } from './view'

export const dynamic = 'force-dynamic'

/**
 * The setup wizard page — used when the user re-runs the wizard from the
 * Features page ("Run setup wizard" button). On first login the wizard is
 * rendered inline by the app layout (see web/app/(app)/layout.tsx).
 */
export default async function WizardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const data = await loadWizard()
  return <ModuleView spec={wizardSpec(data)} data={data} searchParams={sp} trusted />
}
