import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { uuidId } from '@/lib/api/json'
import {
  listTemplateDocuments,
  saveTemplateDocument,
} from '@openbooks/engine/hrm/performance'
import { performanceErrorResponse } from '../../review-cycles/_lib'
export const runtime = 'nodejs'
const question = z
  .object({
    id: uuidId,
    prompt: z.string().max(2000),
    answerKind: z.enum(['text', 'rating', 'rating_and_text']),
    required: z.boolean(),
  })
  .strict()
const document = z
  .object({
    name: z.string().trim().min(1).max(240),
    instructions: z.string().max(8000),
    ratingScale: z
      .object({
        min: z.string(),
        max: z.string(),
        labels: z.array(z.string()).max(100),
      })
      .strict(),
    sections: z
      .array(
        z
          .object({
            id: uuidId,
            title: z.string().max(240),
            kind: z.enum(['competency', 'goals', 'free_text']),
            weight: z.string().nullable().optional(),
            competencyId: uuidId.nullable().optional(),
            questions: z.array(question).max(500),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
export const GET = defineRoute({
  public: 'session',
  feature: 'hrmPerformance',
  handler: async ({ authz }) => {
    try {
      return NextResponse.json({
        templates: await listTemplateDocuments({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
        }),
      })
    } catch (error) {
      return performanceErrorResponse(error)
    }
  },
})
export const POST = defineRoute({
  public: 'session',
  feature: 'hrmPerformance',
  scope: 'unrestricted',
  body: z
    .object({
      id: uuidId.optional(),
      revision: z.number().int().positive().optional(),
      document,
      publish: z.boolean(),
      isActive: z.boolean().optional(),
    })
    .strict(),
  handler: async ({ authz, body }) => {
    try {
      return NextResponse.json({
        template: await saveTemplateDocument({
          ...body,
          orgId: authz.user.orgId,
          actorId: authz.user.id,
        }),
      })
    } catch (error) {
      return performanceErrorResponse(error)
    }
  },
})
