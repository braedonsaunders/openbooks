import type pg from 'pg';

export type BaselineBusinessOwnerPlan = {
  owner: 'openbooks_schema_owner';
  runtimeRole: string;
  createRole: boolean;
  previousOwners: string[];
  objectCount: number;
  statements: string[];
};

export type BaselineBusinessOwnerResult = {
  owner: 'openbooks_schema_owner';
  runtimeRole: string;
  previousOwners: string[];
  objectCount: number;
  changedObjects: number;
};

export function baselineBusinessOwnerPlan(
  client: Pick<pg.Client, 'query'>,
  runtimeRole: string,
): Promise<BaselineBusinessOwnerPlan>;

export function applyBaselineBusinessOwnerPlan(
  client: Pick<pg.Client, 'query'>,
  plan: BaselineBusinessOwnerPlan,
): Promise<BaselineBusinessOwnerResult>;
