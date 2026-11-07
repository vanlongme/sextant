describe("application shell", () => {
  it("opens the main window and renders the app root", async () => {
    const root = await browser.$('[data-testid="app-root"]');
    await root.waitForDisplayed({ timeout: 30000 });
    expect(await browser.getTitle()).toContain("SkoposIDE");
  });
});
