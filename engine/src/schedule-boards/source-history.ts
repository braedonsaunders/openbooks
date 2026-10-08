/** Immutable, reviewed source scheduling dates; no working-time or employment writes. */
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { isUuid } from "../platform/uuid.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { getBoard, peopleBoardAuthority, type ScheduleActor } from "./boards.ts";
import { bookingColor } from "./display.ts";
import { ScheduleError } from "./errors.ts";

export type SourceDisposition = "recorded" | "linked" | "exception";
export interface SourceScheduleRow {
  readonly sourceKey: string;
  readonly sourceHash: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly disposition: SourceDisposition;
  readonly boardId: string | null;
  readonly workerPartyId: string | null;
  readonly onDate: string | null;
  readonly label: string | null;
  readonly result: string | null;
  readonly notes: string | null;
  readonly visibleInSource: boolean;
  readonly linkedEntryId: string | null;
  readonly reason: string;
  /** Existing source assessment explicitly admitted by the fresh preview. */
  readonly expectedPriorId: string | null;
}
export interface SourceScheduleBatch {
  readonly sourceSystem: string;
  readonly sourceDataset: string;
  readonly captureHash: string;
  readonly rows: readonly SourceScheduleRow[];
}
export const sourceHistoryHash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const hashPattern = /^[0-9a-f]{64}$/;
function text(value: unknown, field: string, maximum: number, optional = false): string | null {
  if (optional && value === null) return null;
  if (typeof value !== "string" || value.length > maximum || (!optional && !value.trim()))
    throw new ScheduleError(`${field} needs supported text up to ${maximum} characters.`, { code: "schedule_source_invalid" });
  return value;
}
export function validateSourceBatch(batch: SourceScheduleBatch): void {
  text(batch.sourceSystem, "Source system", 200); text(batch.sourceDataset, "Source dataset", 200);
  if (!hashPattern.test(batch.captureHash) || !Array.isArray(batch.rows) || batch.rows.length < 1 || batch.rows.length > 500)
    throw new ScheduleError("Choose a checksummed source batch containing 1–500 rows.", { code: "schedule_source_invalid" });
  const keys = new Set<string>();
  for (const row of batch.rows) {
    text(row.sourceKey, "Source identity", 200); text(row.reason, "Review reason", 2000);
    text(row.label, "Source label", 1000, true); text(row.result, "Source result", 1000, true); text(row.notes, "Source notes", 2000, true);
    if (keys.has(row.sourceKey)) throw new ScheduleError("Each source identity occurs once in a batch.", { code: "schedule_source_invalid" });
    keys.add(row.sourceKey);
    if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload) || Buffer.byteLength(canonicalJson(row.payload)) > 65536
        || !hashPattern.test(row.sourceHash) || sourceHistoryHash(row.payload) !== row.sourceHash)
      throw new ScheduleError("The source payload differs from its approved hash.", { code: "schedule_source_changed" });
    if (!['recorded','linked','exception'].includes(row.disposition) || typeof row.visibleInSource !== 'boolean'
        || (row.onDate !== null && !isIsoCalendarDate(row.onDate)))
      throw new ScheduleError("Review the source classification and literal calendar date.", { code: "schedule_source_invalid" });
    for (const id of [row.boardId,row.workerPartyId,row.linkedEntryId,row.expectedPriorId])
      if (id !== null && !isUuid(id)) throw new ScheduleError("Choose exact native source references.", { code: "schedule_source_invalid" });
    if (row.disposition !== 'exception' && (!row.boardId || !row.workerPartyId || !row.onDate))
      throw new ScheduleError("A recorded source date needs an exact board and person; review missing identities as exceptions.", { code: "schedule_source_unresolved" });
    if ((row.disposition === 'linked') !== Boolean(row.linkedEntryId))
      throw new ScheduleError("Only linked source rows name a native booking.", { code: "schedule_source_invalid" });
  }
}

interface SourceHead { id: string; sourceKey: string; assessmentHash: string }
export interface SourceHistoryOutcome { readonly sourceKey: string; readonly id: string; readonly state: "created" | "unchanged" }

export interface BoardSourceRecord {
  readonly id: string;
  readonly sourceSystem: string;
  readonly sourceDataset: string;
  readonly sourceKey: string;
  readonly workerPartyId: string;
  readonly onDate: string;
  readonly label: string | null;
  readonly result: string | null;
  readonly notes: string | null;
  readonly visibleInSource: boolean;
  readonly recordedAt: string;
  readonly color: string | null;
}

