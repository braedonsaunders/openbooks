"use client";
import type { Dispatch, SetStateAction } from 'react'
import { useTranslations } from 'next-intl'
import { Input, Select } from '@openbooks/ui'
import type { SchedulePdfLayout } from '@openbooks/forms-core'
export function SchedulePdfFields({pdfLayout, setPdfLayout, disabled, onChange}: {
  pdfLayout: SchedulePdfLayout; setPdfLayout: Dispatch<SetStateAction<SchedulePdfLayout>>; disabled: boolean; onChange: () => void
}) {
  const t = useTranslations('scheduling.distribution')
  return (
          <fieldset className="grid grid-cols-2 gap-3 border-0 p-0">
            <legend>{t("pdfLayout")}</legend>
            {(
              [
                "paperSize",
                "orientation",
                "density",
                "daysPerSection",
                "detail",
                "style",
                "colorTreatment",
              ] as const
            ).map((field) => {
              const choices = {
                paperSize: ["letter", "a4", "legal", "tabloid"],
                orientation: ["portrait", "landscape"],
                density: ["standard", "compact"],
                daysPerSection: ["7", "14"],
                detail: ["assignments", "hours", "full"],
                style: ["modern", "classic"],
                colorTreatment: ["subtle", "strong"],
              }[field];
              return (
                <label key={field} className="text-sm">
                  {t(`pdfFields.${field}`)}
                  <Select
                    aria-label={t(`pdfFields.${field}`)}
                    value={String(pdfLayout[field] ?? (field === 'colorTreatment' ? 'subtle' : 'modern'))}
                    disabled={disabled}
                    onChange={(event) => {
                      setPdfLayout(
                        (layout) =>
                          ({
                            ...layout,
                            [field]:
                              field === "daysPerSection"
                                ? Number(event.target.value)
                                : event.target.value,
                          }) as SchedulePdfLayout,
                      );
                      onChange();
                    }}
                  >
                    {choices.map((value) => (
                      <option key={value} value={value}>
                        {field === "daysPerSection"
                          ? value
                          : t(`pdfOptions.${field}.${value}`)}
                      </option>
                    ))}
                  </Select>
                </label>
              );
            })}
            <label className="text-sm">
              {t("pdfFields.accentColor")}
              <Input type="color" aria-label={t("pdfFields.accentColor")} value={pdfLayout.accentColor ?? "#0f766e"} disabled={disabled}
                onChange={event => { setPdfLayout(layout => ({ ...layout, accentColor: event.target.value })); onChange(); }} />
            </label>
            {(["showLegend", "shadeWeekends"] as const).map(field => (
              <label key={field} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={pdfLayout[field] !== false} disabled={disabled}
                  onChange={event => { setPdfLayout(layout => ({ ...layout, [field]: event.target.checked })); onChange(); }} />
                {t(`pdfFields.${field}`)}
              </label>
            ))}
            {(pdfLayout.colorTreatment ?? 'subtle') === 'subtle' ? <label className="text-sm">
              {t("pdfFields.colorIntensity")}
              <Input type="number" min={0} max={30} aria-label={t("pdfFields.colorIntensity")} value={pdfLayout.colorIntensity ?? 8} disabled={disabled}
                onChange={event => { setPdfLayout(layout => ({ ...layout, colorIntensity: Number(event.target.value) })); onChange(); }} />
            </label> : null}
            <label className="text-sm">
              {t("pdfFields.marginMm")}
              <Input
                aria-label={t("pdfFields.marginMm")}
                type="number"
                min={5}
                max={30}
                value={pdfLayout.marginMm}
                disabled={disabled}
                onChange={(event) => {
                  setPdfLayout((layout) => ({
                    ...layout,
                    marginMm: Number(event.target.value),
                  }));
                  onChange();
                }}
              />
            </label>
          </fieldset>
  )
}
