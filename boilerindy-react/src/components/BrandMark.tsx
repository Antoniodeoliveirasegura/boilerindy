// The Monument Circle brand mark beside the "BoilerIndy" name (issues #408, #433).
//
// Two single-colourway copies of public/app-icon.svg without its tile, so the
// monument on its ring sits straight on the page, split out by
// scripts/render-icons.mjs and switched by the `dark` class that theme-init.js and
// the in-app toggle put on <html>, so the mark changes with the app's theme and
// not the device's. Two things that look simpler would not:
// - the adaptive app-icon.svg as an <img> follows the device setting, and
//   inlined its <style> (.dark{display:none}) would match <html class="dark">
//   and hide the whole app;
// - `in-[.dark]:` matches the class on an ancestor. (index.css now points
//   Tailwind's `dark:` variant at the same class; this predates that and works
//   either way.)
//
// On a surface that is dark in both themes (an ink panel such as the sign-in
// brand panel or a departures board), pass surface="ink": the gold copy for
// dark backgrounds is then the only one rendered.
//
// Decorative: alt="" on both, so the name beside the mark stays the accessible
// name of the link or heading around it.
type BrandMarkProps = {
  /** Width and height in CSS pixels. */
  size?: number
  className?: string
  /** 'page' (default) follows the theme; 'ink' always uses the copy for dark backgrounds. */
  surface?: 'page' | 'ink'
}

export default function BrandMark({ size = 28, className = '', surface = 'page' }: BrandMarkProps) {
  if (surface === 'ink') {
    return (
      <span className={`inline-flex shrink-0 ${className}`}>
        <img src="/brand/mark-dark.svg" alt="" width={size} height={size} className="block" />
      </span>
    )
  }
  return (
    <span className={`inline-flex shrink-0 ${className}`}>
      <img src="/brand/mark-light.svg" alt="" width={size} height={size} className="block in-[.dark]:hidden" />
      <img src="/brand/mark-dark.svg" alt="" width={size} height={size} className="hidden in-[.dark]:block" />
    </span>
  )
}
