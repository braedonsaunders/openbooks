"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  Drawer,
  Input,
  Label,
  SearchSelect,
  Textarea,
} from "@openbooks/ui";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useDirtyClose } from "@/lib/use-dirty-close";
type Event = {
  id: string;
  date: string;
  kind: string;
  amount: string;
  book_name: string;
  group_currency: string;
  recorded: boolean;
};
/** Same native stacked drawer as the asset change workpaper. */
export function GroupValuationButton({ assetId }: { assetId: string }) {
  const router = useRouter();
  const tCommon = useTranslations("common");
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [events, setEvents] = useState<Event[]>([]),
    [eventId, setEventId] = useState(""),
    [carryingValue, setCarrying] = useState(""),
    [rate, setRate] = useState(""),
    [assessment, setAssessment] = useState(""),
    [reason, setReason] = useState(""),
    [plan, setPlan] = useState<{ date: string; amount: string }[]>([]),
    [key, setKey] = useState(() => crypto.randomUUID());
  const event = events.find((e) => e.id === eventId);
  const [dirty, setDirty] = useState(false);
  const changed = () => { setDirty(true); setKey(crypto.randomUUID()); };
  const closeDrawer = () => {
    setOpen(false);
    setEventId("");
    setCarrying("");
    setRate("");
    setAssessment("");
    setReason("");
    setPlan([]);
    setDirty(false);
    setKey(crypto.randomUUID());
  };
  const closeGuard = useDirtyClose({
    dirty, busy, onClose: closeDrawer,
    message: tCommon("feedback.unsavedChanges"), confirmLabel: tCommon("confirm.discardChanges"),
  });
  async function show() {
    setBusy(true);
    try {
      const response = await fetch(`/api/assets/${assetId}/group-valuations`);
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error ?? "Unable to load group valuations");
      }
      const body = await response.json();
      setEvents(body.events);
      setOpen(true);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to load group valuations",
      );
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (!event) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/assets/${assetId}/group-valuations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceEventId: event.id,
          effectiveOn: event.date,
          carryingValue,
          buyerToGroupRate: rate,
          assessment,
          reason,
          remainingPlan: plan,
          idempotencyKey: key,
        }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error ?? "Group valuation could not be proposed");
      }
      const body = await response.json();
      setOpen(false);
      router.push(
        `/accounting/changes?change=${encodeURIComponent(body.changeId)}`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Group valuation could not be proposed",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button variant="outline" onClick={show} disabled={busy}>
        Group valuation
      </Button>
      <Drawer
        open={open}
        onClose={closeGuard.close}
        title="Group asset valuation"
        size="lg"
        stacked
      >
        <fieldset disabled={busy} className="min-w-0 space-y-4 p-4">
          <p>
            Assess group recoverability independently from the receiving
            company&apos;s valuation. Approval preserves prior depreciation and
            revises only future group service. Consolidation posts the resulting
            adjustment.
          </p>
          <Label id="group-valuation-event-label">Posted valuation</Label>
          <SearchSelect
            value={eventId}
            onChange={(value) => {
              setEventId(value);
              changed();
            }}
            options={events.map((e) => ({
              value: e.id,
              label: `${e.date} · ${e.book_name} · ${e.kind} ${e.amount}${e.recorded ? " · revise group assessment" : ""}`,
            }))}
            placeholder="Select the source valuation"
            ariaLabelledBy="group-valuation-event-label"
            ariaLabel="Posted valuation"
          />
          {!events.length ? (
            <p>No unreversed valuation of a transferred asset is available.</p>
          ) : null}
          <Label htmlFor="group-valuation-carrying">
            Group carrying amount ({event?.group_currency ?? "group currency"})
          </Label>
          <Input
            id="group-valuation-carrying"
            value={carryingValue}
            onChange={(e) => {
              setCarrying(e.target.value);
              changed();
            }}
          />
          <Label htmlFor="group-valuation-rate">Buyer functional currency to group currency rate</Label>
          <Input
            id="group-valuation-rate"
            value={rate}
            onChange={(e) => {
              setRate(e.target.value);
              changed();
            }}
          />
          <Label htmlFor="group-valuation-assessment">Group recoverability and remaining-service assessment</Label>
          <Textarea
            id="group-valuation-assessment"
            value={assessment}
            onChange={(e) => {
              setAssessment(e.target.value);
              changed();
            }}
          />
          <Label htmlFor="group-valuation-reason">Reason</Label>
          <Textarea
            id="group-valuation-reason"
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              changed();
            }}
          />
          <fieldset className="space-y-3">
            <legend>Remaining group depreciation in group currency</legend>
            {plan.map((line, index) => (
              <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                <Input
                  aria-label="Accounting period end"
                  type="date"
                  value={line.date}
                  onChange={(e) => {
                    setPlan((rows) =>
                      rows.map((r, i) =>
                        i === index ? { ...r, date: e.target.value } : r,
                      ),
                    );
                    changed();
                  }}
                />
                <Input
                  aria-label="Group depreciation amount"
                  value={line.amount}
                  onChange={(e) => {
                    setPlan((rows) =>
                      rows.map((r, i) =>
                        i === index ? { ...r, amount: e.target.value } : r,
                      ),
                    );
                    changed();
                  }}
                />
                <Button
                  variant="outline"
                  onClick={() => {
                    setPlan((rows) => rows.filter((_, i) => i !== index));
                    changed();
                  }}
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              onClick={() => {
                setPlan((rows) => [...rows, { date: "", amount: "" }]);
                changed();
              }}
            >
              Add period
            </Button>
          </fieldset>
          <Button onClick={submit} disabled={busy || !event}>
            Create approval proposal
          </Button>
        </fieldset>
      </Drawer>
    </>
  );
}