/** Source observations do not reserve availability or supply worked time. */
export async function readBoardSourceHistory(actor: ScheduleActor, boardId: string, from: string, through: string): Promise<BoardSourceRecord[]> {
  return withOrgTransaction(actor.orgId, async () => {
    const board = await getBoard(actor, boardId);
    if (board.rowKind !== 'people') return [];
    const allowed = await peopleBoardAuthority(actor,'hrm.shifts.read',board.subsidiaryId);
    if (!isIsoCalendarDate(from) || !isIsoCalendarDate(through) || from > through)
      throw new ScheduleError('Choose a valid source history date range.');
    const records = (await db.execute<Omit<BoardSourceRecord,'color'>>(sql`select r.id,r.source_system as "sourceSystem",r.source_dataset as "sourceDataset",
      r.source_key as "sourceKey",r.worker_party_id as "workerPartyId",r.on_date::text as "onDate",r.label,r.source_result as result,
      r.source_notes as notes,r.visible_in_source as "visibleInSource",r.created_at::text as "recordedAt"
      from schedule_source_records r join parties p on p.org_id=r.org_id and p.id=r.worker_party_id
      where r.org_id=${actor.orgId} and r.board_id=${board.id} and r.disposition='recorded' and r.on_date between ${from} and ${through}
      ${subsidiaryVisibleFilter(sql`p.subsidiary_id`,allowed)}
      and not exists(select 1 from schedule_source_records n where n.org_id=r.org_id and n.supersedes_id=r.id)
      order by r.on_date,r.source_key,r.id`)).rows;
    return records.map(record=>({...record,color:bookingColor(board.cellColorRules,
      {code:record.label,label:record.result ?? record.label,detail:null})}));
  });
}

async function admittedRows(actor: ScheduleActor, batch: SourceScheduleBatch) {
  validateSourceBatch(batch);
  const authority = await peopleBoardAuthority(actor, 'hrm.shifts.approve', null);
  const boardIds = [...new Set(batch.rows.flatMap(row => row.boardId ? [row.boardId] : []))].sort();
  if (boardIds.length) await db.execute(sql`select id from schedule_boards where org_id=${actor.orgId}
    and id=any(${sql.param(boardIds)}::uuid[]) order by id for share`);
  const boards = new Map<string, Awaited<ReturnType<typeof getBoard>>>();
  for (const boardId of boardIds) {
    const board = await getBoard(actor, boardId);
    if (board.rowKind !== 'people') throw new ScheduleError("Source people history needs a people board.");
    await peopleBoardAuthority(actor, 'hrm.shifts.approve', board.subsidiaryId);
    boards.set(boardId, board);
  }
  const workerIds = [...new Set(batch.rows.flatMap(row => row.workerPartyId ? [row.workerPartyId] : []))].sort();
  const workers = new Map((workerIds.length ? (await db.execute<{id:string; subsidiaryId:string|null}>(sql`
    select p.id,p.subsidiary_id as "subsidiaryId" from parties p
    where p.org_id=${actor.orgId} and p.id=any(${sql.param(workerIds)}::uuid[]) and p.kind='person'
    and exists(select 1 from employee_roles er where er.org_id=p.org_id and er.party_id=p.id)
    ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, authority)} order by p.id for share of p`)).rows : []).map(worker => [worker.id,worker]));
  const linkedIds = batch.rows.flatMap(row => row.linkedEntryId ? [row.linkedEntryId] : []);
  const linkedEntries = new Map((linkedIds.length ? (await db.execute<{id:string;boardId:string;workerPartyId:string|null;onDate:string}>(sql`
    select id,board_id as "boardId",worker_party_id as "workerPartyId",starts_on::text as "onDate" from schedule_entries
    where org_id=${actor.orgId} and id=any(${sql.param(linkedIds)}::uuid[]) order by id for share`)).rows : []).map(entry=>[entry.id,entry]));
  const heads = new Map((await db.execute<SourceHead>(sql`select r.id,r.source_key as "sourceKey",r.assessment_hash as "assessmentHash"
    from schedule_source_records r where r.org_id=${actor.orgId} and r.source_system=${batch.sourceSystem}
    and r.source_dataset=${batch.sourceDataset} and r.source_key=any(${sql.param(batch.rows.map(row=>row.sourceKey))}::text[])
    and not exists(select 1 from schedule_source_records n where n.org_id=r.org_id and n.supersedes_id=r.id)`)).rows.map(head=>[head.sourceKey,head]));
  const admitted = [];
  for (const row of batch.rows) {
    const board = row.boardId ? boards.get(row.boardId)! : null;
    const worker = row.workerPartyId ? workers.get(row.workerPartyId) : null;
    if (row.workerPartyId && !worker) throw new ScheduleError("The source person has no native employee role or is outside the organization or actor scope.", { code: "schedule_source_scope" });
    if (!worker && authority !== null) throw new ScheduleError("Unresolved source identity requires organization-wide scheduling approval.", { code: "schedule_source_scope" });
    if (board?.subsidiaryId && board.subsidiaryId !== worker?.subsidiaryId)
      throw new ScheduleError("The source person belongs to a different legal entity from this board.", { code: "schedule_source_scope" });
    if (row.disposition === 'linked') {
      const linked = linkedEntries.get(row.linkedEntryId!);
      if (!linked || linked.boardId !== row.boardId || linked.workerPartyId !== row.workerPartyId || linked.onDate !== row.onDate)
        throw new ScheduleError("The native booking differs from the source person, board or date.", { code: "schedule_source_link" });
    }
    const assessmentHash = sourceHistoryHash({ sourceSystem: batch.sourceSystem, sourceDataset: batch.sourceDataset,
      sourceKey: row.sourceKey, sourceHash: row.sourceHash, disposition: row.disposition, boardId: row.boardId,
      workerPartyId: row.workerPartyId, onDate: row.onDate, label: row.label, result: row.result, notes: row.notes,
      visibleInSource: row.visibleInSource, linkedEntryId: row.linkedEntryId, reason: row.reason });
    const prior = heads.get(row.sourceKey) ?? null;
    if (prior && prior.assessmentHash !== assessmentHash && prior.id !== row.expectedPriorId)
      throw new ScheduleError("Source evidence has a different current assessment; preview and explicitly approve its successor.", { status:409,code:'schedule_source_stale' });
    if (!prior && row.expectedPriorId !== null)
      throw new ScheduleError("The prior source assessment is missing; preview again.", { status:409,code:'schedule_source_stale' });
    admitted.push({ row, board, subsidiaryId: worker?.subsidiaryId ?? null, assessmentHash, prior });
  }
  return admitted;
}

