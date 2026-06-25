import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import * as drawerModule from "@/components/conversation/GoalPlanDrawer";
import { useGoalStore } from "@/stores/goalStore";

const GoalPlanDrawer =
  drawerModule.GoalPlanDrawer ??
  (drawerModule as unknown as { default: typeof drawerModule }).default.GoalPlanDrawer;

export function runGoalPlanDrawerSpecs() {
  const originalGoalState = useGoalStore.getState();

  try {
    useGoalStore.setState({
      ...originalGoalState,
      goals: [],
      pendingConversationGoalDeletes: [],
      optimisticTaskRuns: [],
    });

    const html = renderToStaticMarkup(
      React.createElement(GoalPlanDrawer, {
        goalId: "goal-bound-but-not-yet-projected",
        open: true,
        focusSubGoalId: null,
        onClose: () => {},
      }),
    );

    assert.notEqual(
      html,
      "",
      "opened goal plan drawer should render a visible shell even before the goal projection is hydrated",
    );
    assert.match(html, /主题规划/);
    assert.match(html, /暂时找不到这个目标规划|正在加载目标规划/);
  } finally {
    useGoalStore.setState(originalGoalState);
  }
}
