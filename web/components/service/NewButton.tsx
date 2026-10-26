"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { Button } from "@openbooks/ui";

/** The page's one primary New action: opens the service create drawer (`?new=<kind>`); nothing is written until Save. */
export function ServiceNewButton({
  kind,
  label,
  basePath,
}: {
  kind: string;
  label: string;
  basePath?: string;
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  if (!kind) return null;
  const next = new URLSearchParams(basePath ? "" : params.toString());
  for (const key of ["request", "job", "visit", "agreement"]) next.delete(key);
  next.set("new", kind);
  return (
    <Button asChild>
      <Link href={`${basePath ?? pathname}?${next.toString()}`} scroll={false}>
        <Plus className="mr-1.5 h-4 w-4" />
        {label}
      </Link>
    </Button>
  );
}
