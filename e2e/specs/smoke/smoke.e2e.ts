import {
  catalogRow,
  clickWhenShown,
  expectConnected,
  expectTerminalLine,
  expectTerminalStatus,
  openResource,
  rowId,
  shown,
  typeInTerminal,
} from "../../helpers/ui";

// Runs without Docker: the only cluster is a fakekube context.
describe("smoke", () => {
  it("launches, lists the fake context and connects", async () => {
    await clickWhenShown("nav-catalog");
    await shown("catalog-row-fake", 30000);
    await (await catalogRow("fake")).$("a=fake").then((link) => link.click());
    await expectConnected();
  });

  it("opens Pods and shows the fake pod", async () => {
    await openResource("nav-item-core-pods", "Pod");
    await shown(rowId("default", "fake-pod"));
  });

  it("opens the local terminal and echoes", async () => {
    await clickWhenShown("dock-terminal");
    await expectTerminalStatus("Local shell");
    await typeInTerminal("echo skopos-smoke-ok");
    await expectTerminalLine("skopos-smoke-ok");
  });
});
