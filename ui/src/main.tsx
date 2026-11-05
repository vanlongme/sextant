import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { bootstrap } from "./app/bootstrap";
import { Toaster, toast } from "./design";
import "./design/global.css";
import { failureMessage } from "./ipc/client";

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
