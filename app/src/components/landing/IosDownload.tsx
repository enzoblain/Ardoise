/** Public TestFlight invitation for the native iOS app (ios/). */
export const TESTFLIGHT_URL = "https://testflight.apple.com/join/eN6eHGAR";

/**
 * Link to install the iOS app through TestFlight, styled like the landing
 * page's secondary links.
 */
export function IosDownload() {
  return (
    <a
      href={TESTFLIGHT_URL}
      target="_blank"
      rel="noreferrer"
      className="inline-flex w-fit items-center gap-2 rounded-full border border-[#262626] px-4 py-2 text-sm text-[#a1a1a1] transition-colors hover:border-[#4a4a4a] hover:text-white"
    >
      <svg aria-hidden viewBox="0 0 16 16" className="h-3.5 w-3.5 fill-current">
        <path d="M11.18 8.5c.02 2.04 1.79 2.72 1.81 2.73-.02.05-.28.97-.93 1.92-.56.82-1.14 1.64-2.06 1.66-.9.02-1.19-.53-2.22-.53-1.03 0-1.35.51-2.2.55-.89.03-1.56-.89-2.13-1.71-1.16-1.68-2.04-4.74-.85-6.8.59-1.03 1.64-1.68 2.78-1.69.87-.02 1.69.58 2.22.58.53 0 1.53-.72 2.57-.61.44.02 1.66.18 2.45 1.33-.06.04-1.46.86-1.44 2.57ZM9.5 3.5c.47-.57.79-1.36.7-2.15-.68.03-1.5.45-1.99 1.02-.44.5-.82 1.31-.72 2.08.76.06 1.53-.38 2.01-.95Z" />
      </svg>
      Get the iOS app (TestFlight) ↗
    </a>
  );
}
