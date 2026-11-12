import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";
import { registerServiceWorker } from "./service-worker";

const root = document.getElementById("root");
if (!root) throw new Error("index.html is missing the #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Not in the dev server: a worker left registered there outlives it and confuses the next thing on that port.
if (import.meta.env.PROD) void registerServiceWorker();
