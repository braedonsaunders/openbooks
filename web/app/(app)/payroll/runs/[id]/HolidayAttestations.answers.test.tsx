import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../../../../../testing/jsdom-env";

await bootJsdomEnvironment({
  url: "http://localhost:4800/payroll/runs/run-1",
  matchMediaMatches: false,
});

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act, useState } = await import("react");
const { NextIntlClientProvider } = await import("next-intl");
const messages = (await import("../../../../../messages/en")).default;
const { HolidayAttestations } = await import("./HolidayAttestations");
const { ConfirmRoot } = await import("../../../../../lib/confirm");
const { toast } = await import("sonner");

const HOLIDAY = { key: "boxing-day", date: "2026-12-26", name: "Boxing Day" };

const roster = [
  { employee_party_id: "employee-1", name: "Ada" },
  { employee_party_id: "employee-2", name: "Grace" },
];

const demanding = [
  {
    ...HOLIDAY,
    needsCommissionStatus: false,
    needsAbsenceAssertion: true,
    needsEntitlementDayAssessment: false,
    needsOccupationClass: false,
  },
];

/** Both employees need the last-and-first-shift absence answer. */
function absenceError(employee: string, employeePartyId: string) {
  return {
    employee,
    employeePartyId,
    neededFact: "absentWithoutConsent" as const,
    holidayKey: HOLIDAY.key,
    holidayDate: HOLIDAY.date,
    message: "last-and-first-shift absence assertion is required",
  };
}

