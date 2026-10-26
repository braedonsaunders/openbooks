import assert from "node:assert/strict";
import test from "node:test";
import { serviceWorkspaceTabs } from "./workspace-tabs";

test("service pages share one ordered module navigation with the active route marked", () => {
  const labels = {
    overview: "Overview",
    requests: "Requests",
    jobs: "Jobs",
    visits: "Visits",
    agreements: "Agreements",
  };
  const tabs = serviceWorkspaceTabs("visits", labels);

  assert.deepEqual(
    tabs.map(({ href, label, active }) => ({ href, label, active })),
    [
      { href: "/service", label: "Overview", active: false },
      { href: "/service/requests", label: "Requests", active: false },
      { href: "/service/jobs", label: "Jobs", active: false },
      { href: "/service/visits", label: "Visits", active: true },
      { href: "/service/agreements", label: "Agreements", active: false },
    ],
  );
});
