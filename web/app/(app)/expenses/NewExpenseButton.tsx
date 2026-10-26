"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { Button } from "@openbooks/ui";

/**
 * URL-only create: opens the expense drawer in unsaved-create mode. Nothing is
 * numbered or written until the drawer's first Save (POST /api/expenses).
 */
export function NewExpenseButton() {
  const t = useTranslations("expenses");
  const router = useRouter();

  return (
    <Button onClick={() => router.push("/expenses/reports?expense=new&mode=edit")}>
      <Plus size={15} /> {t("actions.newReport")}
    </Button>
  );
}
