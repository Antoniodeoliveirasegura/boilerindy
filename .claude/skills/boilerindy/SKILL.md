```markdown
# boilerindy Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches you how to effectively contribute to the `boilerindy` codebase, a JavaScript project built on the Express framework. You'll learn the repository's coding conventions, commit patterns, and structured workflows for rebranding, feature development, documentation, and UI updates. The guide also covers testing patterns and provides convenient commands for common tasks.

## Coding Conventions

### File Naming
- Use **PascalCase** for file names.
  - Example: `RateLimiter.mjs`, `BoardEditor.jsx`

### Import Style
- Use **absolute imports** throughout the codebase.
  - Example:
    ```js
    import { BoardEditor } from 'boilerindy-react/src/components/BoardEditor.jsx';
    ```

### Export Style
- Use **named exports** for modules and components.
  - Example:
    ```js
    // BoardEditor.jsx
    export function BoardEditor(props) { ... }
    ```

### Commit Patterns
- **Conventional commits** are used.
  - Prefixes: `fix`, `feat`, `rebrand`, `docs`
  - Example:
    ```
    feat: add rate limiting to API endpoints
    rebrand: update all references from HackIndy to BoilerIndy
    ```

## Workflows

### Rebranding Across Codebase
**Trigger:** When renaming the application or updating branding (e.g., HackIndy → BoilerIndy)  
**Command:** `/rebrand`

1. Rename relevant directories and files (e.g., `hackindy-react/` → `boilerindy-react/`).
2. Update `package.json` and `package-lock.json` with the new names.
3. Replace all brand references in code files, environment templates, and documentation.
4. Update assets such as `favicon.svg` and `icons.svg`.
5. Change user-facing strings in UI components and pages.
6. Update configuration files and deployment settings (e.g., `vercel.json`, `server.mjs`).

**Example:**  
```js
// Before
export const APP_NAME = "HackIndy";

// After
export const APP_NAME = "BoilerIndy";
```

### Feature Implementation with UI and Backend
**Trigger:** When adding or enhancing a feature that spans backend and frontend  
**Command:** `/feature`

1. Implement backend logic or endpoints (e.g., update `server.mjs`, add `rateLimiter.mjs`).
2. Update or create documentation for the new feature.
3. Update `.env.example` and other configuration as needed.
4. Update or add frontend components and context/state files.
5. Modify or create new UI elements and pages to expose the feature.
6. Persist new settings or data locally (e.g., using `localStorage`).

**Example:**  
```js
// server.mjs
export function rateLimiter(req, res, next) { ... }

// boilerindy-react/src/components/RateLimitBadge.jsx
export function RateLimitBadge({ limit }) { ... }
```

### Documentation and Env Template Update
**Trigger:** When adding features, changing configuration, or improving onboarding  
**Command:** `/docs-update`

1. Edit or add sections to `README.md` and other documentation files.
2. Update `.env.example` files with new variables or clearer instructions.
3. Add or update feature-specific documentation (e.g., `docs/RATE_LIMITS.md`).

**Example:**  
```md
# .env.example
SUPABASE_URL=your-supabase-url
SUPABASE_KEY=your-supabase-key
RATE_LIMIT=100
```

### UI String and Badge Update
**Trigger:** When changing displayed names, badges, or clarifying UI text  
**Command:** `/ui-string-update`

1. Edit relevant UI components and pages to update strings or badges.
2. Replace or update visual badge assets if necessary.
3. Test changes in the UI to ensure consistency.

**Example:**  
```jsx
// Before
<span className="badge">HackIndy</span>

// After
<span className="badge">BoilerIndy</span>
```

## Testing Patterns

- Test files follow the pattern: `*.test.*`
- Testing framework is **unknown** (not specified in the repository).
- Place test files alongside the modules they test or in dedicated test directories.
- Example:
  ```
  BoardEditor.test.jsx
  server.test.mjs
  ```

## Commands

| Command           | Purpose                                                    |
|-------------------|------------------------------------------------------------|
| /rebrand          | Systematically update all branding references               |
| /feature          | Add or enhance a feature across backend and frontend        |
| /docs-update      | Update documentation and environment variable templates     |
| /ui-string-update | Update user-facing strings and badges in the UI             |
```