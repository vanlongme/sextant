import { catalogRow, clickWhenShown, shown } from "../../helpers/ui";

// Runs without Docker: the only cluster is a fakekube context.
// Phase 4 adds a terminal echo check here.
describe("smoke", () => {
  it("launches, lists the fake context and connects", async () => {
    await clickWhenShown("nav-catalog");
    await shown("catalog-row-fake", 30000);
    await (await catalogRow("fake")).$("a=fake").then((link) => link.click());
    await browser.waitUntil(
      async () => (await (await shown("connection-status")).getText()) === "Connected",
      { timeout: 60000, timeoutMsg: "connection status never became Connected" },
    );
  });
});
