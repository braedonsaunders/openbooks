import { z } from 'zod';
import { isoDate } from '@/lib/api/json';
export const InspectionPlanBody=z.object({name:z.string().trim().min(1).max(200),itemId:z.string().uuid(),point:z.enum(['receipt','operation']),operationSequence:z.number().int().positive().nullable().optional(),effectiveFrom:isoDate(),effectiveTo:isoDate().nullable().optional(),measures:z.array(z.object({key:z.string(),label:z.string(),unit:z.string(),required:z.boolean(),minimum:z.string().nullable().optional(),maximum:z.string().nullable().optional()}).strict()).max(100),reason:z.string().trim().min(5).max(500)}).strict();
