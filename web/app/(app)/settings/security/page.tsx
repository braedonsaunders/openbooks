import { redirect } from "next/navigation";
import { currentUser } from "../../../../lib/auth";
import { SecurityPanel } from "./security-panel";

export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  return (
    <main className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6 lg:p-8">
      <div>
        <h1 className="text-2xl font-semibold text-slate-950 dark:text-white">Sign-in security</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Protect your account with an authenticator and review active browser sessions.
        </p>
      </div>
      <SecurityPanel />
    </main>
  );
}