test("answering two employees with the same absence answer files both", async (t) => {
  const filed: { employeePartyId: string; absentWithoutConsent: boolean }[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.includes("/holiday-assertions") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        employeePartyId: string;
        absentWithoutConsent: boolean;
      };
      filed.push({
        employeePartyId: body.employeePartyId,
        absentWithoutConsent: body.absentWithoutConsent,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Reads reflect what has been filed so far, as the server would.
    const assertionsFor = (employeePartyId: string) =>
      filed
        .filter((entry) => entry.employeePartyId === employeePartyId)
        .map((entry) => ({
          holidayKey: HOLIDAY.key,
          holidayDate: HOLIDAY.date,
          absentWithoutConsent: entry.absentWithoutConsent,
        }));
    const employee = (employeePartyId: string, name: string) => ({
      employeePartyId,
      name,
      paidOnCommission: null,
      occupationClass: null,
      occupationClasses: [],
      assertions: assertionsFor(employeePartyId),
      demanding,
    });
    return new Response(
      JSON.stringify({
        employees: [employee("employee-1", "Ada"), employee("employee-2", "Grace")],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  // The parent recalculates after each filed answer; the server drops an
  // employee's exception once that employee is answered.
  function Harness() {
    const [errors, setErrors] = useState([
      absenceError("Ada", "employee-1"),
      absenceError("Grace", "employee-2"),
    ]);
    return (
      <HolidayAttestations
        runId="run-1"
        errors={errors}
        roster={roster}
        canAnswer
        onAnswered={() => {
          const answered = new Set(filed.map((entry) => entry.employeePartyId));
          setErrors((prev) => prev.filter((error) => !answered.has(error.employeePartyId)));
        }}
      />
    );
  }

  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <Harness />
      </NextIntlClientProvider>,
    );
    await settle();
  });

  // The shared Select keeps the id on its visible trigger; the native proxy
  // beside it is the element that carries the value and change event.
  const select = (employeePartyId: string) => {
    const trigger = host.querySelector(
      `[id="att-abs-${employeePartyId}-${HOLIDAY.key}|${HOLIDAY.date}"]`,
    );
    return (
      [...host.querySelectorAll<HTMLSelectElement>("select")].find((proxy) =>
        proxy.parentElement?.contains(trigger),
      ) ?? null
    );
  };
  // The answer's own row: the nearest ancestor that also holds its Save button.
  const saveFor = (employeePartyId: string) => {
    let node: HTMLElement | null = select(employeePartyId);
    while (node) {
      const save = [...node.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Save & recalculate"),
      );
      if (save) return save;
      node = node.parentElement;
    }
    return null;
  };

  async function answer(employeePartyId: string, value: "true" | "false") {
    const element = select(employeePartyId);
    assert.ok(element, `absence control for ${employeePartyId} is rendered`);
    await act(async () => {
      // Through the prototype setter, as the shared Select itself does, so
      // React's value tracking sees the change.
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!.call(
        element,
        value,
      );
      element.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    const save = saveFor(employeePartyId);
    assert.ok(save, `save control for ${employeePartyId} is rendered`);
    assert.equal(
      save.disabled,
      false,
      `save for ${employeePartyId} is enabled once an answer is chosen`,
    );
    await act(async () => {
      save.click();
      await settle();
      await settle();
    });
  }

  await answer("employee-1", "false");
  assert.equal(select("employee-2")?.value, "", "the second employee starts unanswered");

  await answer("employee-2", "false");

  assert.deepEqual(
    filed.map((entry) => [entry.employeePartyId, entry.absentWithoutConsent]),
    [
      ["employee-1", false],
      ["employee-2", false],
    ],
    "both employees are filed with their own answer",
  );
});

for (const refuseAfter of [null, 1] as const) {
  test(
    refuseAfter === null
      ? "bulk absence answers require confirmation and file each employee and occurrence once"
      : "a refused bulk answer preserves earlier assertions and recalculates the saved answers",
    async (t) => {
      type Answer = {
        employeePartyId: string;
        holidayKey: string;
        holidayDate: string;
        absentWithoutConsent: boolean;
      };
      const filed: Answer[] = [];
      const errors: string[] = [];
      let recalculations = 0;
      const previousFetch = globalThis.fetch;
      const previousToastError = toast.error;
      toast.error = ((message: unknown) => {
        errors.push(String(message));
        return "test-toast";
      }) as typeof toast.error;
      const holidays = [
        demanding[0]!,
        { ...demanding[0]!, key: "new-year", date: "2027-01-01", name: "New Year" },
      ];
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "POST") {
          if (refuseAfter !== null && filed.length === refuseAfter) {
            return Response.json(
              { error: "The pay run changed; reload before filing another assertion" },
              { status: 409 },
            );
          }
          filed.push(JSON.parse(String(init.body)) as Answer);
          return Response.json({ ok: true });
        }
        return Response.json({
          employees: roster.map((employee) => ({
            employeePartyId: employee.employee_party_id,
            name: employee.name,
            paidOnCommission: null,
            occupationClass: null,
            occupationClasses: [],
            demanding: holidays,
            assertions: filed.filter(
              (answer) => answer.employeePartyId === employee.employee_party_id,
            ),
          })),
        });
      }) as typeof fetch;
      t.after(() => {
        globalThis.fetch = previousFetch;
        toast.error = previousToastError;
      });
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      t.after(async () => {
        await act(async () => root.unmount());
        host.remove();
      });
      const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
      await act(async () => {
        root.render(
          <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
            <HolidayAttestations
              runId="run-1"
              errors={roster.map((employee) =>
                absenceError(employee.name, employee.employee_party_id),
              )}
              roster={roster}
              canAnswer
              onAnswered={() => {
                recalculations += 1;
              }}
            />
            <ConfirmRoot />
          </NextIntlClientProvider>,
        );
        await settle();
      });
      const bulk = [...host.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Answer all 4 questions"),
      );
      assert.ok(bulk);
      await act(async () => {
        bulk.click();
        await settle();
      });
      assert.equal(filed.length, 0, "confirmation precedes every write");
      const dialog = document.querySelector('[role="dialog"]');
      assert.ok(dialog);
      const confirm = [...dialog.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("Answer all 4 questions"),
      );
      assert.ok(confirm);
      await act(async () => {
        confirm.click();
        await settle();
        await settle();
      });
      assert.equal(recalculations, 1, "saved assertions are reflected by one recalculation");
      if (refuseAfter === null) {
        assert.deepEqual(
          filed,
          roster.flatMap((employee) =>
            holidays.map((holiday) => ({
              employeePartyId: employee.employee_party_id,
              holidayKey: holiday.key,
              holidayDate: holiday.date,
              absentWithoutConsent: false,
            })),
          ),
        );
        assert.deepEqual(errors, []);
      } else {
        assert.equal(filed.length, 1);
        assert.equal(filed.at(0)?.employeePartyId, "employee-1");
        assert.equal(filed.at(0)?.absentWithoutConsent, false);
        assert.ok(errors.some((error) => /pay run changed; reload/.test(error)));
      }
    },
  );
}
