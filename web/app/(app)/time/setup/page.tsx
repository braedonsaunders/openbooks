import { ModuleView } from '../../../../components/viewspec/module-view'
import { fieldSetupSpec, fieldSetupTitle, loadFieldSetupPage } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await fieldSetupTitle() }
}

/**
 * The field-time setup surface — rules, kiosks, chains. Time managers
 * only, fieldTime on, 404 otherwise.
 */
export default async function FieldSetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadFieldSetupPage()
  return <ModuleView spec={fieldSetupSpec(data)} data={data} searchParams={sp} trusted />
}
