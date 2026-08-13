/**
 * Register the installability worker.
 *
 * Registration is best-effort and never blocks the console: a browser without
 * service workers, or a context that refuses to register one, still gets the
 * full app — it simply cannot be installed to the home screen.
 */
export const registerInstallWorker = (): void => {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  // After load, so registration never competes with the first render.
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  });
};
