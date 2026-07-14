import { worklist } from "@openbooks/engine/src/approvals.ts";
import { currentUser } from "../../lib/auth";
import { money } from "../../lib/format";
import { DecideButtons } from "./DecideButtons";

export const dynamic = "force-dynamic";

export default async function Approvals() {
  const user = await currentUser();
  if (!user) return null;
  const items = await worklist(user.orgId, user.role);

  return (
    <>
      <h1>Approvals</h1>
      <p className="sub">pending items assigned to your role ({user.role})</p>
      <table className="data">
        <thead>
          <tr><th>Document</th><th>Kind</th><th>Party</th><th>Date</th><th className="num">Amount</th><th>Step</th><th>Decision</th></tr>
        </thead>
        <tbody>
          {items.length === 0 && <tr><td colSpan={7} className="muted">Nothing waiting on you. 🎉</td></tr>}
          {items.map((i: any) => (
            <tr key={i.step_id}>
              <td className="mono" style={{ fontWeight: 600 }}>{i.document_number}</td>
              <td>{i.kind.replace("_", " ")}</td>
              <td>{i.party}</td>
              <td>{i.document_date}</td>
              <td className="num">{money(i.amount)}</td>
              <td className="muted">step {i.step_number}</td>
              <td><DecideButtons requestId={i.request_id} stepNumber={i.step_number} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
