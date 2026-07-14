import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "openbooks",
  description: "The open business suite. Run on open books.",
};

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/reports", label: "Reports" },
  { href: "/accounts", label: "Chart of Accounts" },
  { href: "/journal", label: "Journal" },
  { href: "/query", label: "SQL" },
  { href: "/sync", label: "Sync" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">
              open<span>books</span>
              <small>run on open books</small>
            </div>
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="nav-item">
                {n.label}
              </Link>
            ))}
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
