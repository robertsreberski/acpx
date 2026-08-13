const timestamp = (value: string): number | undefined => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const roundRelative = (value: number): number => Math.sign(value) * Math.round(Math.abs(value));

export const relativeSessionTime = (
  value: string,
  now = Date.now(),
  locales?: Intl.LocalesArgument,
): string => {
  const parsed = timestamp(value);
  if (parsed === undefined) {
    return "Unknown time";
  }
  const seconds = roundRelative((parsed - now) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(locales, { numeric: "auto" });
  if (Math.abs(seconds) < 60) {
    return formatter.format(seconds, "second");
  }
  const minutes = roundRelative(seconds / 60);
  if (Math.abs(minutes) < 60) {
    return formatter.format(minutes, "minute");
  }
  const hours = roundRelative(minutes / 60);
  if (Math.abs(hours) < 24) {
    return formatter.format(hours, "hour");
  }
  return formatter.format(roundRelative(hours / 24), "day");
};

/**
 * Compact age for the session list, where a full "2 minutes ago" would crowd the
 * row title. Falls back to an em dash rather than a sentence when unparseable.
 */
export const compactSessionTime = (value: string, now = Date.now()): string => {
  const parsed = timestamp(value);
  if (parsed === undefined) {
    return "—";
  }
  const seconds = Math.max(0, Math.round((now - parsed) / 1_000));
  if (seconds < 45) {
    return "now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${Math.max(1, minutes)}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d` : `${Math.round(days / 7)}w`;
};

export const absoluteSessionTime = (value: string, locales?: Intl.LocalesArgument): string => {
  const parsed = timestamp(value);
  if (parsed === undefined) {
    return "Unknown time";
  }
  return new Intl.DateTimeFormat(locales, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
};
