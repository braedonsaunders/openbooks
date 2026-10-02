import {ModuleView} from '../../../../../components/viewspec/module-view'
import {loadTemplateWorkspace,templateWorkspaceSpec} from './view'
export const dynamic='force-dynamic'
export default async function PerformanceTemplatesPage({searchParams}:{searchParams:Promise<Record<string,string|undefined>>}){
  const sp=await searchParams,data=await loadTemplateWorkspace(sp)
  return <ModuleView spec={templateWorkspaceSpec(data)} data={data} searchParams={sp} trusted/>
}
