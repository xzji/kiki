type KeyboardEventLike = {
  keyCode?: number;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
};

export function isImeCompositionKeyEvent(event: KeyboardEventLike, composing = false) {
  return Boolean(
    composing ||
      event.nativeEvent?.isComposing ||
      event.nativeEvent?.keyCode === 229 ||
      event.keyCode === 229,
  );
}
