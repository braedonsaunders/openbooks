import assert from "node:assert/strict";
import test from "node:test";
import { productionJourney } from "./journey.ts";

test("partial receipt remains open until all expected good output is accounted for", () => {
  const input = {status:"in_progress",routingVersion:1,quantityOrdered:"10",quantityCompleted:"3",quantityScrapped:"2",operations:[{status:"done"}]};
  assert.equal(productionJourney(input).remaining, "5.0000");
  assert.equal(productionJourney(input).receipt, "partial");
  assert.equal(productionJourney(input).received, false);
  assert.equal(productionJourney({...input,quantityCompleted:"8"}).received, true);
  assert.equal(productionJourney({...input,status:"done"}).receipt, "shortClosed");
});
test("cancelled and held work never imply successful completion; all loss is not a goods receipt", () => {
  const input = {status:"cancelled",routingVersion:1,quantityOrdered:"10",quantityCompleted:"10",quantityScrapped:"0",operations:[{status:"done"}]};
  const cancelled=productionJourney(input);
  assert.equal(cancelled.planned,false);assert.equal(cancelled.made,false);assert.equal(cancelled.received,false);assert.equal(cancelled.finished,false);
  const held=productionJourney({...input,status:"on_hold",quantityCompleted:"0"});
  assert.equal(held.planned,true);assert.equal(held.blocked,true);assert.equal(held.finished,false);
  const lost=productionJourney({...input,status:"in_progress",quantityCompleted:"0",quantityScrapped:"10"});
  assert.equal(lost.received,false);assert.equal(lost.allLoss,true);assert.equal(lost.receipt,'loss');assert.equal(lost.blocked,true);
});
