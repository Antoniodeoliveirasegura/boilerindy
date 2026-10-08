// The Monument Circle brand mark beside the "BoilerIndy" name (issues #408, #433).
//
// Two single-colourway copies of public/app-icon.svg, split out by
// scripts/render-icons.mjs, switched by the `dark` class that theme-init.js and
// the in-app toggle put on <html>, so the mark changes with the app's theme and
// not the device's. Two things that look simpler would not:
// - the adaptive app-icon.svg as an <img> follows the device setting, and
//   inlined its <style> (.dark{display:none}) would match <html class="dark">
//   and hide the whole app;
// - Tailwind's `dark:` variant is the device setting too here (it compiles to
//   prefers-color-scheme), hence `in-[.dark]:`, which matches the class on an
//   ancestor.
//
// Decorative: alt="" on both, so the name beside the mark stays the accessible
// name of the link or heading around it.
type BrandMarkProps = {
  /** Width and height in CSS pixels. */
  size?: number
  className?: string
}

export default function BrandMark({ size = 28, className = '' }: BrandMarkProps) {
  return (
    <span className={`inline-flex shrink-0 ${className}`}>
      <img src="/brand/mark-light.svg" alt="" width={size} height={size} className="block in-[.dark]:hidden" />
      <img src="/brand/mark-dark.svg" alt="" width={size} height={size} className="hidden in-[.dark]:block" />
    </span>
  )
}
