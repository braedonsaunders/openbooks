import { readFileSync, writeFileSync } from "node:fs";
const a = JSON.parse(readFileSync("/tmp/nsjobpool.json", "utf8"));
const withTot = a.filter((x) => Number(x.tot) > 500);
console.log("jobs with invoices:", a.length, "| usable:", withTot.length);
const big = withTot.slice(0, 16);
const mid = withTot.slice(Math.floor(withTot.length * 0.35), Math.floor(withTot.length * 0.35) + 17);
const small = withTot.slice(-17);
const seen = new Set(); const pick = [];
for (const x of [...big, ...mid, ...small]) { if (!seen.has(x.job)) { seen.add(x.job); pick.push(x); } }
writeFileSync("/tmp/jobset.json", JSON.stringify(pick));
console.log("selected:", pick.length, "jobs | combined $" + pick.reduce((t, x) => t + Number(x.tot), 0).toFixed(0));
console.log("value range: $" + Number(pick[pick.length-1].tot).toFixed(0), "..", "$" + Number(pick[0].tot).toFixed(0));
console.log("multi-invoice jobs:", pick.filter((x) => +x.n > 1).length, "| single:", pick.filter((x) => +x.n === 1).length);
