import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createScheduleDependency, createScheduleTask, deleteScheduleBaseline, deleteScheduleDependency, ScheduleError } = await import('./project-schedule')

const enabled = { skip: !process.env.OPENBOOKS_DB_URL }

/** Invalid scheduling inputs fail as domain errors before PostgreSQL writes. */
test('schedule dependency and task-creation inputs fail closed', enabled, async () => {
  await withBypassContext(async () => {
    const org = await createScratchOrg()
    try {
      const actor = await createScratchUser(org.orgId, 'Project administrator', 'reviewer')
      await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"projectScheduling":true}'::jsonb) where id = ${org.orgId}`)
      const project = randomUUID()
      await db.execute(sql`
        insert into projects (id, org_id, subsidiary_id, name, code)
        values (${project}, ${org.orgId}, ${org.subsidiaryId}, 'Dependency inputs project', ${project})`)
      const taskA = await createScheduleTask(org.orgId, project, { name: 'Task A' }, actor, null)
      const taskB = await createScheduleTask(org.orgId, project, { name: 'Task B' }, actor, null)

      for (const [attempt, reason] of [
        [() => createScheduleDependency(org.orgId, project, { predecessorId: taskA, successorId: taskB, type: 'XX' }, actor, null), /dependency type/i],
        [() => createScheduleDependency(org.orgId, project, { predecessorId: taskA, successorId: taskB, lagDays: 1e30 }, actor, null), /lag/i],
        [() => createScheduleTask(org.orgId, project, { name: 'Bad order', order: 'oops' as unknown as number }, actor, null), /order/i],
      ] as const) {
        await assert.rejects(attempt(), (error: unknown) => error instanceof ScheduleError && reason.test(error.message))
      }
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from schedule_dependencies where org_id=${org.orgId}`)).rows[0]!.n, 0)

      // Legal values still persist.
      await createScheduleDependency(org.orgId, project, { predecessorId: taskA, successorId: taskB, type: 'SS', lagDays: -2 }, actor, null)
      await createScheduleTask(org.orgId, project, { name: 'Good order', order: 3 }, actor, null)
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from schedule_dependencies where org_id=${org.orgId}`)).rows[0]!.n, 1)

      const otherProject = randomUUID()
      const baseline = randomUUID()
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, name, code) values (${otherProject}, ${org.orgId}, ${org.subsidiaryId}, 'Other project', ${otherProject})`)
      await db.execute(sql`insert into schedule_baselines (id, org_id, project_id, name) values (${baseline}, ${org.orgId}, ${otherProject}, 'Other project baseline')`)
      await db.execute(sql`insert into schedule_baseline_tasks (org_id, baseline_id, task_id, task_name) values (${org.orgId}, ${baseline}, ${taskA}, 'Pinned snapshot')`)
      await assert.rejects(deleteScheduleBaseline(org.orgId, project, baseline, null),
        (error: unknown) => error instanceof ScheduleError && error.status === 404)
      assert.equal((await db.execute<{ n: number }>(sql`select count(*)::int as n from schedule_baseline_tasks where baseline_id=${baseline}`)).rows[0]!.n, 1)
      await assert.rejects(deleteScheduleDependency(org.orgId, project, randomUUID(), null),
        (error: unknown) => error instanceof ScheduleError && error.status === 404)
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
})


const consolidatedRows = [
  { label: "project schedule feature gate", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { createScheduleTask, ScheduleError } = await import('./project-schedule')
        
        test('project schedule service refuses direct task creation when scheduling is disabled', { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const actor = await createScratchUser(org.orgId, 'Project administrator', 'reviewer')
              const projectId = randomUUID()
              await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,projectScheduling}', 'false'::jsonb, true) where id = ${org.orgId}`)
              await db.execute(sql`
                insert into projects (id, org_id, subsidiary_id, name, code)
                values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'Schedule gate project', ${projectId})
              `)
        
              await assert.rejects(
                createScheduleTask(org.orgId, projectId, { name: 'Should not persist' }, actor, null),
                (error: unknown) => error instanceof ScheduleError && error.status === 404 && /project scheduling feature is disabled/i.test(error.message),
              )
              assert.equal(
                (await db.execute<{ n: number }>(sql`select count(*)::int as n from project_tasks where org_id=${org.orgId} and project_id=${projectId}`)).rows[0]!.n,
                0,
              )
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
  } },
  { label: "project schedule parent validation", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { updateScheduleTask, ScheduleError } = await import('./project-schedule')
        
        const enabled = { skip: !process.env.OPENBOOKS_DB_URL }
        
        /**
         * The task outline is a project-bounded tree. A parent pin must name a task
         * in the SAME project, never the task itself, and never a descendant —
         * otherwise the outline silently corrupts (cross-project ghosts, self loops,
         * ancestor cycles) while the module promises project-bounded writes.
         */
        test('schedule parent pins stay inside the project tree', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const actor = await createScratchUser(org.orgId, 'Project administrator', 'reviewer')
              await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}',
                coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"projectScheduling":true}'::jsonb) where id = ${org.orgId}`)
              const projectA = randomUUID(), projectB = randomUUID()
              for (const [id, code] of [[projectA, 'TREE-A'], [projectB, 'TREE-B']] as const) {
                await db.execute(sql`
                  insert into projects (id, org_id, subsidiary_id, name, code)
                  values (${id}, ${org.orgId}, ${org.subsidiaryId}, ${code}, ${id})`)
              }
              const taskA = randomUUID(), taskB = randomUUID(), foreign = randomUUID()
              for (const [id, project, name] of [
                [taskA, projectA, 'Task A'],
                [taskB, projectA, 'Task B'],
                [foreign, projectB, 'Foreign task'],
              ] as const) {
                await db.execute(sql`
                  insert into project_tasks (id, org_id, project_id, name, schedule_order)
                  values (${id}, ${org.orgId}, ${project}, ${name}, 1)`)
              }
              const parentOf = async (id: string) =>
                (await db.execute<{ parent_id: string | null }>(sql`
                  select parent_id from project_tasks where id = ${id} and org_id = ${org.orgId}`)).rows[0]!.parent_id
        
              // A task cannot parent to itself.
              await assert.rejects(
                updateScheduleTask(org.orgId, projectA, taskA, { parentTaskId: taskA }, actor, null),
                (error: unknown) => error instanceof ScheduleError && /parent/i.test(error.message),
              )
              assert.equal(await parentOf(taskA), null)
        
              // A parent must live in the same project.
              await assert.rejects(
                updateScheduleTask(org.orgId, projectA, taskA, { parentTaskId: foreign }, actor, null),
                (error: unknown) => error instanceof ScheduleError && /parent/i.test(error.message),
              )
              assert.equal(await parentOf(taskA), null)
        
              // A same-project parent applies, but closing the loop back must fail.
              await updateScheduleTask(org.orgId, projectA, taskA, { parentTaskId: taskB }, actor, null)
              assert.equal(await parentOf(taskA), taskB)
              await assert.rejects(
                updateScheduleTask(org.orgId, projectA, taskB, { parentTaskId: taskA }, actor, null),
                (error: unknown) => error instanceof ScheduleError && /parent/i.test(error.message),
              )
              assert.equal(await parentOf(taskB), null)
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
  } },
  { label: "project schedule patch validation", register: async () => {
        const assert = (await import("node:assert/strict")).default;
        const { randomUUID } = await import("node:crypto");
        const test = (await import("node:test")).default;
        const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
        const { sql } = await import('drizzle-orm')
        const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
        const { updateScheduleTask, ScheduleError } = await import('./project-schedule')
        
        const enabled = { skip: !process.env.OPENBOOKS_DB_URL }
        
        /**
         * Schedule patch values are interpolated into DATE and UUID columns. An
         * impossible calendar day or a malformed resource id must fail closed as a
         * domain error before any write — never escape as a PostgreSQL error (a 500).
         */
        test('schedule task patches refuse impossible dates and malformed resource ids', enabled, async () => {
          await withBypassContext(async () => {
            const org = await createScratchOrg()
            try {
              const actor = await createScratchUser(org.orgId, 'Project administrator', 'reviewer')
              await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}',
                coalesce(settings->'features','{}'::jsonb)||'{"projects":true,"projectScheduling":true}'::jsonb) where id = ${org.orgId}`)
              const projectId = randomUUID(), taskId = randomUUID()
              await db.execute(sql`
                insert into projects (id, org_id, subsidiary_id, name, code)
                values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'Patch validation project', ${projectId})
              `)
              await db.execute(sql`
                insert into project_tasks (id, org_id, project_id, name, schedule_order)
                values (${taskId}, ${org.orgId}, ${projectId}, 'Patchable task', 1)
              `)
        
              await assert.rejects(
                updateScheduleTask(org.orgId, projectId, taskId, { startDate: '2026-02-30' }, actor, null),
                (error: unknown) => error instanceof ScheduleError && /valid date/.test(error.message),
              )
              await assert.rejects(
                updateScheduleTask(org.orgId, projectId, taskId, { resourceAssignments: [{ resourceId: 'not-a-uuid', units: 1 }] }, actor, null),
                (error: unknown) => error instanceof ScheduleError && /valid resource/.test(error.message),
              )
              const untouched = (await db.execute<{ start: string | null; n: number }>(sql`
                select schedule_start::text as start,
                       (select count(*)::int from schedule_task_assignments where org_id=${org.orgId} and task_id=${taskId}) as n
                  from project_tasks where id=${taskId} and org_id=${org.orgId}`)).rows[0]!
              assert.equal(untouched.start, null)
              assert.equal(untouched.n, 0)
        
              // Real values still apply.
              await updateScheduleTask(org.orgId, projectId, taskId, { startDate: '2026-02-27', endDate: '2026-02-28' }, actor, null)
              assert.equal((await db.execute<{ start: string }>(sql`
                select schedule_start::text as start from project_tasks where id=${taskId} and org_id=${org.orgId}`)).rows[0]!.start, '2026-02-27')
            } finally {
              await dropScratchOrg(org.orgId)
            }
          })
        })
  } },
] as const;

for (const row of consolidatedRows) await row.register();
