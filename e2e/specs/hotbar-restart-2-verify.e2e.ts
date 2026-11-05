import { expectHotbar, shown } from "../helpers/ui";

// Shares its temp HOME and config dir with hotbar-restart-1-save.e2e.ts, and
// each spec file runs in its own app process.
describe("hotbar order across a restart: after", () => {
  it("shows the saved order", async () => {
    await shown("catalog-row-alpha", 30000);

    await expectHotbar(["beta", "alpha"]);
  });
});
