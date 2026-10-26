"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Input, Label, Select, Textarea } from "@openbooks/ui";
import { DateField } from "../date-field";
import { postJson, refusalText } from "./api";
import { AgreementTermsForm } from "./agreement-terms";
import { Refusal } from "./format";
import {
  LinesEditor,
  QualificationPicker,
  RemotePicker,
  SitePickers,
  lineInputs,
  type DraftLine,
} from "./pickers";

type Refused = { message: string; remedy: string | null } | null;
export type CreateKind = "request" | "job" | "agreement";

function CustomerFields({
  customer,
  setCustomer,
  address,
  setAddress,
  contact,
  setContact,
}: {
  customer: { id: string; label: string };
  setCustomer: (value: { id: string; label: string }) => void;
  address: string;
  setAddress: (value: string) => void;
  contact: string;
  setContact: (value: string) => void;
}) {
  const t = useTranslations("service.form");
  return (
    <>
      <div className="sm:col-span-2">
        <Label>{t("customer")}</Label>
        <RemotePicker
          kind="customers"
          value={customer.id}
          label={customer.label}
          ariaLabel={t("customer")}
          onChange={(id, option) => {
            setCustomer({ id, label: option?.label ?? "" });
            setAddress("");
            setContact("");
          }}
        />
      </div>
      <div className="sm:col-span-2">
        <SitePickers
          customerId={customer.id}
          addressId={address}
          contactId={contact}
          onAddress={setAddress}
          onContact={setContact}
        />
      </div>
    </>
  );
}

/**
 * The create form for a service request, job or agreement. Nothing is
 * written until Save; the client key makes a retried Save return the same
 * record.
 */
