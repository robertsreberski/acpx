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
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onOpen}
    >
      <Icon name="back" size={22} />
    </button>
  );
}
