const EMBEDDED_PORT = Number(process.env.TAURI_WEBDRIVER_PORT ?? 4445);
const BASE = `http://127.0.0.1:${EMBEDDED_PORT}`;
const EXIT_TIMEOUT_MS = 15000;

async function serverIsUp(): Promise<boolean> {
  try {
    await fetch(`${BASE}/status`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ends the running app by closing its only window. The tauri service keeps one
 * app across spec files and starts a new one only when it finds the old one
 * gone, using the environment of that moment.
 */
export async function stopApp(): Promise<void> {
  if (!(await serverIsUp())) return;
  const created = await fetch(`${BASE}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ capabilities: { alwaysMatch: {} } }),
  });
  const { value } = (await created.json()) as { value: { sessionId: string } };
  await fetch(`${BASE}/session/${value.sessionId}/window`, { method: "DELETE" });

  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  while (await serverIsUp()) {
    if (Date.now() > deadline) {
      throw new Error(`the app did not exit within ${EXIT_TIMEOUT_MS} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
