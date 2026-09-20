/** Test-only fixture: projection tests install through the real draft/review
 * service. No alternate module installer exists in the product. */
import { registerHooks } from 'node:module'
import { randomUUID } from 'node:crypto'
import { withOrgTransaction } from '../platform/db.ts'
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'server-only') return { shortCircuit:true, format:'module', url:'data:text/javascript,export {}' }
  if (specifier.startsWith('@/')) return next(new URL(`../../../web/${specifier.slice(2)}`,import.meta.url).href,context)
  return next(specifier,context)
} })
export async function installTestExtension(opts: {
  orgId:string; actorId:string;
  manifest:{key:string;name:string;version:string;permissions:string[];contributions:unknown[]}; reason?:string;
}) {
  return withOrgTransaction(opts.orgId, async () => {
  const draftExtensionPath = '../../../web/lib/application/extensions.ts'
  const { draftExtension, activateExtensionDraft } = await import(draftExtensionPath)
  const getAppByKeyPath = '../../../web/lib/apps/store.ts'
  const { getAppByKey } = await import(getAppByKeyPath)
  const applicationContextFromSessionPath = '../../../web/lib/application/context.ts'
  const { applicationContextFromSession } = await import(applicationContextFromSessionPath)
  const context = applicationContextFromSession({user:{id:opts.actorId,orgId:opts.orgId,name:'Extension fixture',email:'extension@scratch.test',roles:[{key:'admin',name:'Admin'}],envKind:'production',productionOrgId:opts.orgId,isSuperAdmin:false,homeUserId:opts.actorId,homeOrgId:opts.orgId},permissions:new Set(['*']),allowedSubsidiaryIds:null},'api',randomUUID())
  const permissions=[...new Set([...opts.manifest.permissions,...(opts.manifest.contributions.some(item=>typeof item==='object'&&item!==null&&'kind' in item&&item.kind==='page')?['admin.customization.manage']:[])])]
  const bundle={manifest:{...opts.manifest,permissions,frontend:{renderer:'native',entry:'frontend/ui.json'},endpoints:[]},files:[{path:'frontend/ui.json',content:JSON.stringify({screens:[{key:'overview',title:opts.manifest.name,kind:'page',spec:{specVersion:1,layout:'list',header:[],body:[]}}]})}]}
  const draft=await draftExtension(context,{bundle,reason:opts.reason??'Verify governed extension projections'})
  await activateExtensionDraft(context,draft)
  const app=(await getAppByKey(opts.orgId,opts.manifest.key))!
  return {extensionId:app.id,versionId:app.activeVersionId!,draftId:draft.draftId}
  })
}
export async function disableTestExtension(opts:{orgId:string;actorId:string;key:string}) {
  const storePath='../../../web/lib/apps/store.ts'
  const {setAppStatus}=await import(storePath)
  await setAppStatus(opts.orgId,opts.actorId,opts.key,'disabled')
}
