# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the library source. Keep canonical request/response logic in `src/core/`, provider integrations in `src/adapters/`, reusable stream utilities in `src/helpers/`, and shared types in `src/types/`. The public entrypoint is `src/index.ts`.

`tests/` holds Bun test suites plus shared fixtures such as `tests/fixtures.ts`. `examples/` contains runnable usage samples like `examples/basic.ts` and `examples/tool-loop.ts`. `dist/` is generated output from the packaging build and should not be edited by hand.

## Build, Test, and Development Commands

- `bun install` installs dependencies.
- `bun run typecheck` runs strict TypeScript validation without emitting files.
- `bun run lint` checks the codebase with `oxlint`; use `bun run lint:fix` for safe autofixes.
- `bun run format` applies `oxfmt`; `bun run format:check` verifies formatting in CI style.
- `bun test` runs the full Bun test suite.
- `bun run example:basic`, `bun run example:multi-turn`, and `bun run example:tool-loop` execute sample integrations.
- `bun run prepack` builds the package with `tsdown` into `dist/`.

## Coding Style & Naming Conventions

This repository uses TypeScript ESM with 2-space indentation, semicolons, double quotes, trailing commas, and LF line endings. `oxfmt` enforces formatting, and `oxlint` enforces import correctness and general safety rules.

Follow existing naming patterns: kebab-case filenames such as `chat-completions.ts`, PascalCase for exported classes and types, and camelCase for functions, variables, and helpers. Add public exports through the existing index files instead of reaching into deep paths from consumers.

## Testing Guidelines

Tests use `bun:test` and live in `tests/*.test.ts`. Name suites after the unit or scenario under test, for example `responses-adapter.test.ts` or `scenarios.test.ts`. Favor behavior-focused `describe`/`it` blocks and cover event ordering, replay round-trips, warnings, and adapter-specific edge cases. Use `MockAdapter` and shared fixtures when validating streaming behavior.

## Commit & Pull Request Guidelines

Recent history follows conventional prefixes such as `feat(mock): ...`, `refactor(types): ...`, `docs: ...`, `build: ...`, and `chore: ...`. Keep scopes aligned with the subsystem you changed.

Pull requests should summarize behavior changes, list verification commands run locally, and link the relevant issue when applicable. Include example output or event traces when changing stream semantics or adapter behavior.

## Configuration & Secrets

Use environment variables for provider credentials, such as `OPENAI_API_KEY`. Do not hardcode secrets in source, examples, or tests.
