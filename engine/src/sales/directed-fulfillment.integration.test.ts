import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  db,
  withBypassContext,
  withOrg,
  withOrgTransaction,
} from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedApprovalFlow,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import {
  createWarehouseOperator,
  confirmFixturePick,
  packFixtureShipment,
} from "../testing/warehouse-execution.ts";
import { receiveInventory } from "../inventory/movements.ts";
import { getOnHandWith } from "../inventory/position.ts";
import { activePickReservations } from "../inventory/pick-reservations.ts";
import { confirmExecutionTask } from "../inventory/directed-execution.ts";
import {
  createPickList,
  createShipment,
  getFulfillmentDocument,
  pickCandidates,
} from "./fulfillment.ts";
import {
  releasePickWave,
  setPickDispatchPolicy,
  suggestPickConfirmation,
  executePickDirection,
} from "./pick-execution.ts";
import {
  createHandlingUnit,
  suggestPackConfirmation,
  executePackDirection,
  sealHandlingUnit,
  moveHandlingUnit,
} from "./handling-units.ts";
import {
  assertPackedUnit,
  assertShipmentPacked,
} from "./handling-unit-state.ts";
import { getShipmentRates, buyShipmentLabel } from "./shipping-labels.ts";
import { createSandbox, deleteSandbox } from "../sandbox/lifecycle.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { InventoryError } from "../inventory/contracts.ts";
import { compareDecimal } from "../money/exact-decimal.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const native = <T>(work: () => Promise<T>) => withBypassContext(work);

async function order(
  org: ScratchOrg,
  actor: string,
  number: string,
  quantity: string,
  unit = "ea",
) {
  const id = randomUUID(),
    lineId = randomUUID();
  await native(async () => {
    await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,document_date,currency,status,subsidiary_id,created_by)
      values(${id},${org.orgId},'sales_order',${number},${org.customerId},${org.date},'CAD','draft',${org.subsidiaryId},${actor})`);
    await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,item_id,account_id,description,quantity,unit,unit_price,amount,tax_amount,stock_location_id)
      values(${lineId},${org.orgId},${id},1,${org.items.fifo},${org.accounts.revenue},'Widget',${quantity},${unit},'10','20','0',${org.stockLocationId})`);
    await db.execute(
      sql`update documents set status='approved',subtotal='20',total='20' where org_id=${org.orgId} and id=${id}`,
    );
  });
  const pick = await withOrg(org.orgId, () =>
    db.transaction((tx) =>
      createPickList(tx, org.orgId, actor, {
        salesOrderId: id,
        documentDate: org.date,
        lines: [
          { salesOrderLineId: lineId, binId: org.stockLocationId, quantity },
        ],
        allowedSubsidiaryIds: null,
      }),
    ),
  );
  return { id, lineId, pick };
}

