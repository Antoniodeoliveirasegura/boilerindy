// Registers @testing-library/jest-dom's custom matchers (toBeInTheDocument,
// toHaveTextContent, toHaveAttribute, …) on Vitest's `expect` so the .ts/.tsx
// test files type-check. The matchers are wired up at runtime in
// vitest.setup.js. Migrated to TypeScript (issue #20).
import '@testing-library/jest-dom/vitest'
