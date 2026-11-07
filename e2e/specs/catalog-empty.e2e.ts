import fs from "node:fs";
import path from "node:path";
import { kubeconfig } from "../helpers/fixtures";
import { shown } from "../helpers/ui";

const home = process.env.SKOPOS_E2E_HOME as string;

describe("empty catalog", () => {
  it("explains how to add a cluster", async () => {
    const empty = await shown("catalog-table", 30000);
    expect(await empty.getText()).toContain("~/.kube");
    await shown("catalog-add");
  });

  it("leaves the empty state when a kubeconfig appears", async () => {
    fs.writeFileSync(path.join(home, ".kube", "config"), kubeconfig(["first"]));

    await shown("catalog-row-first", 5000);
  });
});
