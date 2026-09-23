import { useAppState } from "../state/appState";
import { keyboardManager, RegistrationID } from "./KeyboardManager";
import { Panel } from "../components/constants";

export function setActivePanel(panel: Panel) {
    useAppState.getState().setFocusPanel(panel);
    const panelToKey: Record<Panel, RegistrationID> = {
        [Panel.Adjustments]: RegistrationID.adjustments,
        [Panel.Filmstrip]: RegistrationID.filmstrip,
    };
    keyboardManager.setActive(panelToKey[panel]);
}
