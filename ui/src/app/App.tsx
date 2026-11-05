import { useState } from "react";
import { RouterProvider } from "react-router";
import { createAppRouter } from "./router";
import styles from "./Shell.module.css";

export function App() {
  const [router] = useState(createAppRouter);
  return (
    <div data-testid="app-root" className={styles.root}>
      <RouterProvider router={router} />
    </div>
  );
}
