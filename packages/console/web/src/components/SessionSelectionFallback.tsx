export function SessionSelectionFallback({
  onRetry,
  onOpenSessions,
}: {
  readonly onRetry: () => void;
  readonly onOpenSessions: () => void;
}) {
  return (
    <section className="welcome-panel" aria-live="polite">
      <div className="welcome-mark" aria-hidden="true">
        A
      </div>
      <h1>Opening session…</h1>
      <p>If the session does not appear, retry the load or choose another session.</p>
      <div>
        <button type="button" className="primary-button" onClick={onRetry}>
          Retry
        </button>
        <button type="button" className="secondary-button" onClick={onOpenSessions}>
          Sessions
        </button>
      </div>
    </section>
  );
}
