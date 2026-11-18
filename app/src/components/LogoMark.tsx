/**
 * The Ardoise mark: a slate with ledger lines in chalk and the payment being
 * written in bitcoin orange. Inlined rather than loaded as an image so it
 * renders with the page; the paths are copied from `assets/logo/logo-mark.svg`,
 * which stays the source of truth for the brand files. When the mark changes,
 * update this file and `app/src/app/icon.svg` (a copy of `assets/logo/favicon.svg`) by hand.
 *
 * @param props.size Rendered width and height in pixels.
 * @param props.className Extra classes for the `<svg>` element.
 */
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={className} aria-hidden="true">
      <path
        d="M14,8 H50 A10,10 0 0 1 60,18 V46 A10,10 0 0 1 50,56 H14 A10,10 0 0 1 4,46 V18 A10,10 0 0 1 14,8 Z M14,12 A6,6 0 0 0 8,18 V46 A6,6 0 0 0 14,52 H50 A6,6 0 0 0 56,46 V18 A6,6 0 0 0 50,12 Z"
        fillRule="evenodd"
        fill="#2E2E2E"
      />
      <path
        d="M14,12 H50 A6,6 0 0 1 56,18 V46 A6,6 0 0 1 50,52 H14 A6,6 0 0 1 8,46 V18 A6,6 0 0 1 14,12 Z"
        fill="#111111"
      />
      <path
        d="M17,20 H47 A2,2 0 0 1 47,24 H17 A2,2 0 0 1 17,20 Z M17,30 H41 A2,2 0 0 1 41,34 H17 A2,2 0 0 1 17,30 Z M17,40 H31 A2,2 0 0 1 31,44 H17 A2,2 0 0 1 17,40 Z"
        fill="#F5F5F0"
      />
      <circle cx="41" cy="42" r="2" fill="#F7931A" />
    </svg>
  );
}