export async function previewSourceHistory(actor: ScheduleActor, batch: SourceScheduleBatch) {
  return withOrgTransaction(actor.orgId, async () => {
    const rows = await admittedRows(actor, batch);
    return { approvalHash: sourceHistoryHash({ actor, batch, assessments: rows.map(r => ({ sourceKey:r.row.sourceKey,
      assessmentHash:r.assessmentHash, priorId:r.prior?.id ?? null, subsidiaryId:r.subsidiaryId })) }),
      rows: rows.map(r => ({sourceKey:r.row.sourceKey, priorId:r.prior?.id ?? null,
        state:r.prior?.assessmentHash === r.assessmentHash ? 'unchanged' : 'created'})) };
  });
}

export async function importSourceHistory(actor: ScheduleActor, batch: SourceScheduleBatch, approvalHash: string): Promise<SourceHistoryOutcome[]> {
  return withOrgTransaction(actor.orgId, async () => {
    validateSourceBatch(batch);
    // A stable source lock serializes concurrent importers without touching
    // payroll or scheduling configuration. Locks are released at transaction end.
    const sourceLocks = batch.rows.map(row=>`${actor.orgId}|${batch.sourceSystem}|${batch.sourceDataset}|${row.sourceKey}`);
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(source_key,0))
      from (select source_key from unnest(${sql.param(sourceLocks)}::text[]) as keys(source_key) order by source_key) ordered_keys`);
    const rows = await admittedRows(actor, batch);
    const currentHash = sourceHistoryHash({ actor, batch, assessments: rows.map(r => ({sourceKey:r.row.sourceKey,
      assessmentHash:r.assessmentHash,priorId:r.prior?.id ?? null,subsidiaryId:r.subsidiaryId})) });
    if (currentHash !== approvalHash) throw new ScheduleError("The source assessment changed after preview; nothing was imported.", { status:409,code:'schedule_source_stale' });
    const fresh = rows.filter(row=>row.prior?.assessmentHash !== row.assessmentHash).map(row=>({...row,id:randomUUID()}));
    if (fresh.length) {
      const values = fresh.map(({row,assessmentHash,prior,subsidiaryId,id})=>sql`(
        ${id},${actor.orgId},${batch.sourceSystem},${batch.sourceDataset},${row.sourceKey},${row.sourceHash},
        ${assessmentHash},${batch.captureHash},${sql.param(row.payload)}::jsonb,${row.disposition},${row.boardId},${row.workerPartyId},
        ${subsidiaryId},${row.onDate},${row.label},${row.result},${row.notes},${row.visibleInSource},${row.linkedEntryId},
        ${prior?.id ?? null},${row.reason},${actor.actorId})`);
      const saved = (await db.execute<{id:string;sourceKey:string}>(sql`insert into schedule_source_records(
        id,org_id,source_system,source_dataset,source_key,source_hash,assessment_hash,capture_hash,source_payload,
        disposition,board_id,worker_party_id,subsidiary_id,on_date,label,source_result,source_notes,visible_in_source,
        linked_entry_id,supersedes_id,reason,created_by) values ${sql.join(values,sql`, `)} returning id,source_key as "sourceKey"`)).rows;
      const returned = new Map(saved.map(row=>[row.sourceKey,row.id]));
      if (saved.length !== fresh.length || returned.size !== fresh.length || fresh.some(row=>returned.get(row.row.sourceKey)!==row.id))
        throw new ScheduleError("Source evidence was not saved completely.", {code:'schedule_source_not_saved'});
    }
    const created = new Map(fresh.map(row=>[row.row.sourceKey,row.id]));
    return rows.map(({row,prior})=>created.has(row.sourceKey)
      ? {sourceKey:row.sourceKey,id:created.get(row.sourceKey)!,state:'created' as const}
      : {sourceKey:row.sourceKey,id:prior!.id,state:'unchanged' as const});
  });
}
