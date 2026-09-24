'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Badge, Button, Input, Label, SearchSelect, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, UrlDrawer } from '@openbooks/ui'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { computeOpportunityTotals } from '@openbooks/engine/src/crm/crm-math.ts'
import { formatMoney } from '@openbooks/engine/src/money/money.ts'
import { displayOpportunityStatusName } from '../../../lib/crm-status-display'

type Option = { id: string; name: string }
type ContactOption = Option & { party_id: string }
type OpportunityRow = {
  id: string; title: string; party_id: string | null; primary_contact_id: string | null;
  owner_user_id: string | null; sales_team_id: string | null; status_id: string;
  lead_source_id: string | null; expected_close_date: string | null; forecast_category: string;
  probability: string | number; currency: string; next_step: string | null; description: string | null;
  win_loss_reason: string | null; opportunity_number: string; status_name: string; updated_at: string;
}
type OpportunityLineRow = { item_id: string | null; description: string | null; quantity: string | number; unit: string | null; unit_price: string | number; unit_cost?: string | number | null }
/** `unitCost` empty means "not costed", which is not the same as '0'. */
type OpportunityLineForm = { itemId: string; description: string; quantity: string; unit: string; unitPrice: string; unitCost: string }
type OpportunityData = { opportunity: OpportunityRow; lines: OpportunityLineRow[] }

