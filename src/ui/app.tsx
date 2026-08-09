import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DashboardApp } from "./DashboardApp.js";

const container = document.querySelector<HTMLElement>("#root");
if (!container) throw new Error("Missing Proof & Replay application root");

createRoot(container).render(
  <StrictMode>
    <DashboardApp />
  </StrictMode>
);
