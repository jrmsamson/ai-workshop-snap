# Snap — TypeScript attendee scaffold

Implement the contract in the packaged `SPEC.md`; the language-neutral public
tests are the acceptance criteria. Use strict TypeScript, avoid `any`, and use
`node:` prefixes for Node built-ins.

## Setup, build, run, and test

```bash
npm ci
npm run preflight               # type-check + lint + format check (the gate)
npm run build                   # type-check (alias of `npm run typecheck`)
npm run typecheck               # tsc --noEmit
npm run lint                    # eslint (strictTypeChecked)
npm run format                  # prettier --write
npm start -- <arguments>        # run the CLI
./snap <arguments>              # executable used by the public harness
```

The scaffold contains no private language-specific test suite. Run the packaged
language-neutral verifier from the repository root:

```bash
./verify --lang ts
```

Production code uses Node built-ins (`node:`) for filesystem, process, and
HTTP. `effect` is the sanctioned runtime dependency: use data-first functions,
typed errors (`Effect<A, E, R>`, no `throw`), and `Schema` to validate and
document on-disk formats. No `any`. `tsx`, TypeScript, Node typings, and
lint/format tooling are development dependencies.

Notes:

- `effect` pulls `fast-check` and `@standard-schema/spec` in as **runtime**
  transitive dependencies; they are not direct dependencies.
- `engines.node` is `">= 22"` (advisory only; the hard floor for
  `import.meta.dirname` is Node 20.11).
- The editor language service is `@effect/language-service`; enforcement is the
  scripts above, not the editor.
