import { Icon } from "./Icon";

export function MobileSessionListButton({
  open,
  onOpen,
}: {
  readonly open: boolean;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="mobile-back"
      aria-label="Open sessions"
      aria-controls="session-sidebar"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onOpen}
    >
      <Icon name="back" /> Sessions
    </button>
  );
}
