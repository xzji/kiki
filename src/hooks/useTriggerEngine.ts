"use client";

import { useEffect } from "react";

import { useGoalStore } from "@/stores/goalStore";
import { useInboxStore } from "@/stores/inboxStore";
import { useTriggerStore } from "@/stores/triggerStore";
import type { InboxItem, Task } from "@/types/dora";

function toInboxItem(task: Task, goalId: string, createdAt: string): InboxItem {
  const title = task.title.replace(/^任务\d+：/, "");
  const timeLabel = `${String(new Date(createdAt).getHours()).padStart(2, "0")}:${String(new Date(createdAt).getMinutes()).padStart(2, "0")}`;
  const iconType = task.executionKind === "draft_review" ? "mail" : task.executionKind === "reading_digest" ? "news" : task.executionKind === "confirm_action" ? "booking" : "task";
  return {
    id: `generated-${task.id}-${createdAt}`,
    iconType,
    title,
    snippet: `Kiki 已按 ${task.triggerRule} 为你生成新的待处理内容。`,
    badge: task.executionKind === "confirm_action" ? "need_confirm" : null,
    unreadCount: 1,
    timeLabel,
    linkTo: `/goals/${goalId}/tasks/${task.id}?view=${task.executionKind === "flashcard" ? "list" : "exec"}`,
    goalId,
    createdAt,
  };
}

function getRuleHour(rule: string) {
  const match = rule.match(/(\d{1,2}):(\d{2})/);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : null;
}

export function useTriggerEngine() {
  const goals = useGoalStore((state) => state.goals);
  const generateInstance = useGoalStore((state) => state.generateInstance);
  const addItem = useInboxStore((state) => state.addItem);
  const currentTime = useTriggerStore((state) => state.currentTime);
  const firedKeys = useTriggerStore((state) => state.firedKeys);
  const registerTrigger = useTriggerStore((state) => state.registerTrigger);

  useEffect(() => {
    const now = new Date(currentTime);
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const dateKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

    goals.forEach((goal) => {
      goal.subGoals.forEach((subGoal) => {
        subGoal.tasks.forEach((task) => {
          const rule = getRuleHour(task.triggerRule);
          const key = `${task.id}-${dateKey}`;
          if (rule === hhmm && !firedKeys.includes(key)) {
            const next = generateInstance(task.id, currentTime);
            if (next) addItem(toInboxItem(task, goal.id, currentTime));
            registerTrigger(key);
          }
        });
      });
    });
  }, [addItem, currentTime, firedKeys, generateInstance, goals, registerTrigger]);
}