test(
  "waves preserve cutoff, priority and approval gates; short picks release exact reservations without closing order lines",
  { skip: !DB },
  async () => {
    const org = await native(() => createScratchOrg());
    let scenarioError: unknown;
    try {
      const actor = await native(() =>
        createWarehouseOperator(org.orgId, "Dispatcher"),
      );
      await native(async () => {
        await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)
        ||'{"inventory":true,"orders":true,"warehousing":true,"fulfillment":true,"shippingHub":true}'::jsonb) where id=${org.orgId}`);
        await receiveInventory(org.orgId, actor, {
          itemId: org.items.fifo,
          stockLocationId: org.stockLocationId,
          subsidiaryId: org.subsidiaryId,
          quantity: "40000",
          unitCost: "2",
          date: org.date,
          offsetAccountId: org.accounts.clearing,
        });
      });
      const stockBefore = await native(() => getOnHandWith(db, org.orgId, org.items.fifo, org.stockLocationId));
      await assert.rejects(
        order(org, actor, "SO-DIRECT-PRECISION-REFUSED", "2.00000002"),
        (error: unknown) => error instanceof InventoryError && /cannot be stored exactly with four decimal places/.test(error.message),
      );
      assert.deepEqual(await native(() => getOnHandWith(db, org.orgId, org.items.fifo, org.stockLocationId)), stockBefore);
      assert.equal((await native(() => db.execute(sql`select id from documents
        where org_id=${org.orgId} and kind='pick_list'`))).rows.length, 0,
        "unrepresentable base precision must not create a pick or reservation");
      await native(() => db.execute(sql`update item_inventory_profiles set unit_conversions='{"bulk":10000}'::jsonb
        where org_id=${org.orgId} and item_id=${org.items.fifo}`));
      const first = await order(org, actor, "SO-DIRECT-LOW", "2.00000002", "bulk");
      const second = await order(org, actor, "SO-DIRECT-HIGH", "2");
      const later = await order(org, actor, "SO-DIRECT-LATER", "2");
      const cutoff = `${org.date}T12:00:00Z`;
      await setPickDispatchPolicy(org.orgId, actor, {
        pickListId: first.pick.id,
        priority: 1,
        cutoffAt: cutoff,
      });
      await setPickDispatchPolicy(org.orgId, actor, {
        pickListId: second.pick.id,
        priority: 10,
        cutoffAt: cutoff,
      });
      await setPickDispatchPolicy(org.orgId, actor, {
        pickListId: later.pick.id,
        priority: 100,
        cutoffAt: `${org.date}T13:00:00Z`,
      });
      const input = {
        warehouseId: org.stockLocationId,
        subsidiaryId: org.subsidiaryId,
        pickListIds: [first.pick.id, second.pick.id],
        mode: "priority" as const,
        cutoffAt: cutoff,
        commandKey: randomUUID(),
      };
      await assert.rejects(releasePickWave(org.orgId, actor, {
        ...input, pickListIds: [first.pick.id, second.pick.id, later.pick.id], commandKey: randomUUID(),
      }), ScopeNotFoundError);
      assert.equal((await native(() => db.execute(sql`select id from pick_waves where org_id=${org.orgId}`))).rows.length, 0,
        "a member beyond the cutoff must refuse the whole explicit wave");
      const wave = await releasePickWave(org.orgId, actor, input);
      const members = await native(() =>
        db.execute<{
          pick_list_id: string;
          release_status: string;
        }>(sql`select pick_list_id,release_status
      from pick_wave_members where org_id=${org.orgId} and wave_id=${wave.waveId} order by sequence`),
      );
      assert.deepEqual(members.rows, [
        { pick_list_id: second.pick.id, release_status: "approved" },
        { pick_list_id: first.pick.id, release_status: "approved" },
      ]);
      assert.equal(
        (await releasePickWave(org.orgId, actor, input)).replayed,
        true,
      );
      await assert.rejects(
        releasePickWave(org.orgId, actor, { ...input, mode: "cutoff" }),
        /different release request/,
      );
      await native(() =>
        seedApprovalFlow(org.orgId, {
          subjectKind: "pick_list",
          assignees: [{ type: "submitter" }],
          mode: "any",
        }),
      );
      const gated = await releasePickWave(org.orgId, actor, {
        ...input,
        mode: "cutoff",
        pickListIds: [later.pick.id],
        cutoffAt: `${org.date}T14:00:00Z`,
        commandKey: randomUUID(),
      });
      const pending = await native(() =>
        db.execute<{
          release_status: string;
        }>(sql`select release_status from pick_wave_members
      where org_id=${org.orgId} and wave_id=${gated.waveId}`),
      );
      assert.equal(pending.rows[0]?.release_status, "pending_approval");

      const view = await withOrgTransaction(org.orgId, () =>
        getFulfillmentDocument(db, org.orgId, first.pick.id, null),
      );
      assert.ok(view);
      const pickLine = view.lines[0]!.lineId;
      await assert.rejects(
        suggestPickConfirmation(org.orgId, actor, {
          lineId: pickLine,
          quantity: "2.00000003",
          commandKey: randomUUID(),
        }),
        /between zero/,
      );
      const taskCount = async () => (await native(() => db.execute(sql`select id from warehouse_execution_tasks
        where org_id=${org.orgId} and document_line_id=${pickLine}`))).rows.length;
      const beforeTaskCount = await taskCount();
      await assert.rejects(suggestPickConfirmation(org.orgId, actor, {
        lineId: pickLine, quantity: "1.000000001", reason: "Unrepresentable source precision", commandKey: randomUUID(),
      }), /between zero/);
      const secondView = await withOrgTransaction(org.orgId, () =>
        getFulfillmentDocument(db, org.orgId, second.pick.id, null));
      await assert.rejects(suggestPickConfirmation(org.orgId, actor, {
        lineId: secondView!.lines[0]!.lineId, quantity: "1.00000001",
        reason: "Unrepresentable base precision", commandKey: randomUUID(),
      }), /cannot be stored exactly with four decimal places/);
      assert.equal(await taskCount(), beforeTaskCount, "refusal must not leave suggested work");
      assert.equal((await native(() => db.execute(sql`select id from warehouse_execution_tasks
        where org_id=${org.orgId} and document_line_id=${secondView!.lines[0]!.lineId}`))).rows.length, 0);
      const task = await suggestPickConfirmation(org.orgId, actor, {
        lineId: pickLine,
        quantity: "1.00000001",
        reason: "One unit missing on shelf",
        commandKey: randomUUID(),
      });
      assert.equal(task.quantity, "10000.0001", "conversion retains all eight document places exactly");
      const confirm = () =>
        confirmExecutionTask(
          org.orgId,
          actor,
          { taskId: task.id },
          (tx, current) => executePickDirection(tx, org.orgId, actor, current),
        );
      assert.equal((await confirm()).status, "done");
      const again = await confirm();
      assert.ok(again.status === "done" && again.replayed);
      const execution = (
        await native(() =>
          db.execute<{
            picked_quantity: string;
            short_quantity: string;
          }>(sql`select picked_quantity::text,short_quantity::text
      from pick_execution_lines where org_id=${org.orgId} and line_id=${pickLine}`),
        )
      ).rows[0]!;
      assert.equal(execution.short_quantity, "1.00000001");
      assert.equal(execution.picked_quantity, "1.00000001");
      const held = await withOrgTransaction(org.orgId, () =>
        activePickReservations(db, org.orgId, {
          salesOrderLineIds: [first.lineId],
        }),
      );
      assert.equal(held[0]?.reserved, "1.00000001");
      const candidates = await withOrgTransaction(org.orgId, () =>
        pickCandidates(db, org.orgId, first.id, null),
      );
      assert.equal(
        candidates!.lines[0]!.open,
        "2.00000002",
        "short picking does not fulfill or cancel demand",
      );
      assert.equal(candidates!.lines[0]!.heldByPickLists, "1.00000001");
      assert.equal(candidates!.lines[0]!.allocations[0]!.quantity, "2.99959999",
        "base stock minus exact reservations remains selectable at eight-place document precision");
      const shipment = await withOrg(org.orgId, () =>
        db.transaction((tx) =>
          createShipment(tx, org.orgId, actor, {
            pickListId: first.pick.id,
            documentDate: org.date,
            allowedSubsidiaryIds: null,
          }),
        ),
      );
      const ship = await withOrgTransaction(org.orgId, () =>
        getFulfillmentDocument(db, org.orgId, shipment.id, null),
      );
      assert.equal(ship!.lines[0]!.quantity, "1.00000001");
      const packBin = randomUUID(),
        dock = randomUUID();
      await native(async () => {
        for (const [id, code] of [
          [packBin, "PACK-DIRECT"],
          [dock, "DOCK-DIRECT"],
        ])
          await db.execute(sql`
        insert into stock_locations(id,org_id,location_id,parent_id,code,kind,is_active)
        values(${id},${org.orgId},${org.locationId},${org.stockLocationId},${code},'bin',true)`);
        await db.execute(
          sql`update items set code='DIRECT-WIDGET' where org_id=${org.orgId} and id=${org.items.fifo}`,
        );
        await db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features,barcodeScanning}','true') where id=${org.orgId}`,
        );
      });
      const unit = await createHandlingUnit(org.orgId, actor, {
        shipmentId: shipment.id,
        code: "DIRECT-BOX",
        binId: packBin,
        lineIds: [ship!.lines[0]!.lineId],
      });
      let carrierCalls = 0;
      const transport: typeof fetch = async () => {
        carrierCalls++;
        throw new Error("Unpacked unit must not call a carrier");
      };
      await assert.rejects(
        withOrgTransaction(org.orgId, () =>
          assertShipmentPacked(db, org.orgId, shipment.id),
        ),
        /Confirm every/,
      );
      await assert.rejects(
        withOrg(org.orgId, () =>
          db.transaction((tx) =>
            getShipmentRates(tx, org.orgId, actor, {
              shipmentId: shipment.id,
              handlingUnitId: unit.id,
              allowedSubsidiaryIds: null,
              transport,
            }),
          ),
        ),
        /packed handling unit|packing|contents/i,
      );
      await assert.rejects(
        withOrg(org.orgId, () =>
          db.transaction((tx) =>
            buyShipmentLabel(tx, org.orgId, actor, {
              shipmentId: shipment.id,
              handlingUnitId: unit.id,
              providerRateId: "unquoted",
              allowedSubsidiaryIds: null,
              transport,
            }),
          ),
        ),
        /packed handling unit|packing|contents/i,
      );
      assert.equal(carrierCalls, 0);
      await assert.rejects(
        sealHandlingUnit(org.orgId, actor, unit.id),
        /Confirm every/,
      );
      const pack = await suggestPackConfirmation(org.orgId, actor, {
        unitId: unit.id,
        lineId: ship!.lines[0]!.lineId,
        commandKey: randomUUID(),
      });
      const scan = {
        item: "DIRECT-WIDGET",
        bin: "PACK-DIRECT",
        quantity: "10000.0001",
      };
      const doPack = (evidence = scan) =>
        confirmExecutionTask(
          org.orgId,
          actor,
          { taskId: pack.id, scan: evidence },
          (tx, current) => executePackDirection(tx, org.orgId, actor, current),
        );
      assert.equal(
        (await doPack({ ...scan, bin: "DOCK-DIRECT" })).status,
        "exception",
      );
      assert.equal(
        (
          await native(() =>
            getOnHandWith(db, org.orgId, org.items.fifo, packBin, {
              subsidiaryId: org.subsidiaryId,
            }),
          )
        ).quantity,
        "0.0000",
      );
      assert.equal(
        (await doPack({ ...scan, quantity: "10000.00010001" })).status,
        "exception",
        "an eight-place scan mismatch cannot round into a confirmation",
      );
      assert.equal((await doPack()).status, "done");
      await sealHandlingUnit(org.orgId, actor, unit.id);
      const packed = await withOrgTransaction(org.orgId, () =>
        assertPackedUnit(db, org.orgId, shipment.id, unit.id),
      );
      assert.equal(packed.current_stock_location_id, packBin);
      const moving = {
        unitId: unit.id,
        toBinId: dock,
        date: org.date,
        reason: "Move sealed carton to loading dock",
        commandKey: randomUUID(),
      };
      const move = await moveHandlingUnit(org.orgId, actor, moving);
      assert.equal(move.replayed, false);
      assert.equal(
        (await moveHandlingUnit(org.orgId, actor, moving)).replayed,
        true,
      );
      await assert.rejects(
        moveHandlingUnit(org.orgId, actor, {
          ...moving,
          reason: "Different relocation explanation",
        }),
        /different carton work/,
      );
      const moved = await withOrgTransaction(org.orgId, () =>
        assertPackedUnit(db, org.orgId, shipment.id, unit.id),
      );
      assert.equal(moved.current_stock_location_id, dock);
      const physical = await native(() =>
        getOnHandWith(db, org.orgId, org.items.fifo, dock, {
          subsidiaryId: org.subsidiaryId,
        }),
      );
      assert.equal(physical.quantity, "10000.0001");
      assert.equal(
        compareDecimal(physical.value, "20000.0002"),
        0,
        "carton movement carries the original stock cost",
      );
      const reservation = await withOrgTransaction(org.orgId, () =>
        activePickReservations(db, org.orgId, {
          salesOrderLineIds: [first.lineId],
        }),
      );
      assert.equal(reservation[0]?.binId, dock);
      assert.equal(reservation[0]?.reserved, "1.00000001");
      // Copy physical carton history while excluding execution work and its original scan events.
      for (const masked of [false, true]) {
        const name = `Carton history ${randomUUID()}`;
        let cloneError: unknown;
        try {
          const clone = await native(() =>
            createSandbox({
              productionOrgId: org.orgId,
              name,
              tier: masked ? "masked" : "full",
              masked,
              createdBy: actor,
            }),
          );
          const copied = (
            await native(() =>
              db.execute<{
                actor: string;
                unit: string;
                shipment: string;
                dock: string;
                pack: string;
                status: string;
              }>(sql`
          select ob_rebase(${actor}::uuid,target.sandbox_seed) as actor,ob_rebase(${unit.id}::uuid,target.sandbox_seed) as unit,
            ob_rebase(${shipment.id}::uuid,target.sandbox_seed) as shipment,ob_rebase(${dock}::uuid,target.sandbox_seed) as dock,
            ob_rebase(${packBin}::uuid,target.sandbox_seed) as pack,control.status
          from orgs target join sandboxes control on control.org_id=target.id where target.id=${clone.sandboxOrgId}`),
            )
          ).rows[0]!;
          assert.equal(copied.status, "ready");
          const clonedUnit = await withOrgTransaction(clone.sandboxOrgId, () =>
            assertPackedUnit(
              db,
              clone.sandboxOrgId,
              copied.shipment,
              copied.unit,
            ),
          );
          assert.equal(clonedUnit.current_stock_location_id, copied.dock);
          const evidence = (
            await native(() =>
              db.execute<{
                task: string | null;
                confirmed_by: string;
                matches: boolean;
              }>(sql`
          select content.confirmation_task_id as task,content.confirmed_by,
            (move.movements->0->>'shipmentLineId')::uuid=content.shipment_line_id as matches
          from handling_unit_contents content join handling_unit_moves move
            on move.org_id=content.org_id and move.handling_unit_id=content.handling_unit_id
          where content.org_id=${clone.sandboxOrgId} and content.handling_unit_id=${copied.unit}`),
            )
          ).rows[0]!;
          assert.equal(evidence.task, null);
          assert.equal(evidence.confirmed_by, copied.actor);
          assert.equal(
            evidence.matches,
            true,
            "copied transfer proof names the copied shipment line",
          );
          assert.equal(
            (
              await native(() =>
                db.execute(
                  sql`select id from warehouse_scan_events where org_id=${clone.sandboxOrgId}`,
                ),
              )
            ).rows.length,
            0,
          );
          assert.equal(
            (
              await moveHandlingUnit(clone.sandboxOrgId, copied.actor, {
                unitId: copied.unit,
                toBinId: copied.pack,
                date: org.date,
                reason: "Relocate cloned carton through native command",
                commandKey: randomUUID(),
              })
            ).replayed,
            false,
          );
          assert.equal(
            (
              await withOrgTransaction(org.orgId, () =>
                assertPackedUnit(db, org.orgId, shipment.id, unit.id),
              )
            ).current_stock_location_id,
            dock,
            "copied operation preserves the source carton position",
          );
        } catch (error) {
          cloneError = error;
          throw error;
        } finally {
          try {
            await native(async () => {
              const shells = (
                await db.execute<{ id: string }>(
                  sql`select id from sandboxes where production_org_id=${org.orgId} and name=${name}`,
                )
              ).rows;
              for (const shell of shells)
                await deleteSandbox(shell.id, { actorId: actor });
            });
          } catch (cleanupError) {
            throw cloneError
              ? new AggregateError(
                  [cloneError, cleanupError],
                  "Carton clone and cleanup failed",
                )
              : cleanupError;
          }
        }
      }
      await native(() =>
        db.execute(
          sql`update orgs set settings=jsonb_set(settings,'{features,shippingHub}','false') where id=${org.orgId}`,
        ),
      );
      await assert.rejects(
        moveHandlingUnit(org.orgId, actor, {
          ...moving,
          toBinId: packBin,
          commandKey: randomUUID(),
        }),
        /Turn on shippingHub/,
      );
      await native(() =>
        db.execute(sql`update app_roles set permissions='[]'::jsonb where org_id=${org.orgId} and id in
      (select role_id from role_assignments where org_id=${org.orgId} and user_id=${actor})`),
      );
      await assert.rejects(confirm(), /not found/i);
    } catch (error) {
      scenarioError = error;
      throw error;
    } finally {
      try {
        await native(() => dropScratchOrg(org.orgId));
      } catch (cleanupError) {
        throw scenarioError
          ? new AggregateError(
              [scenarioError, cleanupError],
              "Fulfillment scenario and cleanup failed",
            )
          : cleanupError;
      }
    }
  },
);

