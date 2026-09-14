# rocq-comparator-web

The browser version of [rocq-comparator](https://github.com/LLM4Rocq/rocq-comparator),
modelled on the [Lean comparator site](https://comparator.live.lean-lang.org):
paste a challenge and a solution, click Run, and get a kernel-checked verdict.
The whole check runs in your browser. No source leaves your machine.

Live site: <https://llm4rocq.github.io/rocq-comparator-web/>

**Status.** This is a prototype. It was produced by Claude Fable 5.1
(Anthropic) under the direction of the project authors, and is inspired by the
[Lean comparator](https://github.com/leanprover/comparator). Expect rough
edges, and read `BACKEND.md` before relying on it for anything that matters.

## What runs in the browser

A real Rocq 9.2 kernel: the `rocq-comparator` library and `rocq-runtime` are
compiled to WebAssembly with `wasm_of_ocaml` and run in a Web Worker. The
checks are the same as the command-line tool's (statement and dependency
comparison in the kernel, axiom analysis, environment hygiene, the command
filter). Two things differ from the command line, by necessity:

- There is no `rocqchk` second pass, since a browser cannot start a process.
  The solution's proof is still type-checked by the kernel.
- There is no OS sandbox. The browser's own isolation plays that role.

Libraries are trusted, not re-checked, exactly as on the command line: a
library ships as `.vos` files (its interface, with proof bodies stripped), and
the solution is checked against the library's statements.

Two engines are shipped, the same build with two effect backends, and the
worker picks one: `engine-jspi` is smaller and faster and needs JS Promise
Integration (Chrome and Edge 137 or later); `engine-cps` needs no JSPI. If the
JSPI engine fails to start, the worker is restarted on `engine-cps` and the
page says so. Add `?engine=cps` or `?engine=jspi` to the page URL to force one.

## Browser support

Both engines are `wasm_of_ocaml` output and need three WebAssembly extensions:
GC, tail calls and exception handling. That means Chrome and Edge 119+,
Firefox 122+, Safari 18.2+ (iOS 18.2+). The page checks for them before
starting the engine and names the missing one. Safari on iOS may take a minute
or more to compile the engine; the page shows the elapsed time. A phone can run
the small checks but not the mathcomp-analysis packs, which need several GB of
memory.

## Libraries

Libraries are downloaded on first import and kept for the page session. The
worker reads the `Require` lines of both files and fetches only the packs they
need. The strip under the title lists the entry points and what a first import
costs:

| import | download |
|---|---|
| `From Stdlib Require Import ZArith.` | 30 MB |
| `From Equations Require Import Equations.` | 31 MB |
| `From mathcomp Require Import all_ssreflect.` | 36 MB |
| `From Coquelicot Require Import Coquelicot.` | 46 MB |
| `From mathcomp Require Import all_algebra.` | 122 MB |
| `From mathcomp Require Import all_ssreflect all_algebra all_reals all_analysis.` | 206 MB |

Available: the full Stdlib (582 modules), mathcomp 2.6 (all of it),
mathcomp-analysis 1.18, Coquelicot 3.4, Equations 1.3. Tactics such as `ring`,
`field`, `lia`, `lra`, ssreflect, Hierarchy Builder and Equations work; their
plugins are linked into the engines. A first mathcomp-analysis check takes one
to two minutes and needs several GB of browser memory. A check that runs past
the timeout in Advanced options (300 s by default; downloads do not count) is
stopped and says so.

No library is patched. A library ships only if its released opam version
builds unmodified on Rocq 9.2 with mathcomp 2.6. Interval is not shipped for
that reason and will be added when a release builds.

## Quick start

```sh
make serve         # assemble dist/ and serve it on http://localhost:8000/
make test          # node harness, both engines
make test-browser  # the served site in a headless Chrome or Brave, both engines
```

Serve `dist/`, never the repository root: the engines and the worker live only
there, and Web Workers do not load from `file://` URLs.

## Building

The committed `dist/` already contains the engines and the library packs, so
`make serve` and the GitHub Pages deploy need no OCaml at all.

Rebuilding needs the sibling core project's opam switch (Rocq 9.2, the
libraries, `wasm_of_ocaml`) and runs in a fixed order, because every compiled
library records the digests of what it was built against:

```sh
make bundle        # native -> stdlib -> mathcomp -> libs -> real
```

`native` builds a Rocq whose kernel is patched for a 32-bit target and
regenerates the Corelib; `stdlib`, `mathcomp` and `libs` compile the libraries
with it; `real` builds the two engines and stages `dist/`, ending with a native
probe that fails the build if the staged libraries are inconsistent. The core
switch's installed Rocq is never modified. Details, including every patch and
why it exists, are in `BACKEND.md`.

## Testing

- `make test` runs the node harness against both engines (28 cases each:
  Stdlib, mathcomp, analysis, Coquelicot and Equations proofs, rejections, lazy
  pack resolution).
- `make test-browser` serves `dist/` and drives a real headless browser through
  the DevTools protocol: runtime startup, the Run button, proofs across the
  libraries, rejections, lazy downloads, the progress events, the timeout, the
  fallback from a failing JSPI engine, the unsupported-browser message. Set
  `SMOKE_HEAVY=0` to skip the analysis case; `SMOKE_SHOT=file.png` saves a
  screenshot.
- `make test-live URL=https://...` runs the browser checks against a deployed
  site.

## Deploying

`.github/workflows/pages.yml` deploys `dist/` to GitHub Pages on every push to
`main`, after running the browser test on the runner. Everything is relative,
so the site works under any path.

## Layout

- `index.html`, `app.js`, `styles.css`: the page.
- `web/rocq_comparator.js`: the main-thread loader, `window.RocqComparator`.
- `web/rocq_worker.js`, `web/rocq_packs.js`: the worker and the lazy pack logic.
- `web/web_check.ml`: the OCaml seam between the page and the core library.
- `web/build-*.sh`, `web/stage-packs.sh`: the build.
- `test/judge_test.cjs`, `test/browser_smoke.cjs`: the tests.
- `dist/`: the deployable site, including the engines and `coqlib/packs.json`.
