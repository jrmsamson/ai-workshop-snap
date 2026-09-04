# Snap — TypeScript attendee scaffold

Implement the contract in the packaged `SPEC.md`; the language-neutral public
tests are the acceptance criteria. Use strict TypeScript, avoid `any`, and use
`node:` prefixes for Node built-ins.

## File layout

- `src/main.ts` — entry point and CLI dispatch (env → parse → command → exit code).
- `src/cli/` — argument parsing and the command implementations (`run*` per command).
- `src/core/` — pure, effect-free domain logic: version algebra, tracked-path and
  text validation, canonical diff, OT, and patch/change application.
- `src/format/` — on-disk JSON: a total RFC 8259 parser and Effect `Schema`
  documentation of the repository/config shapes.
- `src/repository/` — repository validation and canonical serialization, replay,
  config read/write, and filesystem materialization + working-tree scanning.
- `src/http/` — the `serve` snapshot server and `fetchRepository`.
- `src/presentation/` — terminal output: SGR styling, color resolution, render helpers.
- `snap` — the executable shim the harness runs.

Colocated `*.test.ts` files live next to the module they exercise.

## Setup, build, run, and test

```bash
npm ci
npm run preflight               # type-check + lint + format check (the gate)
npm run build                   # type-check (alias of `npm run typecheck`)
npm run typecheck               # tsc --noEmit
npm run lint                    # eslint (strictTypeChecked)
npm run format                  # prettier --write
npm test                        # node:test unit tests (tsx --test src/**/*.test.ts)
npm start -- <arguments>        # run the CLI
./snap <arguments>              # executable used by the public harness
```

Language-specific unit tests live colocated under `src/` as `*.test.ts` and are
part of the `preflight` surface (typechecked, linted, formatted). They cover the
pure core (version algebra, canonical diff, OT, path/text validation) and the
`auto` presentation TTY-selection matrix that the public YAML harness cannot
exercise. The public language-neutral verifier remains the acceptance criteria:

```bash
./verify --lang ts
```

Production code uses Node built-ins (`node:`) for filesystem, process, and
HTTP. `effect` is the sanctioned runtime dependency: use data-first functions,
typed errors (`Effect<A, E, R>`, no `throw`), and `Schema` to validate and
document on-disk formats. No `any`. `tsx`, TypeScript, Node typings, and
lint/format tooling are development dependencies.

Notes:

- `VERSION` for `snap --version` is a constant in `src/` (value `1.0.0`) and is
  intentionally decoupled from `package.json`'s `version` field (cosmetic).
- `effect` pulls `fast-check` and `@standard-schema/spec` in as **runtime**
  transitive dependencies; they are not direct dependencies.
- `engines.node` is `">= 22"` (advisory only; the hard floor for
  `import.meta.dirname` is Node 20.11).
- The editor language service is `@effect/language-service`; enforcement is the
  scripts above, not the editor.
