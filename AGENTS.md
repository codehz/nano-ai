# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the library source, layered by dependency direction (only import downward):

- `src/types/` — pure canonical types
- `src/runtime/` — client, normalize, validation, errors
- `src/stream/` — event factory, aggregator, `collectStream`
- `src/canonical/` — content/item/replay constructors and pure mapping helpers
- `src/provider/` — adapter base, transport, security, usage/reasoning mapping (internal infrastructure)
- `src/adapters/` — provider integrations

The public entrypoint is `src/index.ts`. Prefer deep imports for internal modules; do not import the root entry from within `src/`.

Custom adapters should implement the public `BackendAdapter` interface only; do not depend on internal `AdapterBase` (or other `src/provider/*` scaffolding) from application code.

### Event-authority streaming (no dual-track output)

HTTP adapters must not maintain a parallel `OutputItem[]` content ledger alongside stream events. Item lifecycle goes through `createStreamingItemSession` (`src/provider/streaming-item-session.ts`): yield start/delta/complete events and build canonical replay via `replayFromOutput(session.completedItems())`, then append wire-level opaque envelopes. Full `AIResponse` (`output` / `text` / `toolCalls` / …) is produced only by `collectStream` / the aggregator; `response.completed` carries replay + completion metadata only.

### Opaque replay protocol

HTTP adapters restore wire turns from `input` items with `type: "opaque"`:

1. **Filter** — only `source === <adapterSource>` and `purpose === "replay"`; otherwise ignore.
2. **Envelope** — `assertOpaqueReplayEnvelope` (object, ≤64KB, depth ≤8); failures throw `AIRequestError` / `INVALID_OPAQUE_REPLAY`.
3. **Replace trailing turn** — before appending an assistant/model wire turn, rollback trailing messages of that role (`assistant` for chat/messages/ollama, `model` for gemini), then append. Single-assistant opaque payloads use the same replace semantics as `replaceCanonical: true`. Responses uses id / `previous_response_id` continuation instead of stacking assistant wire messages (canonical non-opaque input wins).
4. **Shapes** — known invalid shapes throw `INVALID_OPAQUE_REPLAY`; unrecognized shapes after a valid envelope are skipped.

Use `acceptOpaqueReplay` from `src/provider/opaque-replay.ts` at the start of each adapter's `case "opaque"`.

`tests/` mirrors source layers (`types/`, `runtime/`, `stream/`, `provider/`, `adapters/`, `scenarios/`) plus shared `tests/fixtures.ts`. `examples/` contains runnable usage samples like `examples/basic.ts` and `examples/tool-loop.ts`. `dist/` is generated output from the packaging build and should not be edited by hand.

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
