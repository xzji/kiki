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
  assert.equal(screenshotWidth.detailWidth, 624);
  assert.equal(screenshotWidth.monitorRightOffset, 624);

  const compactWidth = assertFitsViewport({ viewportWidth: 800, monitorWidth: 400 });
  assert.equal(compactWidth.monitorWidth, 336);
  assert.equal(compactWidth.detailWidth, 464);

  const withAssistant = assertFitsViewport({ viewportWidth: 1024, assistantOpen: true, monitorWidth: 400 });
  assert.equal(withAssistant.assistantOffset, 400);
  assert.equal(withAssistant.monitorWidth + withAssistant.detailWidth, 624);

  const detailOnly = resolveTaskPanelLayout({
    viewportWidth: 1024,
    assistantOpen: false,
    isMobile: false,
    monitorOpen: false,
    detailOpen: true,
    monitorWidth: 400,
  });
  assert.equal(detailOnly.detailWidth, 640);
  assert.equal(detailOnly.detailRightOffset, 0);

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
