import "@fontsource-variable/inter/wght.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { registerInstallWorker } from "./install";
import { SessionStoreProvider } from "./session-store";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element");
}

registerInstallWorker();

createRoot(root).render(
  <StrictMode>
    <SessionStoreProvider>
      <App />
    </SessionStoreProvider>
  </StrictMode>,
);
