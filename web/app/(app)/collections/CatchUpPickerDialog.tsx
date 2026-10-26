"use client";

import { useState } from "react";
import { Button, Drawer } from "@openbooks/ui";

export type CatchUpPick =
  { mode: "post_all" | "drafts" | "skip" } | { mode: "selected"; post: boolean; dates: string[] };

export function CatchUpPickerDialog({
  open,
  title,
  message,
  selectHint,
  dates,
  postSelectedLabel,
  draftSelectedLabel,
  postAllLabel,
  draftsLabel,
  skipLabel,
  cancelLabel,
  busy,
  error,
  onPick,
  onClose,
}: {
  open: boolean;
  title: string;
  message: string;
  selectHint: string;
  dates: string[];
  postSelectedLabel: string;
  draftSelectedLabel: string;
  postAllLabel: string;
  draftsLabel: string;
  skipLabel: string;
  cancelLabel: string;
  busy: boolean;
  error?: string;
  onPick: (pick: CatchUpPick) => void;
  onClose: () => void;
}) {
  // Every period starts ticked: the usual resume bills all of them, and
  // unticking the out-of-season ones is the shortcut to a partial run.
  // Reset while rendering when a new backlog opens (same committed value,
  // no extra render).
  const datesKey = dates.join(",");
  const [checked, setChecked] = useState<string[]>(dates);
  const [seenKey, setSeenKey] = useState(datesKey);
  if (seenKey !== datesKey) {
    setSeenKey(datesKey);
    setChecked(dates);
  }
  const toggle = (date: string) =>
    setChecked((prev) => (prev.includes(date) ? prev.filter((d) => d !== date) : [...prev, date]));
  return (
    <Drawer stacked open={open} onClose={onClose} title={title} size="lg">
      <div className="space-y-5">
        <p className="text-sm text-muted-foreground">{message}</p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div>
          <p className="mb-2 text-sm text-muted-foreground">{selectHint}</p>
          <ul className="max-h-56 space-y-1 overflow-y-auto text-sm">
            {dates.map((date) => (
              <li key={date}>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={checked.includes(date)}
                    onChange={() => toggle(date)}
                    className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                  />
                  <span className="tabular-nums">{date}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-2">
          <Button
            disabled={busy || checked.length === 0}
            onClick={() => onPick({ mode: "selected", post: true, dates: checked })}
          >
            {postSelectedLabel}
          </Button>
          <Button
            disabled={busy || checked.length === 0}
            variant="outline"
            onClick={() => onPick({ mode: "selected", post: false, dates: checked })}
          >
            {draftSelectedLabel}
          </Button>
          <Button disabled={busy} variant="outline" onClick={() => onPick({ mode: "post_all" })}>
            {postAllLabel}
          </Button>
          <Button disabled={busy} variant="outline" onClick={() => onPick({ mode: "drafts" })}>
            {draftsLabel}
          </Button>
          <Button disabled={busy} variant="outline" onClick={() => onPick({ mode: "skip" })}>
            {skipLabel}
          </Button>
          <Button disabled={busy} variant="ghost" onClick={onClose}>
            {cancelLabel}
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
