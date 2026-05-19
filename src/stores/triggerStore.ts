"use client";

import { create } from "zustand";

type TriggerStore = {
  currentTime: string;
  firedKeys: string[];
  setCurrentTime: (time: string) => void;
  advanceHours: (hours: number) => void;
  jumpToTomorrowEleven: () => void;
  registerTrigger: (key: string) => void;
};

export const useTriggerStore = create<TriggerStore>((set) => ({
  currentTime: new Date().toISOString(),
  firedKeys: [],
  setCurrentTime: (time) => set({ currentTime: time }),
  advanceHours: (hours) => set((state) => ({ currentTime: new Date(new Date(state.currentTime).getTime() + hours * 3600 * 1000).toISOString() })),
  jumpToTomorrowEleven: () =>
    set((state) => {
      const date = new Date(state.currentTime);
      date.setDate(date.getDate() + 1);
      date.setHours(11, 0, 0, 0);
      return { currentTime: date.toISOString() };
    }),
  registerTrigger: (key) => set((state) => ({ firedKeys: state.firedKeys.includes(key) ? state.firedKeys : [...state.firedKeys, key] })),
}));
