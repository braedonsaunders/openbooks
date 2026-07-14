"use client";

import { useRouter } from "next/navigation";

export function SignOut() {
  const router = useRouter();
  return (
    <button
      className="nav-item"
      style={{ background: "none", border: "none", cursor: "pointer", width: "100%", textAlign: "left", font: "inherit", fontWeight: 500 }}
      onClick={async () => {
        await fetch("/api/login", { method: "DELETE" });
        router.push("/login");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
