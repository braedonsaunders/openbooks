import {
  postingPreconditionHooks,
  type PostingPreconditions,
} from "../journal/posting-preconditions.ts";
import { promoteCrmAccount } from "./crm.ts";

const preconditions: PostingPreconditions["crm"] = {
  establishCustomerRole: (executor, input) =>
    promoteCrmAccount(executor, { ...input, toStage: "customer" }),
};

/** A receivable document makes its party a customer, with CRM on or off. */
export function registerCrmPostingContributors(): void {
  postingPreconditionHooks.register("crm", preconditions);
}
