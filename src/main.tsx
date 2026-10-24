import "@fontsource-variable/unbounded";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root")!;
const app = (
  <StrictMode>
    <App path={location.pathname} />
  </StrictMode>
);
// A built page arrives with its markup in place; the dev server sends an empty shell.
if (root.firstElementChild) hydrateRoot(root, app);
else createRoot(root).render(app);
