import React from "react";
import { createRoot } from "react-dom/client";
import "@shadowroom/ui-tokens/tokens.css";
import "@shadowroom/ui-tokens/base.css";
import "./styles/app.css";
import "./styles/conversation.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
