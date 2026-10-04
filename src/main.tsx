import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./session.ts"; // the machine starts loading before anything is drawn
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
