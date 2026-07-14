"use client";

import { useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

export function SaveViewButton() {
  const [saved, setSaved] = useState(false);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  async function save() {
    const name = prompt("Name this view:");
    if (!name) return;
    const params = Object.fromEntries(searchParams.entries());
    const res = await fetch("/api/saved-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, path: pathname, params }),
    });
    if (res.ok) setSaved(true);
    else alert("Could not save view");
  }

  return (
    <button className="btn secondary" onClick={save} style={{ marginBottom: 16 }}>
      {saved ? "Saved ✓" : "Save this view"}
    </button>
  );
}
