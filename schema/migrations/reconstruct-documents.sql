-- Reconstruct subledger DOCUMENTS from the replayed NetSuite GL.
-- The replay created journal_entries (origin='migration') but not the source
-- vendor bills / invoices / payments / expense reports, so the subledger
-- lists are empty while the GL is complete. This backfills a posted document
-- per migration entry, kind-mapped, linked to its journal entry, with lines
-- reconstructed from the entry's non-control-account lines.
--
-- Idempotent: skips entries that already have a document. Touches only
-- documents/document_lines (no posted journal rows), so the kernel
-- immutability triggers never fire and the trial balance is unaffected.

begin;

-- 1. Documents -------------------------------------------------------------
with ent as (
  select e.id as entry_id, e.org_id, e.posting_date, e.memo,
         split_part(e.entry_number, '-', 2) as ttype,
         regexp_replace(e.entry_number, '^NS-[^-]+-(.*)-[^-]+$', '\1') as tranid
    from journal_entries e
   where e.origin = 'migration'
     and not exists (select 1 from documents d where d.posted_entry_id = e.id)
),
kinded as (
  select ent.*,
    case ttype
      when 'VendBill' then 'vendor_bill'
      when 'CustInvc' then 'customer_invoice'
      when 'VendPymt' then 'vendor_payment'
      when 'ExpRept'  then 'expense_report'
      when 'Journal'  then 'journal'
      when 'Check'    then 'cheque'
      when 'Transfer' then 'transfer'
      when 'VendCred' then 'vendor_credit'
      when 'CustCred' then 'customer_credit'
      when 'CardChrg' then 'card_charge'
      when 'CardRfnd' then 'card_refund'
      else lower(ttype)
    end as kind
  from ent
),
ctl as (
  select k.*,
    case
      when k.kind in ('vendor_bill','vendor_payment','vendor_credit','expense_report') then 'liability_payable'
      when k.kind in ('customer_invoice','customer_payment','customer_credit') then 'asset_receivable'
      when k.kind in ('cheque','transfer') then 'asset_bank'
      when k.kind in ('card_charge','card_refund') then 'liability_card'
      else null
    end as control_type
  from kinded k
),
agg as (
  select c.*,
    (select l.party_id from journal_lines l
      where l.entry_id = c.entry_id and l.party_id is not null limit 1) as party_id,
    coalesce(
      (select abs(sum(l.amount)) from journal_lines l
         join accounts a on a.id = l.account_id
        where l.entry_id = c.entry_id and a.type = c.control_type),
      (select sum(l.amount) from journal_lines l
        where l.entry_id = c.entry_id and l.amount > 0)
    ) as total,
    row_number() over (partition by c.org_id, c.kind, c.tranid order by c.entry_id) as rn
  from ctl c
)
insert into documents
  (org_id, kind, document_number, party_id, document_date, currency,
   status, posted_entry_id, subtotal, tax_total, total, memo)
select org_id, kind,
       case when rn = 1 then tranid else tranid || '-' || rn::text end,
       party_id, posting_date, 'CAD', 'posted', entry_id,
       coalesce(total, 0), 0, coalesce(total, 0), memo
  from agg;

-- 2. Document lines: the non-control journal lines of each new document ----
insert into document_lines
  (org_id, document_id, line_number, account_id, description,
   quantity, unit_price, amount, department_id, project_id)
select d.org_id, d.id,
       row_number() over (partition by d.id order by l.line_number),
       l.account_id, l.memo, 1, l.amount, l.amount, l.department_id, l.project_id
  from documents d
  join journal_lines l on l.entry_id = d.posted_entry_id
  join accounts a on a.id = l.account_id
 where d.posted_entry_id is not null
   and not exists (select 1 from document_lines dl where dl.document_id = d.id)
   and a.type is distinct from (
     case
       when d.kind in ('vendor_bill','vendor_payment','vendor_credit','expense_report') then 'liability_payable'
       when d.kind in ('customer_invoice','customer_payment','customer_credit') then 'asset_receivable'
       when d.kind in ('cheque','transfer') then 'asset_bank'
       when d.kind in ('card_charge','card_refund') then 'liability_card'
       else null
     end
   );

commit;
