import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";
import { baselineTransitionCandidate, baselineTransitionCatalogMatches } from "./migration-baseline-transitions.ts";
import contract from "./migration-baseline-transitions.json" with { type: "json" };

const read = (file: string) => readFileSync(new URL(`../schema/migrations/${file}`,import.meta.url),"utf8");
const manifest = JSON.parse(read("baseline.json"));
const expected = JSON.parse(read(`${manifest.filename}.catalog.json`));
const recorded = new Map<string,string>([[manifest.filename,manifest.baselineSha256]]);
const migration = "generated/0626_tenant_retirement.sql";
const published = new Map([migration,...Object.keys(contract.consumers[migration].prerequisites)]
  .map(file => [file,read(file)]));
const input = { migration, consumerSql:read("preflight/0626_tenant_retirement.sql"),published,
  pendingBeforeConsumer:new Set(Object.keys(contract.consumers[migration].prerequisites)),
  findings:[{migration,code:"0626.guard_body_changed",severity:"refuse" as const,
    subject:"trg_application_open_balance",detail:"0580_clone_preserves_recorded_document_balances.sql",remedy:"Reconcile published guard"}] };

test("baseline deferral requires the complete recorded catalog and all pinned pending publishers", () => {
  assert.equal(baselineTransitionCandidate(input),true);
  assert.equal(baselineTransitionCatalogMatches(manifest,recorded,expected,expected),true);
  for(const filename of published.keys()) {
    const changed=new Map(published);changed.set(filename,changed.get(filename)!+"\n");
    assert.equal(baselineTransitionCandidate({...input,published:changed}),false,filename);
  }
  assert.equal(baselineTransitionCandidate({...input,pendingBeforeConsumer:new Set()}),false);
  assert.equal(baselineTransitionCandidate({...input,consumerSql:input.consumerSql+"\n"}),false);
  assert.equal(baselineTransitionCandidate({...input,findings:[{...input.findings[0]!,code:"0626.retained_data_conflict"}]}),false);
  assert.equal(baselineTransitionCandidate({...input,findings:[]}),false);
});

test("partial upgrade, altered ledger, SQL body, policy and registry retain refusal", () => {
  assert.equal(baselineTransitionCatalogMatches(manifest,new Map(),expected,expected),false);
  const publisher="generated/0580_clone_preserves_recorded_document_balances.sql";
  const hash=createHash("sha256").update(read(publisher)).digest("hex");
  assert.equal(baselineTransitionCatalogMatches(manifest,new Map([...recorded,[publisher,hash]]),expected,expected),false);
  assert.equal(baselineTransitionCatalogMatches(manifest,new Map([[manifest.filename,"0".repeat(64)]]),expected,expected),false);
  for(const section of ["functions","policies","openbooks_query_catalog_relations"]) {
    const actual=structuredClone(expected);actual[section][0]={...actual[section][0],definition:"altered"};
    assert.equal(baselineTransitionCatalogMatches(manifest,recorded,expected,actual),false,section);
  }
});

test("unknown delete triggers remain refused even on a verified baseline", () => {
  const row={...input.findings[0]!,code:"0626.unknown_delete_trigger",
    subject:"wip_prebill_events.wip_prebill_event_append_only",detail:"wip_prebill_event_append_only_guard"};
  assert.equal(baselineTransitionCandidate({...input,findings:[row]}),true);
  assert.equal(baselineTransitionCandidate({...input,findings:[{...row,subject:"documents.custom_delete"}]}),false);
  assert.equal(baselineTransitionCandidate({...input,findings:[{...row,detail:"custom_guard"}]}),false);
});
