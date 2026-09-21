"use client";

import { useId } from "react";
import { Input, Label, Select, Textarea } from "@openbooks/ui";
import {
  TAX_BASIS_FIELDS,
  taxBasisFieldRequired,
  taxBasisFieldVisible,
  type TaxBasisDraft,
} from "@openbooks/engine/src/tax-returns/asset-basis-policy.ts";

/** Native controls driven by the same statutory field contract as validation.
 * An unanswered boolean stays unanswered; it must not become an election. */
export function TaxBasisFields({
  draft,
  disabled,
  omitFields = [],
  onChange,
}: {
  draft: TaxBasisDraft;
  disabled?: boolean;
  /** Fields supplied by an authoritative source or the nested allocation editor. */
  omitFields?: readonly string[];
  onChange: (name: string, value: string | boolean) => void;
}) {
  const prefix = useId();
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {TAX_BASIS_FIELDS.filter(
        (field) =>
          field.name !== "regime" &&
          !omitFields.includes(field.name) &&
          taxBasisFieldVisible(field, draft),
      ).map((field) => {
        const id = `${prefix}-${field.name}`;
        const required = taxBasisFieldRequired(field, draft);
        const value = draft[field.name];
        const shared = {
          id,
          disabled,
          required,
          "aria-describedby": field.help ? `${id}-help` : undefined,
        };
        return (
          <div key={field.name} className="space-y-1.5">
            <Label htmlFor={id}>
              {field.label}
              {required ? " (required)" : ""}
            </Label>
            {field.kind === "boolean" ? (
              <Select
                {...shared}
                value={typeof value === "boolean" ? String(value) : ""}
                onChange={(event) =>
                  onChange(
                    field.name,
                    event.target.value === ""
                      ? ""
                      : event.target.value === "true",
                  )
                }
              >
                <option value="">Select an answer</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Select>
            ) : field.kind === "enum" ? (
              <Select
                {...shared}
                value={typeof value === "string" ? value : ""}
                onChange={(event) => onChange(field.name, event.target.value)}
              >
                <option value="">Select an answer</option>
                {field.choices?.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </Select>
            ) : field.kind === "date" ? (
              <Input
                {...shared}
                type="date"
                value={typeof value === "string" ? value : ""}
                onChange={(event) => onChange(field.name, event.target.value)}
              />
            ) : field.kind === "text" ? (
              <Textarea
                {...shared}
                value={typeof value === "string" ? value : ""}
                onChange={(event) => onChange(field.name, event.target.value)}
              />
            ) : (
              <Input
                {...shared}
                inputMode="decimal"
                value={typeof value === "string" ? value : ""}
                onChange={(event) => onChange(field.name, event.target.value)}
              />
            )}
            {field.help ? (
              <p id={`${id}-help`} className="text-xs text-muted-foreground">
                {field.help}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
