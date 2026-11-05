import { expectHotbar, rowMenu, shown } from "../helpers/ui";

// hotbar-restart-2-verify.e2e.ts reads this order back in a new app process.
describe("hotbar order across a restart: before", () => {
  it("saves an order that differs from the pin order", async () => {
    await shown("catalog-row-beta", 30000);
    await rowMenu("beta", "pin");
    await rowMenu("alpha", "pin");

    await expectHotbar(["beta", "alpha"]);
  });
});
