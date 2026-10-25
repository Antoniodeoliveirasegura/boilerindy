// The loading ring: PageLoader's spinner, and the sign-in skeleton's beside its
// status line. Decorative, so whatever shows it says in words what is loading.
// It holds still for people who have asked for less motion.
export default function Spinner({ className = 'h-8 w-8 border-[3px]' }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 rounded-full border-[var(--color-border-2)] border-t-[var(--color-txt-0)] motion-safe:animate-spin ${className}`}
    />
  )
}
