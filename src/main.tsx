if (import.meta.env.DEV) {
    await import("preact/debug");
}

import ReactDOM from "react-dom/client";
import App from "./App";
import { enableMapSet } from "immer";
import { lockScroll } from "./utils/scrollLock.ts";
import { lockSelection } from "./utils/selectionLock.ts";

enableMapSet();
lockScroll();
lockSelection();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <App />,
);
