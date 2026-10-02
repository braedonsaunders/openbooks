import {redirect} from 'next/navigation'
export default async function ReviewTemplatesPage({searchParams}:{searchParams:Promise<Record<string,string|undefined>>}){const sp=await searchParams;redirect('/hrm/performance/templates'+(sp.template==='new'?'?template=new':''))}
