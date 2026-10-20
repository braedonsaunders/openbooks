import { and, eq, sql } from 'drizzle-orm';
import { db, schema, withOrgTransaction } from '../platform/db.ts';
import { lockActorCommandAuthority } from '../organization/actor-command-authority.ts';
import { lockAndCheckOrgFeature } from '../organization/org-feature-lock.ts';
import { assertPeriodModulesOpen } from '../periods/period-policy.ts';
import { markEntryReversed, postEntry, type PostEntryLineInput } from '../journal/post-entry.ts';
import { reversalJournalLines } from '../records/reversal-journal-lines.ts';
import { neg } from '../money/money.ts';
import { DepreciationRefusalError } from './depreciation-errors.ts';

/** Correct an unintended native posting without replacing its retained evidence. */
export async function reverseSourceManagedDepreciation(input: {
  orgId: string; assetId: string; lineId: string; actorId: string; reason: string;
}): Promise<{ originalEntryId: string; reversalEntryId: string; reversalLineId: string; created: boolean }> {
  const reason = input.reason.trim();
  if (reason.length < 8 || reason.length > 500) throw new DepreciationRefusalError('Record a correction reason between 8 and 500 characters.');
  return withOrgTransaction(input.orgId, async () => {
    const asset = (await db.execute<{ subsidiary_id: string; custom: Record<string, unknown> }>(sql`
      select subsidiary_id,custom from fixed_assets where org_id=${input.orgId} and id=${input.assetId} for update`)).rows[0];
    if (!asset) throw new DepreciationRefusalError('The fixed asset was not found.');
    await lockActorCommandAuthority(db,input.orgId,input.actorId,asset.subsidiary_id,'assets.manage');
    await lockActorCommandAuthority(db,input.orgId,input.actorId,asset.subsidiary_id,'gl.post');
    if (!await lockAndCheckOrgFeature(db,input.orgId,'fixedAssets')) throw new DepreciationRefusalError('Enable Fixed Assets in Company Settings → Features before correcting depreciation.');
    if (asset.custom.sourceManaged !== true || typeof asset.custom.sourceConnectionId !== 'string') throw new DepreciationRefusalError('Select a local depreciation posting on a source-managed asset.');
    const connection = await db.execute(sql`select id from connections where org_id=${input.orgId} and id=${asset.custom.sourceConnectionId} for share`);
    if (connection.rows.length !== 1) throw new DepreciationRefusalError('The owning connection was not found; restore its configuration before correcting the asset.');
    const line = (await db.execute<{
      id: string; schedule_id: string; period_id: string; book_id: string; source: string;
      posted_amount: string | null; journal_entry_id: string | null; non_gl_recognized_at: unknown;
    }>(sql`select l.id,l.schedule_id,l.period_id,s.book_id,l.source,l.posted_amount::text,l.journal_entry_id,l.non_gl_recognized_at
      from depreciation_schedules s join depreciation_schedule_lines l on l.org_id=s.org_id and l.schedule_id=s.id
      where s.org_id=${input.orgId} and s.asset_id=${input.assetId} and l.id=${input.lineId} for update of s,l`)).rows[0];
    if (!line || ['imported','reversal'].includes(line.source) || !line.journal_entry_id || line.posted_amount === null || line.non_gl_recognized_at !== null || /^-?0(?:\.0+)?$/.test(line.posted_amount)) throw new DepreciationRefusalError('Select one nonzero, locally posted depreciation line. Imported source history cannot be reversed here.');
    const prior = (await db.execute<{ id: string; journal_entry_id: string; reversal_reason: string; created_by: string }>(sql`
      select id,journal_entry_id,reversal_reason,created_by from depreciation_schedule_lines
      where org_id=${input.orgId} and reverses_line_id=${line.id}`)).rows[0];
    if (prior) {
      if (prior.reversal_reason !== reason || prior.created_by !== input.actorId) throw new DepreciationRefusalError('This depreciation line already has a retained correction; review its journal and reason.');
      return {originalEntryId:line.journal_entry_id,reversalEntryId:prior.journal_entry_id,reversalLineId:prior.id,created:false};
    }
    const entry = (await db.execute<{ status: string; origin: string; book_id: string; subsidiary_id: string; period_id: string; posting_date: string; created_at: string }>(sql`
      select status,origin,book_id,subsidiary_id,period_id,posting_date::text,created_at::text from journal_entries
      where org_id=${input.orgId} and id=${line.journal_entry_id} for update`)).rows[0];
    if (!entry || entry.status !== 'posted' || entry.origin !== 'depreciation' || entry.book_id !== line.book_id || entry.subsidiary_id !== asset.subsidiary_id || entry.period_id !== line.period_id) throw new DepreciationRefusalError('The depreciation journal is no longer an intact posting in this asset, book and period.');
    const later = await db.execute(sql`
      select 1 from asset_basis_changes where org_id=${input.orgId} and asset_id=${input.assetId}
        and book_id=${line.book_id} and (effective_on>=${entry.posting_date} or created_at>=${entry.created_at}::timestamptz)
      union all select 1 from asset_events where org_id=${input.orgId} and asset_id=${input.assetId}
        and journal_entry_id is not null and created_at>=${entry.created_at}::timestamptz limit 1`);
    if (later.rows.length) throw new DepreciationRefusalError('The asset has subsequent lifecycle measurements. Correct those dependencies through their governed workflows before reversing this depreciation.');
    await assertPeriodModulesOpen(db,{orgId:input.orgId,periodId:line.period_id,bookId:line.book_id,subsidiaryIds:[asset.subsidiary_id],modules:['assets']});
    const originals = await db.select().from(schema.journalLines).where(and(eq(schema.journalLines.orgId,input.orgId),eq(schema.journalLines.entryId,line.journal_entry_id)));
    if (!originals.length) throw new Error('The depreciation journal has no retained lines.');
    const mirror = reversalJournalLines(originals,{orgId:input.orgId,entryId:''});
    const posted = await postEntry(db,{
      orgId:input.orgId,bookId:line.book_id,subsidiaryId:asset.subsidiary_id,periodId:line.period_id,
      postingDate:entry.posting_date,origin:'depreciation',actorId:input.actorId,
      entryNumber:`DEP-REV-${line.id}`,memo:reason,reversesEntryId:line.journal_entry_id,
      idempotencyKey:`depreciation-reversal:${line.id}`,amountBasis:'book',accountBasis:'book',allowInactiveAccounts:true,
      auditChanges:{assetId:input.assetId,sourceLineId:line.id,reason},
      lines:mirror.map(l=>({...l,currency:l.currency!,txnAmount:l.txnAmount!,amount:l.amount!,subsidiaryId:l.subsidiaryId!,extraDims:l.extraDims as PostEntryLineInput['extraDims'],custom:l.custom as PostEntryLineInput['custom']})),
    });
    await markEntryReversed(db,{orgId:input.orgId,entryId:line.journal_entry_id,actorId:input.actorId});
    const saved = (await db.execute<{id:string}>(sql`
      insert into depreciation_schedule_lines(org_id,schedule_id,period_id,sequence,planned_amount,posted_amount,journal_entry_id,source,reverses_line_id,reversal_reason,created_by,updated_by)
      values(${input.orgId},${line.schedule_id},${line.period_id},
        (select coalesce(max(sequence),-1)+1 from depreciation_schedule_lines where org_id=${input.orgId} and schedule_id=${line.schedule_id}),
        ${neg(line.posted_amount)},${neg(line.posted_amount)},${posted.entryId},'reversal',${line.id},${reason},${input.actorId},${input.actorId}) returning id`)).rows[0];
    if (!saved) throw new Error('The depreciation correction evidence was not saved.');
    const audit = await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values(${input.orgId},'depreciation_schedule_lines',${saved.id},'insert',
        ${JSON.stringify({event:'depreciation_reversed',assetId:input.assetId,originalLineId:line.id,originalEntryId:line.journal_entry_id,reversalEntryId:posted.entryId,amount:neg(line.posted_amount),reason})}::jsonb,${input.actorId}) returning id`);
    if (audit.rows.length !== 1) throw new Error('The depreciation correction audit was not saved.');
    return {originalEntryId:line.journal_entry_id,reversalEntryId:posted.entryId,reversalLineId:saved.id,created:true};
  });
}
