import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { requirePermission,guardRootSubsidiaryScope } from '@/lib/authz';
import { isFeatureEnabled } from '@/lib/features';
import { pickString } from '@/lib/list-params';
import { SETUP_ENTITY_BY_KEY } from '@/lib/setup/registry';
import { ModuleHomeTabs } from '@/components/module-home/ui';
import { SetupEntitySection } from '../[entity]/SetupEntitySection';
import { WorkSetupJourney } from '../../../manufacturing/SetupJourney';

export const dynamic='force-dynamic';
const entities=[{tab:'profiles',key:'operating-profiles'},{tab:'scopes',key:'operating-profile-scopes'},{tab:'versions',key:'operating-profile-versions'}] as const;

/** The shared Setup editors and native readiness journey serve both work families. */
export default async function OperatingProfilesSetup({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
 const sp=await searchParams,authz=await requirePermission('admin.setup.manage');
 if(await guardRootSubsidiaryScope(authz))notFound();
 if(!await isFeatureEnabled(authz.user.orgId,'projects')&&!await isFeatureEnabled(authz.user.orgId,'manufacturing'))notFound();
 const requested=pickString(sp.tab),tab=requested==='start'||entities.some(entity=>entity.tab===requested)?requested:pickString(sp.row)?'profiles':'start';
 const selected=entities.find(entity=>entity.tab===tab),entity=selected?SETUP_ENTITY_BY_KEY.get(selected.key):null;
 if(selected&&!entity)notFound();
 const t=await getTranslations('admin'),m=await getTranslations('manufacturing');
 return <div className="space-y-4"><div className="space-y-1"><h2 className="text-base font-semibold">{t('setup.entities.operating-profiles.title')}</h2><p className="text-sm text-slate-500">{t('setup.entities.operating-profiles.description')}</p></div>
  <ModuleHomeTabs tabs={[{href:'/admin/setup/operating-profiles?tab=start',label:m('cockpit.setup'),active:tab==='start'},...entities.map(row=>({href:'/admin/setup/operating-profiles?tab='+row.tab,label:t('setup.entities.'+row.key+'.title'),active:tab===row.tab}))]}/>
  {tab==='start'?<WorkSetupJourney/>:entity?<SetupEntitySection entity={entity} orgId={authz.user.orgId} actorId={authz.user.id} searchParams={sp} basePath="/admin/setup/operating-profiles" canManage allowedSubsidiaryIds={authz.allowedSubsidiaryIds}/>:null}
 </div>;
}
