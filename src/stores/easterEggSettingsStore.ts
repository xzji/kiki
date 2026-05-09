"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type GoalDrivenLogMode = "minimal" | "standard" | "verbose";
export type GoalDrivenUiLogLevel = "debug" | "info" | "warn" | "error" | "none";

export type EasterEggSettings = {
  maxConcurrentTasks: number;
  maxInfoCollectionRounds: number;
  minInfoCollectionRounds: number;
  schedulerCycleIntervalMs: number;
  taskDefaultTimeoutMs: number;
  taskHeartbeatTimeoutMs: number;
  llmLogMode: GoalDrivenLogMode;
  logBufferMaxSize: number;
  uiLogLevel: GoalDrivenUiLogLevel;
  minSubGoals: number;
  maxSubGoals: number;
  minTasksPerSubGoal: number;
  maxTasksPerSubGoal: number;
};

export const DEFAULT_EASTER_EGG_SETTINGS: EasterEggSettings = {
  maxConcurrentTasks: 3,
  maxInfoCollectionRounds: 3,
  minInfoCollectionRounds: 1,
  schedulerCycleIntervalMs: 60000,
  taskDefaultTimeoutMs: 600000,
  taskHeartbeatTimeoutMs: 120000,
  llmLogMode: "standard",
  logBufferMaxSize: 200,
  uiLogLevel: "none",
  minSubGoals: 3,
  maxSubGoals: 7,
  minTasksPerSubGoal: 2,
  maxTasksPerSubGoal: 5,
};

export const EASTER_EGG_SETTING_META = {
  maxConcurrentTasks: {
    label: "最大并发任务数",
    description: "对齐 coding-agent 的后台并发上限，当前主要作为长程系统保留配置。",
    min: 1,
    max: 10,
    active: false,
  },
  maxInfoCollectionRounds: {
    label: "最大信息收集轮数",
    description: "collecting_info 阶段最多追问几轮，达到上限后会基于当前信息直接规划。",
    min: 1,
    max: 5,
    active: true,
  },
  minInfoCollectionRounds: {
    label: "最小信息收集轮数",
    description: "即使信息看起来足够，也至少完成这么多轮收集再进入规划。",
    min: 1,
    max: 3,
    active: true,
  },
  schedulerCycleIntervalMs: {
    label: "调度周期",
    description: "对齐 coding-agent 的调度器循环周期，后续接入真实 scheduler 时生效。",
    min: 10000,
    max: 300000,
    active: false,
  },
  taskDefaultTimeoutMs: {
    label: "任务默认超时",
    description: "对齐 coding-agent 的单任务超时阈值，当前为预留配置。",
    min: 60000,
    max: 1800000,
    active: false,
  },
  taskHeartbeatTimeoutMs: {
    label: "任务心跳超时",
    description: "对齐 coding-agent 的心跳超时阈值，当前为预留配置。",
    min: 30000,
    max: 300000,
    active: false,
  },
  llmLogMode: {
    label: "LLM 日志模式",
    description: "预留给后续调试与运行诊断使用。",
    active: false,
  },
  logBufferMaxSize: {
    label: "日志缓冲区大小",
    description: "对齐 coding-agent 的日志缓冲大小，当前为预留配置。",
    min: 50,
    max: 1000,
    active: false,
  },
  uiLogLevel: {
    label: "UI 日志级别",
    description: "预留给后续 Goal 系统调试面板使用。",
    active: false,
  },
  minSubGoals: {
    label: "最少子目标数",
    description: "规划 prompt 会尽量把目标拆到这个数量以上。",
    min: 1,
    max: 8,
    active: true,
  },
  maxSubGoals: {
    label: "最多子目标数",
    description: "规划 prompt 会尽量控制子目标不要超过这个数量。",
    min: 2,
    max: 10,
    active: true,
  },
  minTasksPerSubGoal: {
    label: "每个子目标最少任务数",
    description: "任务生成 prompt 会尽量保证每个子目标至少拆出这么多任务。",
    min: 1,
    max: 6,
    active: true,
  },
  maxTasksPerSubGoal: {
    label: "每个子目标最多任务数",
    description: "任务生成 prompt 会尽量控制每个子目标不要过度拆解。",
    min: 2,
    max: 8,
    active: true,
  },
} satisfies Record<
  keyof EasterEggSettings,
  {
    label: string;
    description: string;
    min?: number;
    max?: number;
    active: boolean;
  }
>;

type NumericSettingKey = {
  [K in keyof EasterEggSettings]: EasterEggSettings[K] extends number ? K : never;
}[keyof EasterEggSettings];

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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function normalizeSettings(input: EasterEggSettings): EasterEggSettings {
  const next = { ...input };

  next.maxConcurrentTasks = clamp(next.maxConcurrentTasks, 1, 10);
  next.maxInfoCollectionRounds = clamp(next.maxInfoCollectionRounds, 1, 5);
  next.minInfoCollectionRounds = clamp(next.minInfoCollectionRounds, 1, 3);
  next.schedulerCycleIntervalMs = clamp(next.schedulerCycleIntervalMs, 10000, 300000);
  next.taskDefaultTimeoutMs = clamp(next.taskDefaultTimeoutMs, 60000, 1800000);
  next.taskHeartbeatTimeoutMs = clamp(next.taskHeartbeatTimeoutMs, 30000, 300000);
  next.logBufferMaxSize = clamp(next.logBufferMaxSize, 50, 1000);
  next.minSubGoals = clamp(next.minSubGoals, 1, 8);
  next.maxSubGoals = clamp(next.maxSubGoals, 2, 10);
  next.minTasksPerSubGoal = clamp(next.minTasksPerSubGoal, 1, 6);
  next.maxTasksPerSubGoal = clamp(next.maxTasksPerSubGoal, 2, 8);

  if (next.minInfoCollectionRounds > next.maxInfoCollectionRounds) {
    next.minInfoCollectionRounds = next.maxInfoCollectionRounds;
  }
  if (next.minSubGoals > next.maxSubGoals) {
    next.minSubGoals = next.maxSubGoals;
  }
  if (next.minTasksPerSubGoal > next.maxTasksPerSubGoal) {
    next.minTasksPerSubGoal = next.maxTasksPerSubGoal;
  }

  return next;
}

export const useEasterEggSettingsStore = create<EasterEggSettingsState>()(
  persist(
    (set, get) => ({
      hydrated: false,
      settings: DEFAULT_EASTER_EGG_SETTINGS,
      hydrate: () => {
        if (get().hydrated) return;
        set((state) => ({
          hydrated: true,
          settings: normalizeSettings(state.settings),
        }));
      },
      updateNumericSetting: (key, value) => {
        set((state) => ({
          settings: normalizeSettings({
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
      getSettings: () => normalizeSettings(get().settings),
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