export function OpportunityDrawer({ data, statuses, accounts, contacts, owners, teams, sources, items, currencies, closeHref, canManage, multiCurrency = false }: { data: OpportunityData; statuses: Option[]; accounts: Option[]; contacts: ContactOption[]; owners: Option[]; teams: Option[]; sources: Option[]; items: Option[]; currencies:{code:string;name:string}[]; closeHref:string; canManage:boolean; multiCurrency?: boolean }) {
  const t=useTranslations('crm'); const tc=useTranslations('common'); const router=useRouter(); const row=data.opportunity
  const startForm={ title:row.title==='New opportunity'?'':row.title, partyId:row.party_id??'', primaryContactId:row.primary_contact_id??'', ownerUserId:row.owner_user_id??'', salesTeamId:row.sales_team_id??'', statusId:row.status_id, leadSourceId:row.lead_source_id??'', expectedCloseDate:row.expected_close_date??'', forecastCategory:row.forecast_category, probability:String(row.probability), currency:row.currency, nextStep:row.next_step??'', description:row.description??'', winLossReason:row.win_loss_reason??'' }
  const startLines:OpportunityLineForm[]=data.lines.map((line)=>({itemId:line.item_id??'',description:line.description??'',quantity:String(line.quantity),unit:line.unit??'',unitPrice:String(line.unit_price),unitCost:line.unit_cost==null?'':String(line.unit_cost)}))
  const [form,setForm]=useState(startForm)
  const [lines,setLines]=useState<OpportunityLineForm[]>(startLines)
  // Live margin through the SAME engine function the route persists with, so
  // the figure on screen is the figure that will be stored rather than a
  // second implementation that agrees until it doesn't. The math refuses
  // malformed decimals, which is exactly what a half-typed number is, so a
  // throw here means "not computable yet" and the panel shows nothing.
  const totals=useMemo(()=>{
    try {
      return computeOpportunityTotals(
        lines.map((line)=>({quantity:line.quantity.trim(),unitPrice:line.unitPrice.trim(),unitCost:line.unitCost.trim()===''?null:line.unitCost.trim()})),
        Number.isInteger(Number(form.probability))?Number(form.probability):0,
      )
    } catch { return null }
  },[lines,form.probability])
  const showMoney=(value:string)=>`${formatMoney(value)} ${form.currency}`
  // Two different reasons produce no margin — no cost recorded, or no revenue
  // to divide by — and neither is 0%. Both read as "—" rather than as a number
  // nobody can act on.
  const showPercent=(value:string|null)=>value===null?'—':`${Number(value).toFixed(1)}%`
  // OM-02: the estimate endpoint converts the STORED revision (account and
  // lines), while this form edits a LOCAL one. Converting while dirty would
  // mint a quote from stale data — or fail on a stored account the user
  // already changed. The snapshot below is the last saved visible state; any
  // divergence disables conversion with a save-first reason until the next
  // successful save re-baselines it.
  const [savedSnapshot,setSavedSnapshot]=useState(()=>JSON.stringify({form:startForm,lines:startLines}))
  const isDirty=JSON.stringify({form,lines})!==savedSnapshot
  const [busy,setBusy]=useState(false); const [lossReasonError,setLossReasonError]=useState(false); const set=(key:string,value:unknown)=>setForm(current=>({...current,[key]:value}))
  // Opaque optimistic-concurrency token: the opportunity's canonical revision
  // when this drawer opened. Every save sends it; a 409 surfaces the server's
  // message and keeps the form dirty (never silently adopts the winner's
  // token) so the next save cannot overwrite unseen work.
  const [revision,setRevision]=useState(row.updated_at)
  async function save(){ if(!form.title.trim()) return toast.error(t('validation.titleRequired')); setBusy(true); try { const { currency, ...fields }=form; const response=await fetch(`/api/crm/opportunities/${row.id}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({...fields,partyId:form.partyId||null,primaryContactId:form.primaryContactId||null,ownerUserId:form.ownerUserId||null,salesTeamId:form.salesTeamId||null,leadSourceId:form.leadSourceId||null,expectedCloseDate:form.expectedCloseDate||null,probability:Number(form.probability),...(multiCurrency ? { currency } : {}),lines,expectedUpdatedAt:revision})}); const result=await response.json().catch(()=>null) as { error?: string; code?: string; opportunity?: { updated_at?: string } } | null; if(!response.ok){ const message=result?.error ?? tc('feedback.saveFailed'); if(result?.code==='win_loss_reason_required') setLossReasonError(true); toast.error(message); return } if(typeof result?.opportunity?.updated_at==='string'){setRevision(result.opportunity.updated_at);setSavedSnapshot(JSON.stringify({form,lines}))} toast.success(tc('feedback.saved')); router.refresh() }catch{toast.error(tc('feedback.saveFailed'))}finally{setBusy(false)} }
  async function estimate(){if(isDirty){toast.error(t('opportunities.saveFirstForEstimate'));return}setBusy(true);try{const response=await fetch(`/api/crm/opportunities/${row.id}/estimate`,{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()}});const result=await response.json().catch(()=>null) as { error?: string; id?: string } | null;if(!response.ok){toast.error(result?.error ?? t('opportunities.estimateFailed'));setBusy(false);return}toast.success(t('opportunities.estimateCreated'));router.push(`/estimates?estimate=${result?.id}&mode=edit`)}catch{toast.error(t('opportunities.estimateFailed'));setBusy(false)}}
  // The estimate endpoint converts the STORED revision, so the button stays
  // available only when the visible state is saved: an account-less click
  // would 422 with no recovery path in this drawer, and a dirty click would
  // convert data the user no longer sees.
  const estimateBlockedReason = !form.partyId ? t('opportunities.estimateNeedsAccount') : isDirty ? t('opportunities.saveFirstForEstimate') : null
  const accountContacts=contacts.filter((c)=>!form.partyId||c.party_id===form.partyId)
  return <UrlDrawer open closeHref={closeHref} size="2xl" title={<span className="flex items-center gap-2">{row.opportunity_number} · {form.title||t('opportunities.newFallback')}<Badge>{displayOpportunityStatusName(row.status_name,(key)=>t(`opportunities.statuses.${key}`))}</Badge></span>} headerActions={canManage?<><span className="inline-flex items-center gap-2"><Button variant="outline" onClick={estimate} disabled={busy||!form.partyId||isDirty} title={estimateBlockedReason??undefined} aria-describedby={estimateBlockedReason?'opportunity-estimate-hint':undefined}>{t('opportunities.createEstimate')}</Button>{estimateBlockedReason?<span id="opportunity-estimate-hint" className="text-xs text-slate-500 dark:text-slate-400">{estimateBlockedReason}</span>:null}</span><Button onClick={save} disabled={busy}>{busy?tc('actions.saving'):tc('actions.save')}</Button></>:undefined}>
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="sm:col-span-2"><Field label={t('fields.title')}><Input value={form.title} onChange={e=>set('title',e.target.value)} disabled={!canManage}/></Field></div>
      <Field label={t('fields.account')} hint={accounts.length===0?t('opportunities.noTrackedAccounts'):undefined} hintAction={accounts.length===0?{href:'/parties',label:t('opportunities.openParties')}:undefined}><Select value={form.partyId} onChange={e=>{set('partyId',e.target.value);set('primaryContactId','')}} disabled={!canManage}><option value="">{tc('labels.none')}</option>{accounts.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
      <Field label={t('fields.primaryContact')}><Select value={form.primaryContactId} onChange={e=>set('primaryContactId',e.target.value)} disabled={!canManage}><option value="">{tc('labels.none')}</option>{accountContacts.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
      <Field label={t('fields.owner')}><Select value={form.ownerUserId} onChange={e=>set('ownerUserId',e.target.value)} disabled={!canManage}><option value="">{t('fields.unassigned')}</option>{owners.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
      <Field label={t('fields.salesTeam')}><Select value={form.salesTeamId} onChange={e=>set('salesTeamId',e.target.value)} disabled={!canManage}><option value="">{tc('labels.none')}</option>{teams.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
      <Field label={t('fields.status')}><Select value={form.statusId} onChange={e=>{set('statusId',e.target.value);setLossReasonError(false)}} disabled={!canManage}>{statuses.map(o=><option key={o.id} value={o.id}>{displayOpportunityStatusName(o.name,(key)=>t(`opportunities.statuses.${key}`))}</option>)}</Select></Field>
      <Field label={t('fields.probability')}><Input type="number" min="0" max="100" value={form.probability} onChange={e=>set('probability',e.target.value)} disabled={!canManage}/></Field>
      <Field label={t('fields.forecastCategory')}><Select value={form.forecastCategory} onChange={e=>set('forecastCategory',e.target.value)} disabled={!canManage}>{['omitted','worst_case','most_likely','upside'].map(v=><option key={v} value={v}>{t(`forecastCategories.${v}`)}</option>)}</Select></Field>
      <Field label={t('fields.expectedClose')} hint={t('fields.expectedCloseHint')} hintId="expected-close-hint"><Input type="date" value={form.expectedCloseDate} onChange={e=>set('expectedCloseDate',e.target.value)} disabled={!canManage} aria-describedby="expected-close-hint"/></Field>
      {multiCurrency ? <Field label={t('fields.currency')}><SearchSelect value={form.currency} onChange={value=>set('currency',value)} options={currencies.map(currency=>({value:currency.code,label:`${currency.code} · ${currency.name}`}))} ariaLabel={t('fields.currency')} disabled={!canManage}/></Field> : null}
      <Field label={t('fields.leadSource')}><Select value={form.leadSourceId} onChange={e=>set('leadSourceId',e.target.value)} disabled={!canManage}><option value="">{tc('labels.none')}</option>{sources.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</Select></Field>
      <div className="sm:col-span-3"><Field label={t('fields.nextStep')}><Input value={form.nextStep} onChange={e=>set('nextStep',e.target.value)} disabled={!canManage}/></Field></div>
    </div>
    <section className="mt-7"><div className="mb-2 flex items-center justify-between"><h3 className="font-semibold">{t('opportunities.lines')}</h3>{canManage?<Button variant="outline" size="sm" onClick={()=>setLines(current=>[...current,{itemId:'',description:'',quantity:'1',unit:'',unitPrice:'0',unitCost:''}])}><Plus size={14}/>{t('opportunities.addLine')}</Button>:null}</div><div className="overflow-x-auto rounded-md border dark:border-slate-800"><Table><TableHeader><TableRow><TableHead>{t('fields.item')}</TableHead><TableHead>{t('fields.description')}</TableHead><TableHead>{t('fields.quantity')}</TableHead><TableHead>{t('fields.unitPrice')}</TableHead><TableHead>{t('fields.unitCost')}</TableHead><TableHead className="text-right">{t('fields.lineCost')}</TableHead><TableHead className="text-right">{t('fields.grossProfit')}</TableHead><TableHead className="text-right">{t('fields.grossMargin')}</TableHead><TableHead/></TableRow></TableHeader><TableBody>{lines.map((line,index)=>{const math=totals?.lines[index]??null;return <TableRow key={index}><TableCell><Select value={line.itemId} onChange={e=>setLines(current=>current.map((v,i)=>i===index?{...v,itemId:e.target.value}:v))} disabled={!canManage}><option value="">{t('opportunities.selectItem')}</option>{items.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</Select></TableCell><TableCell><Input value={line.description} onChange={e=>setLines(current=>current.map((v,i)=>i===index?{...v,description:e.target.value}:v))} disabled={!canManage}/></TableCell><TableCell><Input className="w-24 text-right tabular-nums" value={line.quantity} onChange={e=>setLines(current=>current.map((v,i)=>i===index?{...v,quantity:e.target.value}:v))} disabled={!canManage}/></TableCell><TableCell><Input className="w-32 text-right tabular-nums" value={line.unitPrice} onChange={e=>setLines(current=>current.map((v,i)=>i===index?{...v,unitPrice:e.target.value}:v))} disabled={!canManage}/></TableCell><TableCell><Input className="w-32 text-right tabular-nums" value={line.unitCost} placeholder={t('opportunities.costNotRecorded')} onChange={e=>setLines(current=>current.map((v,i)=>i===index?{...v,unitCost:e.target.value}:v))} disabled={!canManage}/></TableCell><TableCell className="text-right tabular-nums">{math?.costAmount?showMoney(math.costAmount):'—'}</TableCell><TableCell className="text-right tabular-nums">{math?.grossProfit?showMoney(math.grossProfit):'—'}</TableCell><TableCell className="text-right tabular-nums">{showPercent(math?.grossMarginPercent??null)}</TableCell><TableCell>{canManage?<Button variant="ghost" size="icon" aria-label={tc('actions.delete')} onClick={()=>setLines(current=>current.filter((_,i)=>i!==index))}><Trash2 size={15}/></Button>:null}</TableCell></TableRow>})}</TableBody></Table></div>
      {totals&&totals.lineCount>0?<div className="mt-3 flex flex-wrap items-start gap-x-8 gap-y-2 rounded-md border px-4 py-3 text-sm dark:border-slate-800">
        <Summary label={t('fields.projectedAmount')} value={showMoney(totals.projectedAmount)}/>
        <Summary label={t('fields.weightedAmount')} value={showMoney(totals.weightedAmount)}/>
        <Summary label={t('opportunities.totalCost')} value={totals.totalCost?showMoney(totals.totalCost):'—'}/>
        <Summary label={t('fields.grossProfit')} value={totals.grossProfit?showMoney(totals.grossProfit):'—'}/>
        <Summary label={t('fields.grossMargin')} value={showPercent(totals.grossMarginPercent)}/>
        {/* Say WHY the rollup is blank. A margin that is simply missing reads
            as a bug; "3 of 5 lines costed" reads as work left to do. */}
        {totals.isFullyCosted?null:<p className="basis-full text-xs text-slate-500 dark:text-slate-400">{t('opportunities.partiallyCosted',{costed:totals.costedLineCount,total:totals.lineCount})}</p>}
      </div>:null}</section>
    <div className="mt-6 grid gap-4 sm:grid-cols-2"><Field label={t('fields.description')}><Textarea rows={5} value={form.description} onChange={e=>set('description',e.target.value)} disabled={!canManage}/></Field><Field label={t('fields.winLossReason')}><Textarea rows={5} value={form.winLossReason} onChange={e=>{set('winLossReason',e.target.value);setLossReasonError(false)}} disabled={!canManage} aria-invalid={lossReasonError}/>{lossReasonError?<p className="mt-1 text-xs text-red-600 dark:text-red-400">{t('validation.lossReasonRequired')}</p>:null}</Field></div>
  </UrlDrawer>
}
function Field({label,hint,hintId,hintAction,children}:{label:string;hint?:string;hintId?:string;hintAction?:{href:string;label:string};children:React.ReactNode}){return <div className="space-y-1.5"><Label>{label}</Label>{children}{hint?<p id={hintId} className="text-xs text-slate-500 dark:text-slate-400">{hint}{hintAction?<> <Link href={hintAction.href as never} className="font-medium text-teal-700 underline-offset-2 hover:underline dark:text-teal-300">{hintAction.label}</Link></>:null}</p>:null}</div>}
function Summary({label,value}:{label:string;value:string}){return <div className="space-y-0.5"><div className="text-xs text-slate-500 dark:text-slate-400">{label}</div><div className="font-medium tabular-nums">{value}</div></div>}
