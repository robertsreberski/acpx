import type { SVGProps } from "react";

const paths = {
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <path d="m21 21-4.35-4.35m2.35-5.15A7.5 7.5 0 1 1 4 11.5a7.5 7.5 0 0 1 15 0Z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5m0-8h.01" />
    </>
  ),
  close: <path d="m6 6 12 12M18 6 6 18" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  send: <path d="m4 4 16 8-16 8 3-8-3-8Zm3 8h13" />,
  chevron: <path d="m9 18 6-6-6-6" />,
  back: <path d="m15 18-6-6 6-6" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </>
  ),
  check: <path d="m5 13 4 4 10-10" />,
  archive: (
    <>
      <path d="M4 7h16v13H4zM3 4h18v3H3z" />
      <path d="M9 11h6" />
    </>
  ),
  spark: (
    <path d="m12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4L12 3Zm6 11 .7 2.3L21 17l-2.3.7L18 20l-.7-2.3L15 17l2.3-.7L18 14Z" />
  ),
} as const;

export function Icon({
  name,
  size = 18,
  ...props
}: SVGProps<SVGSVGElement> & {
  readonly name: keyof typeof paths;
  readonly size?: number;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
