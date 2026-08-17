# Payroll country packs

A pack is a jurisdiction's statutory engine plus its DECLARATIONS. Nothing in the
generic payroll layer branches on a country: it reads what the pack declares, and
where a pack has not declared something, it refuses by name rather than
approximating (`.local/handoff-multicountry.md`, `packs.ts`).

| Declaration | Lives in | Read by |
| --- | --- | --- |
| Statutory slots, components, regions, holidays, tax-year definition | `packs.ts` | seeding, posting, readiness |
| Filings, program types, separation mapping | `{canada,us}/filings.ts` → `payroll-filing-registry.ts` | year-end, ROE/T4/W-2 surfaces |
| **Editions — which tax years are loaded** | `{canada,us}/rates.ts` → `tax-years.ts` | pay-run readiness, setup, year-end, the rollover scaffold |
| **Tenant-entered rates and their SCOPE** | `{canada,us}/rates.ts` → `statutory-rates.ts` | `payroll_statutory_rates`, the Statutory Rates setup tab, the engine's resolution |

## Published constants vs. tenant-entered rates

Two different things, and conflating them is money:

- **Published constants** — brackets, contribution maximums, credit amounts, the
  wage bases an agency prints. They live in the pack's edition modules, are
  versioned by publication, and no tenant may edit them.
- **Tenant-entered rates** — the ones no publication can supply, or that agencies
  publish per region or per registered account. A pack declares each one as a
  `PayrollStatutoryRateSlot` with a required `scope`:

  | Scope | Means | Example |
  | --- | --- | --- |
  | `org` | one value for the whole employer | (none today — most "org-wide" statutory rates turn out to be regional) |
  | `region` | one value per province/state | the FUTA credit reduction (USDOL publishes it per state per year); provincial employer health levies |
  | `filing_account` | one value per registered account, with a region-wide row as the default every account uses | an experience-rated SUI rate — a two-EIN employer in one state holds two |

  Values live in `payroll_statutory_rates`, keyed by scope point **and tax year**,
  and are read through `resolveStatutoryRates`. A pack may declare a `legacyRows`
  reader for its pre-scoping `orgs.settings.payroll` shape; that fallback is
  READ-ONLY, so a tenant configured before scoping existed calculates
  byte-identically and there is still exactly one writable home.

## Adding a tax year

Every statutory engine refuses a pay date outside the years it has transcribed.
That is deliberate: withholding January 2027 from 2026 tables is silent wrong
money on every stub. So the rollover is a real annual task, and it has a
generator:

```
npx tsx scripts/payroll-new-tax-year.ts --list
npx tsx scripts/payroll-new-tax-year.ts --country CA --year 2027 --dry-run
npx tsx scripts/payroll-new-tax-year.ts --country CA --year 2027
```

The generator reads the pack's own `scaffold` declaration and writes:

1. **a year module per publication the year needs** — for CA that is T4127 *and*
   Revenu Québec's TP-1015.F-V, because Quebec publishes its own tables and a CA
   year is not loaded for a Quebec employee until both exist. Every figure is the
   `UNFILLED` sentinel and the edition is `status: "draft"`;
2. **a failing conformance stub per publication**, which asserts that no
   placeholder remains, that the edition is published, and that real goldens from
   the publication have been pasted in;
3. **the generated editions barrel**, rewritten from the year modules on disk —
   so the year is wired in without editing a hand-maintained list.

While the edition is a draft:

- `ratesForPayDate` / `qcRatesForPayDate` refuse it, naming the module and the
  fact that placeholders remain — distinct from the refusal for a year nobody has
  scaffolded at all;
- `payRunReadiness` blocks a run in that year (`statutory.taxYear`) and
  `payrollSetupState` fails `setup.taxYear`, both quoting the year and the pack;
- the year-end surface refuses every one of the pack's filings for that year, by
  name;
- the generated stubs fail.

Then, in the order the pack's declaration prints:

1. fetch the publications (from the agency, never from memory, never by indexing
   last year's numbers forward);
2. replace every `UNFILLED`, keeping each published figure's exact scale;
3. cross-verify arithmetically — the CRA's own K1/K1P columns, each province's
   constant K against the cumulative bracket arithmetic, tentative amounts
   against the cumulative tax of prior brackets;
4. paste the published goldens into the stubs;
5. flip the editions to `"published"` and run the payroll suite.

**The 2026 goldens must not move.** T4127, Pub 15-T and TP-1015 conformance
values are external evidence; if adding a year changes one of them, the change is
wrong. Run:

```
OPENBOOKS_TRUSTED_TEST_BYPASS=1 node --import tsx \
  --import ./engine/src/test-database-bypass.ts --test --test-force-exit \
  'engine/src/payroll*.test.ts' 'engine/src/payroll/**/*.test.ts'
```

A mid-year delta edition (the CRA's July editions) is a second year module:
re-run the generator and give it a July `effectiveFrom`, carrying forward
everything the delta edition does not restate.
