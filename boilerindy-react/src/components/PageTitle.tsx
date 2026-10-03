// Per-route tab titles (issue #367). React 19 hoists a <title> rendered
// anywhere in the tree into <head>, ahead of index.html's static title, and
// removes it when the page unmounts, so the static one comes back. No library
// or hook needed. React wants a <title>'s children as one string, hence the
// template literal.
export default function PageTitle({ children }: { children: string }) {
  return <title>{`${children} - BoilerIndy`}</title>
}
