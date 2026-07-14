"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const params = useSearchParams();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (res.ok) {
      router.push(params.get("next") ?? "/");
      router.refresh();
    } else {
      setError("Invalid email or password");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="card" style={{ width: 360, padding: 28 }}>
      <div className="brand" style={{ padding: 0, marginBottom: 18 }}>
        open<span style={{ color: "var(--accent)" }}>books</span>
        <small>run on open books</small>
      </div>
      <label className="label" style={{ fontSize: 12 }}>Email</label>
      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus
        style={{ width: "100%", padding: "9px 11px", margin: "4px 0 14px", border: "1px solid var(--line)", borderRadius: 7 }} />
      <label className="label" style={{ fontSize: 12 }}>Password</label>
      <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
        style={{ width: "100%", padding: "9px 11px", margin: "4px 0 18px", border: "1px solid var(--line)", borderRadius: 7 }} />
      {error && <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 0 }}>{error}</p>}
      <button className="btn" style={{ width: "100%", justifyContent: "center" }} disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export default function Login() {
  return (
    <div style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", background: "var(--bg)", zIndex: 10 }}>
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  );
}