export function ServiceCreateForm({
  kind,
  onCreated,
}: {
  kind: CreateKind;
  onCreated: (id: string) => void;
}) {
  const t = useTranslations("service.form");
  const [key] = useState(() => crypto.randomUUID());
  const [customer, setCustomer] = useState({ id: "", label: "" });
  const [address, setAddress] = useState("");
  const [contact, setContact] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("normal");
  const [preferredOn, setPreferredOn] = useState("");
  const [preferredTime, setPreferredTime] = useState("any");
  const [minutes, setMinutes] = useState("60");
  const [billingMode, setBillingMode] = useState("per_visit");
  const [labor, setLabor] = useState({ id: "", label: "" });
  const [laborPrice, setLaborPrice] = useState("");
  const [deposit, setDeposit] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refused>(null);

  async function save(
    body: Record<string, unknown>,
    url: string,
    pick: (result: Record<string, unknown>) => string,
  ) {
    setBusy(true);
    setRefusal(null);
    try {
      const result = await postJson<Record<string, unknown>>(url, body, t("saveFailed"));
      onCreated(pick(result));
    } catch (error) {
      setRefusal(refusalText(error, t("saveFailed")));
    } finally {
      setBusy(false);
    }
  }

  const site = { serviceAddressId: address || null, contactId: contact || null };
  const common = (
    <>
      <CustomerFields
        customer={customer}
        setCustomer={setCustomer}
        address={address}
        setAddress={setAddress}
        contact={contact}
        setContact={setContact}
      />
      <div className="sm:col-span-2">
        <Label>{t("title")}</Label>
        <Input
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          aria-label={t("title")}
        />
      </div>
    </>
  );

  if (kind === "agreement") {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          {common}
          <div>
            <Label>{t("startsOn")}</Label>
            <DateField value={startsOn} onChange={setStartsOn} aria-label={t("startsOn")} />
          </div>
          <div>
            <Label>{t("endsOn")}</Label>
            <DateField value={endsOn} onChange={setEndsOn} aria-label={t("endsOn")} />
          </div>
        </div>
        <Refusal refusal={refusal} />
        <AgreementTermsForm
          submitLabel={t("createAgreement")}
          onSubmit={({ effectiveFrom: _effectiveFrom, reason, ...version }) => {
            void _effectiveFrom;
            if (!customer.id || !title.trim() || !startsOn) {
              setRefusal({ message: t("missingRequired"), remedy: null });
              return;
            }
            return save(
              {
                id: key,
                customerPartyId: customer.id,
                ...site,
                title: title.trim(),
                startsOn,
                endsOn: endsOn || null,
                version,
                reason,
              },
              "/api/service/agreements",
              (result) => String((result.agreement as { id: string }).id),
            );
          }}
        />
      </div>
    );
  }

  const ready =
    Boolean(customer.id && title.trim()) && (kind === "request" || /^\d+$/.test(minutes.trim()));
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {common}
        <div className="sm:col-span-2">
          <Label>{t("description")}</Label>
          <Textarea
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            aria-label={t("description")}
          />
        </div>
        <div>
          <Label>{t("priority")}</Label>
          <Select
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
            aria-label={t("priority")}
          >
            {(["urgent", "high", "normal", "low"] as const).map((value) => (
              <option key={value} value={value}>
                {t(`priorities.${value}`)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>{t("preferredOn")}</Label>
          <DateField value={preferredOn} onChange={setPreferredOn} aria-label={t("preferredOn")} />
        </div>
        {kind === "request" ? (
          <div>
            <Label>{t("preferredTime")}</Label>
            <Select
              value={preferredTime}
              onChange={(event) => setPreferredTime(event.target.value)}
              aria-label={t("preferredTime")}
            >
              {(["any", "morning", "afternoon", "evening"] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`times.${value}`)}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <>
            <div>
              <Label>{t("estimatedMinutes")}</Label>
              <Input
                inputMode="numeric"
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
                aria-label={t("estimatedMinutes")}
              />
            </div>
            <div>
              <Label>{t("billingMode")}</Label>
              <Select
                value={billingMode}
                onChange={(event) => setBillingMode(event.target.value)}
                aria-label={t("billingMode")}
              >
                {(["per_visit", "per_job", "not_billable"] as const).map((value) => (
                  <option key={value} value={value}>
                    {t(`billingModes.${value}`)}
                  </option>
                ))}
              </Select>
            </div>
            {billingMode !== "not_billable" ? (
              <>
                <div>
                  <Label>{t("laborItem")}</Label>
                  <RemotePicker
                    kind="items"
                    value={labor.id}
                    label={labor.label}
                    ariaLabel={t("laborItem")}
                    onChange={(id, option) => setLabor({ id, label: option?.label ?? "" })}
                  />
                </div>
                <div>
                  <Label>{t("laborRate")}</Label>
                  <Input
                    inputMode="decimal"
                    value={laborPrice}
                    onChange={(event) => setLaborPrice(event.target.value)}
                    aria-label={t("laborRate")}
                    placeholder={t("laborRateHint")}
                  />
                </div>
                <div>
                  <Label>{t("depositRequired")}</Label>
                  <Input
                    inputMode="decimal"
                    value={deposit}
                    onChange={(event) => setDeposit(event.target.value)}
                    aria-label={t("depositRequired")}
                  />
                </div>
              </>
            ) : null}
            <div className="sm:col-span-2">
              <Label>{t("qualifications")}</Label>
              <QualificationPicker value={skills} onChange={setSkills} />
            </div>
            <div className="sm:col-span-2">
              <Label>{t("scopeLines")}</Label>
              <LinesEditor lines={lines} onChange={setLines} />
            </div>
          </>
        )}
      </div>
      <Refusal refusal={refusal} />
      <Button
        disabled={busy || !ready}
        onClick={() =>
          void (kind === "request"
            ? save(
                {
                  id: key,
                  customerPartyId: customer.id,
                  ...site,
                  title: title.trim(),
                  description: description.trim() || null,
                  priority,
                  preferredOn: preferredOn || null,
                  preferredTime,
                },
                "/api/service/requests",
                (result) => String(result.id),
              )
            : save(
                {
                  id: key,
                  customerPartyId: customer.id,
                  ...site,
                  title: title.trim(),
                  description: description.trim() || null,
                  priority,
                  estimatedMinutes: Number(minutes.trim()),
                  billingMode,
                  requiredQualificationTypeIds: skills,
                  laborItemId: billingMode !== "not_billable" && labor.id ? labor.id : null,
                  laborUnitPrice:
                    billingMode !== "not_billable" && laborPrice.trim() ? laborPrice.trim() : null,
                  depositRequired:
                    billingMode !== "not_billable" && deposit.trim() ? deposit.trim() : null,
                  lines: lineInputs(lines),
                  firstVisit: { preferredOn: preferredOn || null },
                },
                "/api/service/jobs",
                (result) => String((result.job as { id: string }).id),
              ))
        }
      >
        {t(kind === "request" ? "createRequest" : "createJob")}
      </Button>
    </div>
  );
}
