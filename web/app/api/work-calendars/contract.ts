import { z } from 'zod';
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/iso-date.ts';
const date = z.string().refine(isIsoCalendarDate, 'Enter a valid calendar date.');
export const WorkCalendarBody = z.object({
  name: z.string().trim().min(1).max(120), description: z.string().max(2000).nullable().optional(), isDefault: z.boolean(),
  workingDays: z.object({ '0': z.boolean(), '1': z.boolean(), '2': z.boolean(), '3': z.boolean(), '4': z.boolean(), '5': z.boolean(), '6': z.boolean() }).strict(),
  holidays: z.array(z.object({ date }).strict()).max(1000).transform(rows => rows.map(row => row.date)),
  reason: z.string().trim().min(5).max(500),
}).strict();
