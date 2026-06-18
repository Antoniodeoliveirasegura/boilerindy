# Design playground — PROTOTYPE (throwaway)

**Question it answers:** What visual direction should the BoilerIndy public website take?

**Shape:** Four radically different full-page redesigns of the landing/marketing page,
all rendering the *same* content ([playgroundContent.ts](./playgroundContent.ts)) so only
the design differs. Switch between them with the floating bottom bar (← →, or the arrow keys)
or directly via the `?variant=` URL param.

**How to view (dev only):**

```
pnpm --prefix boilerindy-react dev      # or: npm run dev --prefix boilerindy-react
# then open:
http://localhost:5173/design-playground          (defaults to variant A)
http://localhost:5173/design-playground?variant=C
```

The route is gated on `import.meta.env.DEV` in [../../App.tsx](../../App.tsx), so it is
compiled out of production builds and can never ship to users.

## The four directions

| Key | File | Direction | Feel |
|-----|------|-----------|------|
| A | [BrutalistVariant.tsx](./BrutalistVariant.tsx) | Neo-brutalist | Hard offset shadows, thick black borders, blocky uppercase type — loud, light |
| B | [EditorialVariant.tsx](./EditorialVariant.tsx) | Swiss / editorial | Strict type grid, hairline rules, numbered sections, whitespace — quiet, light |
| C | [LuxeVariant.tsx](./LuxeVariant.tsx) | Dark luxe / glass | Near-black, glowing gold, frosted-glass panels, serif display — premium, dark |
| D | [TerminalVariant.tsx](./TerminalVariant.tsx) | Retro terminal "Campus OS" | CRT scanlines, monospace, window chrome, phosphor green — techy, dark |

## Verdict

> _Pending — pick a winner (or a mix, e.g. "B's layout with C's palette") and fill this in._

## When a direction wins — cleanup

1. Rewrite the winning variant properly into [../Landing.tsx](../Landing.tsx)
   (these variants were built under prototype constraints: no tests, inline colors, minimal a11y).
2. Delete this whole folder: `boilerindy-react/src/pages/prototype/`.
3. Remove the `DesignPlayground` lazy import + the `/design-playground` route from
   [../../App.tsx](../../App.tsx).
