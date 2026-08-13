export const shouldSubmitComposerKey = (
  key: string,
  shiftKey: boolean,
  isComposing: boolean,
): boolean => key === "Enter" && !shiftKey && !isComposing;
