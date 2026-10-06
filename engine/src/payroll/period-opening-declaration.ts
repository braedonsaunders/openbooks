import { createHash } from 'node:crypto';
import { cmp, sum } from '../money/money.ts';
import { PayrollError } from './error.ts';
import { normalizePeriodOpeningAmounts, type PayrollPeriodOpeningField } from './period-opening-contract.ts';

export interface PayrollPeriodOpeningTreatment {
  fields: readonly PayrollPeriodOpeningField[];
  /** Disjoint input shares already included in the authoritative annual field. */
  annualBounds: readonly { annualOpeningKey: string; fieldKeys: readonly string[]; label: string }[];
  /** Pack-owned subset relationships, such as enhanced contributions within total contributions. */
  amountBounds?: readonly { fieldKeys: readonly string[]; withinFieldKeys: readonly string[]; label: string }[];
}

export function periodOpeningContractHash(treatment: PayrollPeriodOpeningTreatment): string {
  return createHash('sha256').update(JSON.stringify(treatment)).digest('hex');
}

export function declaredPeriodOpening(input: {
  country: string; treatment: PayrollPeriodOpeningTreatment; amounts: unknown; currencyMinorUnits: number;
}): { amounts: Record<string, string>; annualBounds: Record<string, string> } {
  const { treatment } = input;
  const amounts = normalizePeriodOpeningAmounts({ ...input, fields: treatment.fields });
  const keys = new Set(treatment.fields.map((field) => field.key));
  const total = (members: readonly string[]) => {
    if (!members.length || new Set(members).size !== members.length || members.some((key) => !keys.has(key))) {
      throw new PayrollError(`${input.country} has an invalid period-opening bound — correct its pack declaration`);
    }
    return sum(members.map((key) => amounts[key]!));
  };
  const annualBounds: Record<string, string> = {};
  for (const bound of treatment.annualBounds) {
    if (!/^[A-Za-z][A-Za-z0-9_:]*$/.test(bound.annualOpeningKey) || ['constructor', 'prototype'].includes(bound.annualOpeningKey)
      || Object.hasOwn(annualBounds, bound.annualOpeningKey)) {
      throw new PayrollError(`${input.country} has an invalid annual period-opening bound — correct its pack declaration`);
    }
    annualBounds[bound.annualOpeningKey] = total(bound.fieldKeys);
  }
  if (!Object.keys(annualBounds).length) throw new PayrollError(`${input.country} must declare how period openings fit within annual carry-in`);
  for (const bound of treatment.amountBounds ?? []) {
    if (cmp(total(bound.fieldKeys), total(bound.withinFieldKeys)) > 0) {
      throw new PayrollError(`${bound.label} cannot exceed the corresponding period amounts — review the previous provider's calculation evidence`);
    }
  }
  return { amounts, annualBounds };
}
