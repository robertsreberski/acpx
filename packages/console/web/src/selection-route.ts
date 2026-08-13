export const sessionIdFromPath = (pathname: string): string | null => {
  const match = /^\/sessions\/([^/]+)\/?$/u.exec(pathname);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1] ?? "") || null;
  } catch {
    return null;
  }
};
