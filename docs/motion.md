# Motion

How things move on boilerindy.app: the duration and easing tokens, what
animates and when, Reduce Motion, and how to add an animation that fits. The
values are the iOS app's Option D motion spec, so the site and the app move
alike; the owner picked this flavour from a live prototype on 2026-10-26.
Everything is CSS in `boilerindy-react/src/index.css` plus a few lines of
script (`src/lib/motion.ts`, `src/hooks/usePresence.ts`,
`src/hooks/useEntrance.ts`). There is no animation library, so nothing is
added to the bundle and the CSP needs no change.

## Tokens

In the `@theme` block of `index.css`, pinned by `test/motionCss.test.mjs`.

| Token | Value | Used for |
|---|---|---|
| `--motion-fast` | 150ms | a menu leaving; the fades Reduce Motion keeps |
| `--motion-scrim` | 200ms | a dialog's backdrop fading in |
| `--motion-base` | 260ms | anything closing; a menu opening |
| `--motion-slow` | 420ms | rows and page blocks rising; the nav bar sliding; the drawer opening |
| `--motion-sheet` | 460ms | a dialog, the assistant panel or a toast arriving |
| `--motion-roll` | 560ms | a board digit rolling over |
| `--motion-stagger` | 40ms | between rows, blocks and digits |
| `--motion-rise` | 10px | how far a row or block rises |
| `--ease-sheet` | `cubic-bezier(0.32, 1.18, 0.5, 1)` | dialogs, the assistant panel, toasts arriving: a small overshoot |
| `--ease-spring` | `cubic-bezier(0.34, 1.3, 0.64, 1)` | menus opening, the nav bar sliding |
| `--ease-out-expo` | `cubic-bezier(0.16, 1, 0.3, 1)` | rows and page blocks; the drawer, which must not overshoot the screen's edge |
| `--ease-roll` | `cubic-bezier(0.34, 1.25, 0.64, 1)` | board digits |
| `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | anything leaving |
| `--ease-snap` | `cubic-bezier(0.2, 0, 0, 1)` | colour changes, still 120ms |

## What moves

- **Dialogs, menus and toasts.** The root carries `data-motion="open"` or
  `"closed"`. A dialog's backdrop (`.motion-scrim`) fades in over 200ms while
  its card (`.motion-sheet`) rises 16px on `--ease-sheet` over 460ms; closing
  takes 260ms and drops it 12px. A menu (`.motion-pop`) grows from its button
  in 260ms and leaves in 150ms. A toast (`.motion-toast`) rises from below the
  edge in 460ms and leaves in 260ms. In use: ConfirmDialog (and every
  `useConfirm`), ReportDialog, DishDialog, the admin create-account dialog,
  the account menu, MajorPicker and UpdateToast.
- **Page changes.** Moving to another page puts `data-route-enter` on
  `<main>` (AppLayout), and the page's blocks (the children of `.page`, or of
  its `.page-measure`) rise 10px, 40ms apart, the first eight one by one. Not
  on the first page load, which paints as fast as it can; not for a query
  string or a hash; not between the admin console's sections
  (`routeEntranceKey` in `lib/motion.ts`). The navbar and tab bar never move.
- **Lists and grids.** `useEntrance(ready, key)` lets a list's rows rise the
  same way when its content lands after a skeleton and when its filter
  changes. Never on the first render, a refetch, a live update or a reorder;
  a row that arrives later on its own rises by itself (`data-arrive`). Inside
  a page that is rising after a navigation it stays still, so the two never
  stack.
- **Nav bars.** The tab bar and the top bar each have one amber bar that slides
  to the current stop on `--ease-spring`, and fades out on a page that is not
  a stop. The top bar measures its links, which are as wide as their labels.
- **Board digits.** `FlapDigit` rolls a departures board digit over when it
  changes, and in from a blank tile when the board first shows, 40ms apart per
  tile: Home's Next class and the Landing preview.
- **Drawer and assistant panel.** Their CSS transitions use the same tokens:
  in on `--motion-slow` or `--motion-sheet`, out on `--motion-base` and
  `--ease-exit`.
- **Unchanged.** Hover changes colour only and a press moves 1px: no hover
  lifts, no parallax. The ambient pulses (the live dot, the "now" stop ring,
  skeletons) and the task check-off reward are as they were.

## Rules

- Only `transform` and `opacity` animate, so nothing shifts the layout and
  older phones stay smooth. `test/motionCss.test.mjs` checks every `motion-*`
  keyframe.
- Things close faster than they open.
- An overlay hands focus back to its opener when `open` turns false, as its
  exit starts, not when it unmounts; a closing overlay is `inert` and takes no
  taps.
- An entrance plays once: its attribute comes off when the rise has finished
  (`riseOnce`), so a re-render cannot replay it.
- Reduce Motion stops everything (the block at the end of `index.css`),
  except a 150ms fade with no movement on dialogs, menus and toasts, so they
  still visibly open and close. The page, rows, nav bar and digits change at
  once.

## Adding motion

- **An overlay.** `const { attach, mounted, motion } = usePresence(open)`,
  render nothing while `!mounted`, and put `ref={attach}`,
  `data-motion={motion}` and `inert={!open}` on its root. Destructure it: the
  React Compiler's lint takes an object read for a `ref` prop for a ref and
  refuses its other fields during render. Give the children `.motion-scrim`
  and `.motion-sheet`, or the root `.motion-pop` or `.motion-toast`. Keep
  focus handling, key traps and scroll locks in effects keyed on `open`. A
  layout effect that hands focus back in its cleanup should do it again in
  its closed run: React puts focus back on what had it before the commit when
  that element is still on the page, as a closing dialog's controls are
  (`ReportDialog`). If the page clears what the overlay shows as it closes,
  keep the last value so it still reads the same on the way out (`useConfirm`,
  `ReportDialog`, `DishDialog`). `opening` counts openings, for a key that
  gives every opening a fresh form.
- **A list.** `const rowsRef = useEntrance<HTMLUListElement>(!isPending, filter)`
  and `ref={rowsRef}` on the element whose children are the rows. Key on what
  the student picked (a filter, a tab, a search), never on data.
- **New keyframes.** Name them `motion-*`, use only `transform` and `opacity`,
  read the tokens, and add them to `test/motionCss.test.mjs`.

## Testing

jsdom has no Web Animations API, so under Vitest an overlay leaves in the
commit that closes it and nothing rises, as before. A test that needs an exit
or an entrance in flight installs the fake in `src/lib/fakeAnimations.ts` and
finishes the animation itself (see `usePresence.test.tsx` and the dialog
tests). In Playwright an element is clicked once it holds still; a test that
taps by coordinates waits for `getAnimations()` to finish first, like
`settledBox` in `e2e/mobile-layout.spec.js`.
