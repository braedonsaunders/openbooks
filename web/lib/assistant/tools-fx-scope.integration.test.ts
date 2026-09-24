import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { SessionUser } from '../auth';

const root = pathToFileURL(process.cwd() + '/').href;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' };
  if (specifier.startsWith('@/')) {
    const path = root + 'web/' + specifier.slice(2);
    for (const suffix of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
      if (existsSync(new URL(path + suffix))) return nextResolve(path + suffix, context);
    }
    return nextResolve(path, context);
  }
  return nextResolve(specifier, context);
} });

const { sql } = await import('drizzle-orm');
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts');
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts');
const { executeAssistantTool } = await import('./registry');
const { applicationTool, executeApplicationTool } = await import('../application/tool-catalog.ts');
const { listApplicationFxRates } = await import('../application/fx-read.ts');
const { ApplicationError } = await import('../application/errors.ts');
type ApplicationContext = import('../application/context.ts').ApplicationContext;

function userFor(orgId: string, userId: string): SessionUser {
  return {
    id: userId, orgId, name: 'FX reader', email: 'fx-scope@scratch.test',
    roles: [{ key: 'ordinary-role', name: 'Ordinary role' }],
    isSuperAdmin: false, envKind: 'production',
    productionOrgId: orgId, homeOrgId: orgId, homeUserId: userId,
  };
}

function appCtx(orgId: string, userId: string, permissions: string[]): ApplicationContext {
  return {
    authz: {
      user: userFor(orgId, userId), permissions: new Set(permissions), allowedSubsidiaryIds: null,
    },
    source: 'api', requestId: randomUUID(), apiKeyId: null,
  };
}

