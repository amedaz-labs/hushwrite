import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";
import { ThemeProvider } from "./lib/theme.jsx";
import { FolderProvider } from "./lib/folders.jsx";
import { registerSW } from "virtual:pwa-register";

registerSW({ immediate: true });

// FolderProvider sits above App (not inside it) so App itself can read
// `useFolders()` — the top bar's lock indicator needs the unlocked-folder
// count, which is only reachable from below the provider.
ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ThemeProvider>
      <FolderProvider>
        <App />
      </FolderProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
