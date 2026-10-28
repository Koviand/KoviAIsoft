import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { MonitorPage } from "./pages/MonitorPage";
import "./styles/global.css";

const isMonitor = typeof window !== "undefined" && /#\/?monitor\b/i.test(window.location.hash);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isMonitor ? <MonitorPage /> : <App />}</React.StrictMode>,
);