async function seedFx(orgId: string, subsidiaryId: string, actorId: string, accounts: Record<string, string>) {
  const unrealizedId = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${unrealizedId}, ${orgId}, '7990', 'Unrealized FX', 'expense_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)
  `);
  await db.execute(sql`
    update orgs set settings = jsonb_set(jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"multiCurrency": true}'::jsonb),
      '{controlAccounts}', coalesce(settings->'controlAccounts', '{}'::jsonb) || ${JSON.stringify({ fxUnrealizedGainLoss: unrealizedId })}::jsonb)
     where id = ${orgId}
  `);
  // A USD monetary balance: bank leg carried at 1.37, offset in CAD.
  // A USD monetary balance. No currency_restriction: the period-end
  // adjustment leg posts in functional currency, which a USD-only account
  // would refuse (jl_check_account) — the engine then reports problems.
  const usdBankId = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children, subsidiary_id)
    values (${usdBankId}, ${orgId}, '1010', 'USD Cash', 'asset_bank', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true, ${subsidiaryId})
  `);
  await db.execute(sql`
    insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
    values (${orgId}, 'USD', 'CAD', '2026-07-31', 'spot', '1.4000000000', 'manual')
  `);
  const period = (await db.execute<{ id: string; fiscal_calendar_id: string }>(sql`
    select id, fiscal_calendar_id from accounting_periods where org_id = ${orgId} limit 1
  `)).rows[0]!;
  await db.execute(sql`
    insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    values (${randomUUID()}, ${orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, ${period.fiscal_calendar_id})
  `);
  const entryId = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, entry_number, posting_date, period_id, memo, status, origin, subsidiary_id)
    values (${entryId}, ${orgId},
      (select id from accounting_books where org_id = ${orgId} and is_primary),
      'JE-FX-1', '2026-07-15', ${period.id}, 'usd seed', 'draft', 'manual', ${subsidiaryId})
  `);
  await db.execute(sql`
    insert into journal_lines
      (id, org_id, entry_id, line_number, account_id, amount, currency, txn_amount, fx_rate, subsidiary_id)
    values (${randomUUID()}, ${orgId}, ${entryId}, 1, ${usdBankId}, '137.0000', 'USD', '100.0000', '1.37', ${subsidiaryId}),
           (${randomUUID()}, ${orgId}, ${entryId}, 2, ${accounts.revenue}, '-137.0000', 'CAD', '-137.0000', '1', ${subsidiaryId})
  `);
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId} where id = ${entryId}`);
  // Consolidation fixtures: a second entity, a derived rate set, one
  // ownership run with an acquisition entry behind it.
  const childId = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${childId}, ${orgId}, ${subsidiaryId}, 'Euro Sub', 'EUR', 'DE', '{}'::jsonb, false, true, '{}'::jsonb)
  `);
  await db.execute(sql`
    insert into consolidated_fx_rates (org_id, period_id, from_currency, to_currency, current_rate, average_rate, historical_rate, source)
    values (${orgId}, ${period.id}, 'EUR', 'CAD', '1.5000000000', '1.4800000000', '1.4500000000', 'derived')
  `);
  const goodwillId = randomUUID();
  const fvAdjId = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${goodwillId}, ${orgId}, '1800', 'Goodwill', 'asset_current_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true),
           (${fvAdjId}, ${orgId}, '1810', 'FV Adjustment', 'asset_current_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)
  `);
  const interestId = randomUUID();
  await db.execute(sql`
    insert into subsidiary_ownership_interests
      (id, org_id, parent_subsidiary_id, subsidiary_id, effective_from, ownership_percent, acquisition_date,
       investment_account_id, equity_income_account_id, goodwill_account_id, fair_value_adjustment_account_id)
    values (${interestId}, ${orgId}, ${subsidiaryId}, ${childId}, '2026-01-01', '100.0000000000', '2026-01-01',
      ${accounts.bank}, ${accounts.revenue}, ${goodwillId}, ${fvAdjId})
  `);
  const runId = randomUUID();
  await db.execute(sql`
    insert into ownership_consolidation_runs (id, org_id, period_id, status, finished_at)
    values (${runId}, ${orgId}, ${period.id}, 'posted', now())
  `);
  const elimEntryId = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, entry_number, posting_date, period_id, memo, status, origin, subsidiary_id)
    values (${elimEntryId}, ${orgId},
      (select id from accounting_books where org_id = ${orgId} and is_primary),
      'JE-ELIM-1', '2026-07-31', ${period.id}, 'elim seed', 'draft', 'manual', ${subsidiaryId})
  `);
  await db.execute(sql`
    insert into journal_lines
      (id, org_id, entry_id, line_number, account_id, amount, currency, txn_amount, subsidiary_id)
    values (${randomUUID()}, ${orgId}, ${elimEntryId}, 1, ${accounts.bank}, '10.0000', 'CAD', '10.0000', ${subsidiaryId}),
           (${randomUUID()}, ${orgId}, ${elimEntryId}, 2, ${accounts.revenue}, '-10.0000', 'CAD', '-10.0000', ${subsidiaryId})
  `);
  await db.execute(sql`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId} where id = ${elimEntryId}`);
  await db.execute(sql`
    insert into ownership_consolidation_entries (org_id, run_id, interest_id, kind, journal_entry_id)
    values (${orgId}, ${runId}, ${interestId}, 'acquisition', ${elimEntryId})
  `);
  return { periodId: period.id, childId };
}

test('fx reads and revaluation run through the engine tables', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    const { periodId, childId } = await withBypassContext(() => seedFx(org.orgId, org.subsidiaryId, actors.adminId, org.accounts));
    const reader = {
      user: userFor(org.orgId, actors.adminId),
      permissions: new Set(['assistant.use', 'gl.read', 'close.read']),
      allowedSubsidiaryIds: null,
    };
    await withOrgContext(org.orgId, async () => {
      const currencies = await executeAssistantTool(
        { ...reader, permissions: new Set(['assistant.use']) }, 'list_currencies', {},
      );
      assert.equal(currencies.ok, true, JSON.stringify(currencies));
      assert.ok(currencies.ok);
      assert.equal((currencies.data as { baseCurrency: string }).baseCurrency, 'CAD');
      assert.ok((currencies.data as { total: number }).total >= 40);

      const rates = await executeAssistantTool(reader, 'list_fx_rates', { fromCurrency: 'USD', toCurrency: 'CAD' });
      assert.equal(rates.ok, true, JSON.stringify(rates));
      assert.ok(rates.ok);
      const rateRows = (rates.data as { rates: { rate: string; source: string }[] }).rates;
      assert.equal(rateRows.length, 1);
      assert.equal(rateRows[0]!.rate, '1.4000000000');
      assert.equal(rateRows[0]!.source, 'manual');

      const applicationRates = await listApplicationFxRates(
        appCtx(org.orgId, actors.adminId, ['gl.read']),
        { fromCurrency: 'USD', toCurrency: 'CAD' },
      );
      assert.equal(applicationRates.total, 1);
      assert.deepEqual(applicationRates.rates.map(({ asOf, rateType, rate, source }) => [asOf, rateType, rate, source]), [
        ['2026-07-31', 'spot', '1.4000000000', 'manual'],
      ]);
      await assert.rejects(
        listApplicationFxRates(appCtx(org.orgId, actors.adminId, ['gl.read']), {
          fromCurrency: 'US', toCurrency: 'CAD',
        }),
        (error: unknown) => error instanceof ApplicationError
          && error.code === 'invalid_input'
          && error.message.includes('fromCurrency and toCurrency must be ISO 4217 codes'),
      );

      // The governed run posts the adjustment plus its next-period mirror;
      // the rerun is incremental (nothing new).
      const app = appCtx(org.orgId, actors.adminId, ['close.run']);
      const first = await executeApplicationTool(applicationTool('run_revaluation')!, app, {
        periodId, idempotencyKey: 'a05-reval-run-1',
      }) as { replayed: boolean; result: { posted: { entryId: string; reversalEntryId: string }[] } };
      assert.equal(first.replayed, false);
      assert.equal(first.result.posted.length, 1);
      assert.ok(first.result.posted[0]!.entryId);
      assert.ok(first.result.posted[0]!.reversalEntryId);
      const second = await executeApplicationTool(applicationTool('run_revaluation')!, app, {
        periodId, idempotencyKey: 'a05-reval-run-2',
      }) as { result: { posted: unknown[] } };
      assert.deepEqual(second.result.posted, []);

      const revals = await executeAssistantTool(reader, 'list_fx_revaluations', { periodId });
      assert.equal(revals.ok, true, JSON.stringify(revals));
      assert.ok(revals.ok);
      const revalData = revals.data as {
        total: number; items: { entryNumber: string; mirrorEntryNumber: string | null }[];
      };
      // The period filter keeps the adjustment; its next-period mirror lives
      // in 2026-08 and resolves through the mirror link.
      assert.equal(revalData.total, 1);
      const adjustment = revalData.items.find((i) => !i.entryNumber.endsWith('-R'));
      assert.ok(adjustment, 'adjustment entry present');
      assert.ok(adjustment.mirrorEntryNumber?.endsWith('-R'), 'adjustment links its mirror');
      const unfiltered = await executeAssistantTool(reader, 'list_fx_revaluations', {});
      assert.equal(unfiltered.ok, true, JSON.stringify(unfiltered));
      assert.ok(unfiltered.ok);
      assert.equal((unfiltered.data as { total: number }).total, 2);

      const view = await executeAssistantTool(reader, 'get_consolidation_view', { periodId });
      assert.equal(view.ok, true, JSON.stringify(view));
      assert.ok(view.ok);
      const viewData = view.data as {
        rates: { fromCurrency: string; currentRate: string }[];
        runs: { status: string }[];
        entries: { kind: string; entryNumber: string }[];
      };
      assert.deepEqual(viewData.rates.map((r) => [r.fromCurrency, r.currentRate]), [['EUR', '1.5000000000']]);
      assert.deepEqual(viewData.runs.map((r) => r.status), ['posted']);
      assert.deepEqual(viewData.entries.map((e) => [e.kind, e.entryNumber]), [['acquisition', 'JE-ELIM-1']]);
    });

    // A caller restricted to the child entity sees no root revaluations and
    // none of the org-wide consolidation diagnostics.
    const childReader = {
      user: userFor(org.orgId, actors.adminId),
      permissions: new Set(['assistant.use', 'gl.read', 'close.read']),
      allowedSubsidiaryIds: new Set([childId]),
    };
    await withOrgContext(org.orgId, async () => {
      const revals = await executeAssistantTool(childReader, 'list_fx_revaluations', {});
      assert.equal(revals.ok, true, JSON.stringify(revals));
      assert.ok(revals.ok);
      assert.equal((revals.data as { total: number }).total, 0);
      assert.deepEqual(await executeAssistantTool(childReader, 'get_consolidation_view', { periodId }), {
        ok: false, error: 'forbidden',
      });
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test('fx tools refuse without permission, with the module off, or across orgs', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  const other = await withBypassContext(() => createScratchOrg());
  try {
    const actors = await withBypassContext(() => seedFlowActors(org.orgId));
    const { periodId } = await withBypassContext(() => seedFx(org.orgId, org.subsidiaryId, actors.adminId, org.accounts));
    const reader = {
      user: userFor(org.orgId, actors.adminId),
      permissions: new Set(['assistant.use', 'gl.read', 'close.read']),
      allowedSubsidiaryIds: null,
    };
    await withOrgContext(org.orgId, async () => {
      const naked = { ...reader, permissions: new Set(['assistant.use']) };
      for (const [name, args] of [
        ['list_fx_rates', { fromCurrency: 'USD', toCurrency: 'CAD' }],
        ['list_fx_revaluations', {}],
        ['get_consolidation_view', { periodId }],
      ] as const) {
        assert.deepEqual(await executeAssistantTool(naked, name, args), { ok: false, error: 'forbidden' });
      }
      // Unknown periods report problems with nothing posted — the engine
      // contract, surfaced unchanged.
      const app = appCtx(org.orgId, actors.adminId, ['close.run']);
      const unknown = await executeApplicationTool(applicationTool('run_revaluation')!, app, {
        periodId: randomUUID(), idempotencyKey: 'a05-reval-unknown-1',
      }) as { result: { posted: unknown[]; problems: string[] } };
      assert.deepEqual(unknown.result.posted, []);
      assert.ok(unknown.result.problems.length > 0);
      await assert.rejects(
        executeApplicationTool(applicationTool('run_revaluation')!, appCtx(org.orgId, actors.adminId, []), {
          periodId, idempotencyKey: 'a05-reval-noperm-1',
        }),
        /forbidden/,
      );
    });
    await withBypassContext(() => db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"multiCurrency":false}'::jsonb, true)
       where id = ${org.orgId}
    `));
    await withOrgContext(org.orgId, async () => {
      assert.deepEqual(await executeAssistantTool(reader, 'list_fx_rates', { fromCurrency: 'USD', toCurrency: 'CAD' }), {
        ok: false, error: 'multi_currency_feature_disabled',
      });
      await assert.rejects(
        listApplicationFxRates(appCtx(org.orgId, actors.adminId, ['gl.read']), {
          fromCurrency: 'USD', toCurrency: 'CAD',
        }),
        (error: unknown) => error instanceof ApplicationError
          && error.code === 'not_found'
          && error.status === 404
          && error.message === 'multiCurrency is off; enable it from GET /api/v1/settings/features',
      );
      await assert.rejects(
        executeApplicationTool(applicationTool('run_revaluation')!, appCtx(org.orgId, actors.adminId, ['close.run']), {
          periodId, idempotencyKey: 'a05-reval-off-1',
        }),
        /revaluation not found/,
      );
    });
    // Another org's period reads as missing; its rates never leak.
    const otherActors = await withBypassContext(() => seedFlowActors(other.orgId));
    const otherReader = {
      user: userFor(other.orgId, otherActors.adminId),
      permissions: new Set(['assistant.use', 'gl.read', 'close.read']),
      allowedSubsidiaryIds: null,
    };
    await withOrgContext(other.orgId, async () => {
      assert.deepEqual(await executeAssistantTool(otherReader, 'get_consolidation_view', { periodId }), {
        ok: false, error: 'period_not_found',
      });
      const rates = await executeAssistantTool(otherReader, 'list_fx_rates', { fromCurrency: 'USD', toCurrency: 'CAD' });
      // The other org never touched foreign currency, so its own fence fires
      // first — and either way no rate row from the first org leaks.
      assert.deepEqual(rates, { ok: false, error: 'multi_currency_feature_disabled' });
    });
  } finally {
    await dropScratchOrg(org.orgId);
    await dropScratchOrg(other.orgId);
  }
});
