"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Badge, EmptyState } from "@openbooks/ui";

export type RegisterPickerEntry = {
  id: string;
  code: string;
  name: string;
  openSessionId: string | null;
  openedBy: string | null;
};

/** Choose the register to sell from; each card shows whether its drawer is open. */
export function RegisterPicker(props: { registers: RegisterPickerEntry[]; canManage: boolean }) {
  const t = useTranslations("pos");
  return (
    <div className="space-y-4">
      {props.registers.length === 0 ? (
        <EmptyState
          title={t("picker.emptyTitle")}
          description={props.canManage ? t("picker.emptyManage") : t("picker.emptyAsk")}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {props.registers.map((register) => (
            <Link
              key={register.id}
              href={`/pos/${register.id}`}
              className="block rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-teal-400 hover:shadow dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-lg font-semibold">{register.name}</span>
                <Badge variant={register.openSessionId ? "success" : "outline"}>
                  {register.openSessionId ? t("picker.open") : t("picker.closed")}
                </Badge>
              </div>
              <p className="text-sm text-slate-500">{register.code}</p>
              {register.openedBy ? (
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
                  {t("picker.openedBy", { name: register.openedBy })}
                </p>
              ) : null}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
