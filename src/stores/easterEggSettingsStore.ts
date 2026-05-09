"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import {
  DEFAULT_EASTER_EGG_SETTINGS,
  normalizeEasterEggSettings,
  type EasterEggSettings,
  type GoalDrivenLogMode,
  type GoalDrivenUiLogLevel,
  type NumericSettingKey,
} from "@/lib/goalSystemConfig";

type EasterEggSettingsState = {
  hydrated: boolean;
  settings: EasterEggSettings;
  hydrate: () => void;
  updateNumericSetting: (key: NumericSettingKey, value: number) => void;
  updateLogMode: (value: GoalDrivenLogMode) => void;
  updateUiLogLevel: (value: GoalDrivenUiLogLevel) => void;
  resetToDefaults: () => void;
  getSettings: () => EasterEggSettings;
};

const STORAGE_KEY = "kiki.easter-egg-settings";

export const useEasterEggSettingsStore = create<EasterEggSettingsState>()(
  persist(
    (set, get) => ({
      hydrated: false,
      settings: DEFAULT_EASTER_EGG_SETTINGS,
      hydrate: () => {
        if (get().hydrated) return;
        set((state) => ({
          hydrated: true,
          settings: normalizeEasterEggSettings(state.settings),
        }));
      },
      updateNumericSetting: (key, value) => {
        set((state) => ({
          settings: normalizeEasterEggSettings({
            ...state.settings,
            [key]: Math.round(value),
          }),
        }));
      },
      updateLogMode: (value) => {
        set((state) => ({
          settings: {
            ...state.settings,
            llmLogMode: value,
          },
        }));
      },
      updateUiLogLevel: (value) => {
        set((state) => ({
          settings: {
            ...state.settings,
            uiLogLevel: value,
          },
        }));
      },
      resetToDefaults: () => {
        set({
          settings: DEFAULT_EASTER_EGG_SETTINGS,
        });
      },
      getSettings: () => normalizeEasterEggSettings(get().settings),
    }),
    {
      name: STORAGE_KEY,
      partialize: (state) => ({
        settings: state.settings,
      }),
      onRehydrateStorage: () => (state) => {
        state?.hydrate();
      },
    },
  ),
);
