import type { PermissionOption } from "./types";

/**
 * The allow-kind option is the answer the operator most likely wants, so it
 * becomes the dock's primary action. Everything else keeps the adapter's own
 * order in the quiet row — the console never invents or drops an option the
 * agent offered, even though the design mock shows a fixed set of three.
 */
export const orderPermissionOptions = (
  options: readonly PermissionOption[] = [],
): { readonly primary?: PermissionOption; readonly secondary: readonly PermissionOption[] } => {
  if (options.length === 0) {
    return { secondary: [] };
  }
  const primaryIndex = Math.max(
    0,
    options.findIndex((option) => option.kind?.startsWith("allow")),
  );
  return {
    primary: options[primaryIndex],
    secondary: options.filter((_, index) => index !== primaryIndex),
  };
};
