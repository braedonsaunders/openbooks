-- Posted documents: financial-identity immutability at the database layer.
--
-- The journal side has always been guarded (je_guard, journal-line guards),
-- but the DOCUMENT HEADER's financial identity — totals, dates, currency,
-- party, kind, number — was mutable by any raw SQL write while posted. That
-- is the exact writable surface behind the historical retainage header-total
-- defect, and the decade-endurance adversarial probe
-- (engine/src/sim/ops-adversarial.ts postedEditProbe) demonstrates it in one
-- statement. Close the gap the same way the journal guards do: refuse the
-- write unless the engine's governed amend path ('openbooks.amend') is active.
--
-- Additive and forward-only (0002_auth_security pattern); the immutable 0001
-- baseline is not rewritten.

create function public.posted_document_financial_guard() returns trigger
    language plpgsql
    as $$
begin
  if coalesce(current_setting('openbooks.sandbox_wipe', true), 'off') = 'on' then
    return new;
  end if;
  if openbooks_sandbox_wipe_allowed(old.org_id) then
    return new;
  end if;
  if coalesce(current_setting('openbooks.amend', true), 'off') <> 'on' then
    raise exception 'document % is % — its financial identity (totals, dates, currency, party, kind, number) is immutable outside the governed amend path', old.id, old.status;
  end if;
  return new;
end $$;

create trigger documents_posted_financial_guard
  before update of total, subtotal, tax_total, currency, fx_rate,
    document_date, posting_date, party_id, kind, document_number
  on public.documents
  for each row
  when (old.status in ('posted', 'reversed')
    and (new.total is distinct from old.total
      or new.subtotal is distinct from old.subtotal
      or new.tax_total is distinct from old.tax_total
      or new.currency is distinct from old.currency
      or new.fx_rate is distinct from old.fx_rate
      or new.document_date is distinct from old.document_date
      or new.posting_date is distinct from old.posting_date
      or new.party_id is distinct from old.party_id
      or new.kind is distinct from old.kind
      or new.document_number is distinct from old.document_number))
  execute function public.posted_document_financial_guard();
