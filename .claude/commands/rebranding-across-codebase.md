---
name: rebranding-across-codebase
description: Workflow command scaffold for rebranding-across-codebase in boilerindy.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /rebranding-across-codebase

Use this workflow when working on **rebranding-across-codebase** in `boilerindy`.

## Goal

Systematically update all references to a product or brand name throughout the entire codebase, including directory names, package names, user-facing strings, assets, and documentation.

## Common Files

- `**/package.json`
- `**/package-lock.json`
- `**/public/favicon.svg`
- `**/public/icons.svg`
- `**/src/components/**/*.jsx`
- `**/src/pages/**/*.jsx`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Rename relevant directories and files (e.g., hackindy-react/ to boilerindy-react/).
- Update package.json and package-lock.json with new names.
- Replace brand references in code files, environment templates, and documentation.
- Update assets such as favicons and logos.
- Change user-facing strings in UI components and pages.

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.