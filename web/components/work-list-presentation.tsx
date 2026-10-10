"use client";
import {useState,useRef,useEffect} from 'react';
import {useRouter} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {Button} from '@openbooks/ui';
import {readApiErrorMessage} from '@/lib/api-error';
import type {WorkListContext,WorkListPresentation} from '@openbooks/engine/src/organization/list-presentation.ts';
export function WorkListPresentation({context,value,basePath,currentParams}:{context:WorkListContext;value:WorkListPresentation;basePath:string;currentParams:Record<string,string|string[]|undefined>}) {
  const t=useTranslations('operatingProfiles.views'),router=useRouter(),lock=useRef(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const alive=useRef(true);useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
  async function select(presentation:WorkListPresentation) {
    if(lock.current)return;lock.current=true;setBusy(true);setError(null);
    try {
      const response=await fetch('/api/customization/list-presentation',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({context,presentation})});
      if(!response.ok)throw new Error(await readApiErrorMessage(response,t('saveFailed')));
      if(!alive.current)return;
      const params=new URLSearchParams();for(const [key,raw]of Object.entries(currentParams)){const value=Array.isArray(raw)?raw[0]:raw;if(value!==undefined&&!['page','record','project'].includes(key))params.set(key,value)}params.set('presentation',presentation);router.push((basePath+'?'+params) as never);router.refresh();
    }catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:t('saveFailed'))}finally{lock.current=false;if(alive.current)setBusy(false)}
  }
  return <div className="space-y-1"><div role="group" aria-label={t('presentation')} className="flex gap-1">{(['board','list'] as const).map(mode=><Button type="button" key={mode} variant={value===mode?'secondary':'ghost'} size="sm" aria-pressed={value===mode} disabled={busy} onClick={()=>void select(mode)}>{t(mode)}</Button>)}</div>{error?<p role="alert" className="text-xs text-red-700">{error}</p>:null}</div>;
}
