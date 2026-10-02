import {redirect} from 'next/navigation'
export default async function PerformanceTemplateBuilderPage({params}:{params:Promise<{id:string}>}){
  const {id}=await params
  redirect('/hrm/performance/templates?template='+encodeURIComponent(id))
}
