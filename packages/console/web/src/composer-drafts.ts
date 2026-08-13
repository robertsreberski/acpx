export type ComposerDrafts = Readonly<Record<string, string>>;

export const composerDraftForSession = (
  drafts: ComposerDrafts,
  sessionId: string | null,
): string => (sessionId ? (drafts[sessionId] ?? "") : "");

export const setComposerDraftForSession = (
  drafts: ComposerDrafts,
  sessionId: string,
  value: string,
): ComposerDrafts => {
  if (value === "") {
    if (!(sessionId in drafts)) {
      return drafts;
    }
    const { [sessionId]: _removed, ...rest } = drafts;
    return rest;
  }
  if (drafts[sessionId] === value) {
    return drafts;
  }
  return { ...drafts, [sessionId]: value };
};

export const clearComposerDraftIfSent = (
  drafts: ComposerDrafts,
  sessionId: string,
  sentText: string,
): ComposerDrafts =>
  drafts[sessionId] === sentText ? setComposerDraftForSession(drafts, sessionId, "") : drafts;
