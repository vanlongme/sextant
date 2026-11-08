import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { bootstrap } from "./app/bootstrap";
import { Toaster, toast } from "./design";
import "@fontsource/manrope/400.css";
import "@fontsource/manrope/500.css";
import "@fontsource/manrope/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "./design/global.css";
import { failureMessage } from "./ipc/client";
import "./kinds";

bootstrap().catch((error) => {
  toast.error("Startup problem", failureMessage(error));
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
      <Toaster />
    </StrictMode>,
  );
}
