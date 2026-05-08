export const OPEN_SETTINGS_EVENT = "kiki:open-settings";

export type SettingsTab = "account" | "runtime";

export function openSettings(tab: SettingsTab = "account") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(OPEN_SETTINGS_EVENT, {
      detail: { tab },
    }),
  );
}
