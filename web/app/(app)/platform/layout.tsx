import type { ReactNode } from "react";
import { requireSuperAdmin } from "../../../lib/super-admin";

export const dynamic = "force-dynamic";

/** One gate for the entire platform workspace; child pages never stand alone. */
export default async function PlatformLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireSuperAdmin();
  return children;
}
