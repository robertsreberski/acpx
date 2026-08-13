import { type ReactNode, useEffect, useId, useRef, useState } from "react";

export interface ComboboxOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

/**
 * A text input that offers known values without refusing unknown ones.
 *
 * Every field this backs — workspace, mode, model — has values the console can
 * discover but cannot guarantee it knows all of. A plain `<select>` would make
 * the undiscovered ones unreachable, so the typed value is always authoritative
 * and the list is a shortcut.
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  loading = false,
  disabled = false,
  required = false,
  emptyHint,
  inputRef,
  labelledBy,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly ComboboxOption[];
  readonly placeholder?: string;
  readonly loading?: boolean;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly emptyHint?: ReactNode;
  readonly inputRef?: React.Ref<HTMLInputElement>;
  /** Id of the visible label, which is a sibling rather than a wrapping element. */
  readonly labelledBy?: string;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputElement = useRef<HTMLInputElement | null>(null);
  const setInputElement = (node: HTMLInputElement | null) => {
    inputElement.current = node;
    if (typeof inputRef === "function") {
      inputRef(node);
    } else if (inputRef) {
      inputRef.current = node;
    }
  };

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setActive(-1);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  // A stale highlight would commit the wrong option once the list reloads.
  useEffect(() => setActive(-1), [options]);

  const commit = (option: ComboboxOption) => {
    onChange(option.value);
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (options.length === 0) {
        return;
      }
      event.preventDefault();
      setOpen(true);
      setActive((current) => {
        const next = event.key === "ArrowDown" ? current + 1 : current - 1;
        return (next + options.length) % options.length;
      });
      return;
    }
    if (event.key === "Enter" && open && active >= 0 && options[active]) {
      // Only swallow Enter when it is choosing an option, so the form can still
      // be submitted from the field.
      event.preventDefault();
      commit(options[active]);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div
      className="combobox"
      ref={rootRef}
      // Escape is handled for the whole widget: pressed while an option has
      // focus it would otherwise reach the dialog and close that instead.
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
          setActive(-1);
          inputElement.current?.focus();
        }
      }}
    >
      <input
        ref={setInputElement}
        aria-labelledby={labelledBy}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          // Typing invalidates the highlight. Without this, highlighting one
          // option and then typing a different value commits the highlight on
          // Enter — which in the Mode field silently replaces a typed
          // `read-only` with a write-capable mode.
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
      />
      {loading && <small>Loading…</small>}
      {!loading && options.length === 0 && emptyHint}
      {open && options.length > 0 && (
        <ul className="combobox-list" id={listId} role="listbox">
          {options.map((option, index) => (
            <li key={option.value}>
              <button
                type="button"
                id={`${listId}-${index}`}
                tabIndex={-1}
                role="option"
                aria-selected={option.value === value}
                className={`combobox-option${index === active ? " is-active" : ""}`}
                // The input's blur must not beat the click that commits.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => commit(option)}
              >
                <span>{option.label}</span>
                {option.hint && <em>{option.hint}</em>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
