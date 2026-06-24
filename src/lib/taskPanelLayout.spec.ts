import assert from "node:assert/strict";

import { resolveTaskPanelLayout } from "./taskPanelLayout";

function assertFitsViewport(input: {
  viewportWidth: number;
  assistantOpen?: boolean;
  monitorWidth: number;
}) {
  const layout = resolveTaskPanelLayout({
    viewportWidth: input.viewportWidth,
    assistantOpen: input.assistantOpen ?? false,
    isMobile: false,
    monitorOpen: true,
    detailOpen: true,
    monitorWidth: input.monitorWidth,
  });
  assert.ok(
    layout.monitorWidth + layout.detailWidth + layout.assistantOffset <= input.viewportWidth,
    `panels should fit ${input.viewportWidth}px viewport`,
  );
  return layout;
}

export function runTaskPanelLayoutSpecs() {
  const screenshotWidth = assertFitsViewport({ viewportWidth: 1024, monitorWidth: 400 });
  assert.equal(screenshotWidth.monitorWidth, 400);
  assert.equal(screenshotWidth.detailWidth, 600);
  assert.equal(screenshotWidth.monitorRightOffset, 600);

  const compactWidth = assertFitsViewport({ viewportWidth: 800, monitorWidth: 400 });
  assert.equal(compactWidth.monitorWidth, 350);
  assert.equal(compactWidth.detailWidth, 450);

  const withAssistant = assertFitsViewport({ viewportWidth: 1024, assistantOpen: true, monitorWidth: 400 });
  assert.equal(withAssistant.assistantOffset, 400);
  assert.equal(withAssistant.monitorWidth, 250);
  assert.equal(withAssistant.detailWidth, 374);
  assert.equal(withAssistant.monitorWidth + withAssistant.detailWidth, 624);

  const persistedWideWidth = assertFitsViewport({ viewportWidth: 1024, monitorWidth: 640 });
  assert.equal(persistedWideWidth.monitorWidth, 500);
  assert.equal(persistedWideWidth.detailWidth, 524);

  const monitorOnlyWideWidth = resolveTaskPanelLayout({
    viewportWidth: 1024,
    assistantOpen: false,
    isMobile: false,
    monitorOpen: true,
    detailOpen: false,
    monitorWidth: 640,
  });
  assert.equal(monitorOnlyWideWidth.monitorWidth, 500);

  const wideDetailWithMonitor = assertFitsViewport({ viewportWidth: 1920, monitorWidth: 400 });
  assert.equal(wideDetailWithMonitor.monitorWidth, 400);
  assert.equal(wideDetailWithMonitor.detailWidth, 600);
  assert.equal(wideDetailWithMonitor.monitorRightOffset, 600);

  const detailOnly = resolveTaskPanelLayout({
    viewportWidth: 1024,
    assistantOpen: false,
    isMobile: false,
    monitorOpen: false,
    detailOpen: true,
    monitorWidth: 400,
  });
  assert.equal(detailOnly.detailWidth, 600);
  assert.equal(detailOnly.detailRightOffset, 0);

  const wideDetailOnly = resolveTaskPanelLayout({
    viewportWidth: 1920,
    assistantOpen: false,
    isMobile: false,
    monitorOpen: false,
    detailOpen: true,
    monitorWidth: 400,
  });
  assert.equal(wideDetailOnly.detailWidth, 600);
  assert.equal(wideDetailOnly.detailRightOffset, 0);

  const mobile = resolveTaskPanelLayout({
    viewportWidth: 390,
    assistantOpen: true,
    isMobile: true,
    monitorOpen: true,
    detailOpen: true,
    monitorWidth: 400,
  });
  assert.equal(mobile.monitorWidth, 390);
  assert.equal(mobile.detailWidth, 390);
  assert.equal(mobile.assistantOffset, 0);
}