test(
  "a packed carton with two lines fails closed when one current packing coordinate becomes null",
  { skip: !DB },
  async () => {
    const org = await native(() => createScratchOrg());
    let scenarioError: unknown;
    try {
      const actor = await native(() =>
        createWarehouseOperator(org.orgId, "Packer"),
      );
      const orderId = randomUUID(),
        orderLines = [randomUUID(), randomUUID()];
      await native(async () => {
        await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',coalesce(settings->'features','{}'::jsonb)
        ||'{"inventory":true,"orders":true,"warehousing":true,"fulfillment":true,"shippingHub":true}'::jsonb) where id=${org.orgId}`);
        await receiveInventory(org.orgId, actor, {
          itemId: org.items.fifo,
          stockLocationId: org.stockLocationId,
          subsidiaryId: org.subsidiaryId,
          quantity: "5",
          unitCost: "3",
          date: org.date,
          offsetAccountId: org.accounts.clearing,
        });
        await db.execute(sql`insert into documents(id,org_id,kind,document_number,party_id,document_date,currency,status,subsidiary_id,created_by)
        values(${orderId},${org.orgId},'sales_order','SO-TWO-LINE',${org.customerId},${org.date},'CAD','draft',${org.subsidiaryId},${actor})`);
        for (const [index, id] of orderLines.entries())
          await db.execute(sql`insert into document_lines(id,org_id,document_id,line_number,item_id,
        account_id,description,quantity,unit,unit_price,amount,tax_amount,stock_location_id)
        values(${id},${org.orgId},${orderId},${index + 1},${org.items.fifo},${org.accounts.revenue},'Widget','1','ea','10','10','0',${org.stockLocationId})`);
        await db.execute(
          sql`update documents set status='approved',subtotal='20',total='20' where org_id=${org.orgId} and id=${orderId}`,
        );
      });
      const pick = await withOrg(org.orgId, () =>
        db.transaction((tx) =>
          createPickList(tx, org.orgId, actor, {
            salesOrderId: orderId,
            documentDate: org.date,
            lines: orderLines.map((id) => ({
              salesOrderLineId: id,
              binId: org.stockLocationId,
              quantity: "1",
            })),
            allowedSubsidiaryIds: null,
          }),
        ),
      );
      await releasePickWave(org.orgId, actor, {
        warehouseId: org.stockLocationId,
        subsidiaryId: org.subsidiaryId,
        mode: "cutoff",
        cutoffAt: "2099-01-01T00:00:00Z",
        pickListIds: [pick.id],
        commandKey: randomUUID(),
      });
      await confirmFixturePick(org.orgId, actor, pick.id);
      const shipment = await withOrg(org.orgId, () =>
        db.transaction((tx) =>
          createShipment(tx, org.orgId, actor, {
            pickListId: pick.id,
            documentDate: org.date,
            allowedSubsidiaryIds: null,
          }),
        ),
      );
      const ship = await withOrgTransaction(org.orgId, () =>
        getFulfillmentDocument(db, org.orgId, shipment.id, null),
      );
      assert.equal(ship!.lines.length, 2);
      const unit = await createHandlingUnit(org.orgId, actor, {
        shipmentId: shipment.id,
        code: "TWO-LINE-CARTON",
        binId: org.stockLocationId,
        lineIds: ship!.lines.map((line) => line.lineId),
      });
      const unitId = unit.id;
      const members = await native(() => db.execute<{ shipment_line_id: string }>(sql`
        select shipment_line_id from handling_unit_contents where org_id=${org.orgId} and handling_unit_id=${unitId}`));
      assert.deepEqual(members.rows.map((row) => row.shipment_line_id).sort(), ship!.lines.map((line) => line.lineId).sort());
      assert.equal((await createHandlingUnit(org.orgId, actor, {
        shipmentId: shipment.id, code: "TWO-LINE-CARTON", binId: org.stockLocationId,
        lineIds: ship!.lines.map((line) => line.lineId).reverse(),
      })).id, unitId, "reordered multi-member selection reopens the same carton");
      const suggestions = [];
      for (const line of ship!.lines)
        suggestions.push(
          await suggestPackConfirmation(org.orgId, actor, {
            unitId,
            lineId: line.lineId,
            commandKey: randomUUID(),
          }),
        );
      const confirmPack = (taskId: string) =>
        confirmExecutionTask(org.orgId, actor, { taskId }, (tx, task) =>
          executePackDirection(tx, org.orgId, actor, task),
        );
      assert.equal((await confirmPack(suggestions[0]!.id)).status, "done");
      await assert.rejects(
        confirmPack(suggestions[1]!.id),
        /contents, position or status changed/i,
      );
      const staleEvidence = await native(() =>
        db.execute(sql`
        select id from warehouse_scan_events where org_id=${org.orgId} and task_id=${suggestions[1]!.id}`),
      );
      assert.equal(
        staleEvidence.rows.length,
        0,
        "stale carton work rolls back its confirmation evidence",
      );
      const refreshed = await suggestPackConfirmation(org.orgId, actor, {
        unitId,
        lineId: ship!.lines[1]!.lineId,
        commandKey: randomUUID(),
      });
      assert.equal((await confirmPack(refreshed.id)).status, "done");
      await sealHandlingUnit(org.orgId, actor, unitId);
      const damaged = ship!.lines[1]!;
      const original = await withOrgTransaction(org.orgId, () =>
        assertPackedUnit(db, org.orgId, shipment.id, unitId),
      );
      const snapshot = async () =>
        native(() =>
          db.execute(sql`select status,content_version,current_stock_location_id,
      (select count(*) from inventory_movements where org_id=${org.orgId}) as movement_count,
      (select count(*) from shipment_labels where org_id=${org.orgId}) as label_count
      from handling_units where org_id=${org.orgId} and id=${unitId}`),
        );
      const before = (await snapshot()).rows;
      let calls = 0;
      const transport: typeof fetch = async () => {
        calls++;
        throw new Error("Invalid carton must not reach the carrier");
      };
      await assert.rejects(
        native(() =>
          db.execute(sql`
        update fulfillment_lines set pick_line_id=null where org_id=${org.orgId} and line_id=${damaged.lineId}`),
        ),
        (error: unknown) =>
          /only the carton/.test(
            String((error as { cause?: unknown }).cause ?? error),
          ),
      );
      assert.deepEqual(
        (await snapshot()).rows,
        before,
        "a protected pick identity cannot be removed",
      );
      for (const coordinate of ["stock_location_id", "carton"] as const) {
        await native(() =>
          db.execute(
            coordinate === "stock_location_id"
              ? sql`update document_lines set stock_location_id=null where org_id=${org.orgId} and id=${damaged.lineId}`
              : sql`update fulfillment_lines set carton=null where org_id=${org.orgId} and line_id=${damaged.lineId}`,
          ),
        );
        await assert.rejects(
          withOrgTransaction(org.orgId, () =>
            assertShipmentPacked(db, org.orgId, shipment.id),
          ),
          /contents changed|unconfirmed/i,
        );
        await assert.rejects(
          withOrg(org.orgId, () =>
            db.transaction((tx) =>
              getShipmentRates(tx, org.orgId, actor, {
                shipmentId: shipment.id,
                handlingUnitId: unitId,
                allowedSubsidiaryIds: null,
                transport,
              }),
            ),
          ),
          /contents changed|unconfirmed/i,
        );
        await assert.rejects(
          withOrg(org.orgId, () =>
            db.transaction((tx) =>
              buyShipmentLabel(tx, org.orgId, actor, {
                shipmentId: shipment.id,
                handlingUnitId: unitId,
                providerRateId: "forged-rate",
                allowedSubsidiaryIds: null,
                transport,
              }),
            ),
          ),
          /contents changed|unconfirmed/i,
        );
        assert.deepEqual(
          (await snapshot()).rows,
          before,
          "refused label and shipment proof changes no physical or financial state",
        );
        await native(() =>
          db.execute(
            coordinate === "stock_location_id"
              ? sql`update document_lines set stock_location_id=${org.stockLocationId} where org_id=${org.orgId} and id=${damaged.lineId}`
              : sql`update fulfillment_lines set carton=${original.code} where org_id=${org.orgId} and line_id=${damaged.lineId}`,
          ),
        );
      }
      assert.equal(calls, 0);
      await withOrgTransaction(org.orgId, () =>
        assertShipmentPacked(db, org.orgId, shipment.id),
      );
    } catch (error) {
      scenarioError = error;
      throw error;
    } finally {
      try {
        await native(() => dropScratchOrg(org.orgId));
      } catch (cleanupError) {
        throw scenarioError
          ? new AggregateError(
              [scenarioError, cleanupError],
              "Nullable packing scenario and cleanup failed",
            )
          : cleanupError;
      }
    }
  },
);
