/** The store has already surfaced action failures as notices; consume the rejection at the UI edge. */
export const consumeUiAction = (action: Promise<unknown>): void => {
  void action.catch(() => undefined);
};
