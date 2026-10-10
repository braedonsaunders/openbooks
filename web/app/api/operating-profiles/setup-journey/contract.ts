import { z } from 'zod';
import { exactMoney } from '@/lib/api/json';

export const SetupJourneyBody=z.object({family:z.enum(['project','production']),selection:z.string().min(1).max(100),departmentId:z.string().uuid().optional(),itemId:z.string().uuid().optional(),subsidiaryId:z.string().uuid().optional(),quantity:exactMoney().optional()}).strict();
