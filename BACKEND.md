# rocq-comparator-web — Backend spike

**Goal.** Run the whole `rocq-comparator` check *client-side* in the browser on a
WebAssembly/JS Rocq, no server — paste a challenge `.v` + a solution `.v`, name
theorems/axioms, click Run, get the JSON verdict. Modelled on Lean's
`comparator.live.lean-lang.org`.

**Scope of this document.** A *backend* spike: decide, with evidence, how the
browser gets a working Rocq that our comparator OCaml can call, and pin the
frontend↔backend contract. No UI. The core comparator at
`/Users/gbaudart/Project/llm4rocq/rocq-comparator` is **not** modified; this is a
separate project that consumes it as a library.

---

## TL;DR — decision

> **UPDATE (build phase 6): the shipped engine is WebAssembly, and there is no
> js_of_ocaml backend.** A real `rocq-comparator` check runs entirely
> client-side on a **`wasm_of_ocaml`** build of rocq-runtime 9.2. TWO engines
> ship — the SAME build differing only in the effects backend — and the worker
> loads exactly one, feature-detected at load:
> **`dist/engine-cps/`** (`--effects=cps`, ~12 MB `.wasm`) is the **default**
> (no JSPI needed); **`dist/engine-jspi/`**
> (`--effects=jspi`, ~5 MB `.wasm`) is a smaller/faster **upgrade** loaded only
> where `WebAssembly.Suspending` exists (Chrome/Edge ≥ 137, Node 24+). Both need
> WebAssembly GC, tail calls and exception handling (Chrome/Edge 119+, Firefox
> 122+, Safari 18.2+, Node 22+; §6.2). The
> `Sys.word_size=64` blocker is cleared surgically (patched
> `kernel.cma`/`lib.cma`/`clib.cma` overlay, core switch untouched); the Corelib
> prelude + a Stdlib subset (`ring`/`lia`/`lra`) load; the custom C primitives
> (float64, threads, and zarith `ml_z_*`) are supplied as WebAssembly
> (`web/rocq_shims.wat`) with zarith backed by JS `BigInt` (`web/rocq_zarith.js`)
> — because `wasm_of_ocaml` resolves C primitives from the WASM runtime only, not
> JS `//Provides`. Binary VFS assets (`.vo`, META) are fetched byte-exact via
> `web/rocq_bytes.js` (`String.fromCharCode`, **never** `TextDecoder`, whose
> WHATWG `latin1` is windows-1252 and corrupted `Prelude.vo` in real browsers).
> `make test` → **12 passed, 0 failed** for **each** engine (headless Node; incl.
> `nat`+induction, ZArith `ring`, Reals `lra`). The `js_of_ocaml` backend has
> been **removed** — the file tables and `BACKEND=js` mentions in §11-14 below are
> historical lineage. Jump to **§15** for the WASM mechanism.


| Question | Answer |
|---|---|
| Can our comparator OCaml + rocq-runtime 9.2 link to JS/WASM? | **Yes.** Only **4 trivial C stubs** missing (threads + getpid), **zero zarith stubs**. Proven this session. |
| Is there a hard blocker? | **Yes, exactly one, and it is well-understood:** the kernel's `Sys.word_size = 64` / `int_size ≥ 63` assumption. jsoo gives `int_size=32`, wasm_of_ocaml gives `int_size=31`. |
| Is it solved by known art? | **Yes.** jsCoq/wacoq/coq-lsp solve it with a small `coerce-32bit` kernel patch (force `uint63_31.ml`/`float64_31.ml`) + a `timeout` trampoline patch, then `wasm_of_ocaml`. |
| **Approach chosen** | **(a) jsoo/wasmoo-core**: compile our lib + a *patched* rocq-runtime to WASM. |
| Approach (b) reuse a prebuilt wacoq worker | **Rejected for the real product.** Our kernel checks are OCaml that must run where rocq-runtime runs; a prebuilt worker only speaks a vernac/text protocol, which degrades us to `Module M.` + `Print Assumptions` and **loses every guarantee** the comparator exists to provide. It is only viable if it *becomes* approach (a). |
| **GO / NO-GO for full client-side within reasonable effort** | **GO on the architecture** (the seam is clean and the fix is known art). **NO-GO for "a few days"**: the cost is rebuilding a *patched* rocq-runtime to WASM and producing a matching prelude `.vo` bundle. **Reasonable-effort route: reuse coq-lsp's existing Rocq-9.1 WASM harness** (align the comparator to 9.1) rather than re-porting the patches to 9.2 from scratch. |
| Achievable **now**, independent of the WASM build | The **frontend↔backend contract** (below) is frozen, and the non-kernel seam (Config-JSON in → run → Verdict-JSON out) is proven to link. The UI can be built against a stub that satisfies the contract while the WASM build lands. |

---

## 0. Environment (verified)

- Core switch = the project-local switch `/Users/gbaudart/Project/llm4rocq/rocq-comparator/_opam`, **OCaml 5.5.1**.
- `rocq-runtime 9.2.0`, `rocq-core 9.2.0`, `rocq-stdlib 9.1.0`, `zarith 1.14`.
- Core `src/dune` links: `rocq-runtime.{boot,clib,lib,kernel,library,engine,proofs,printing,parsing,gramlib,coqargs,sysinit,vernac,plugins.ltac}`, plus `unix str threads.posix yojson memprof-limits`.
- The pipeline entry is `Rocq_comparator.Check.run_inner : hooks -> Config.t -> scratch:string -> Verdict.t` — pure in-process logic. `bin/main.ml`'s outer process (fork / re-exec / OS sandbox) is **not** used in the browser: the browser origin is the sandbox.

---

## 1. Installing js_of_ocaml / wasm_of_ocaml — non-destructive (done)

Checked whether adding jsoo to the core switch is destructive **before** doing it.

`opam install js_of_ocaml js_of_ocaml-compiler --dry-run` → **5 new packages only**
(`seq`, `gen`, `sedlex`, `js_of_ocaml-compiler`, `js_of_ocaml`); **nothing removed,
downgraded, or reinstalled** — in particular `rocq-runtime`, `zarith`, `ocaml` are
untouched. It was then installed for real: `js_of_ocaml 6.4.1`.

`wasm_of_ocaml-compiler` adds `conf-binaryen` and needs the system package
`binaryen` (`brew install binaryen`, no sudo on Apple Silicon). Also installed:
`wasm_of_ocaml 6.4.1`.

> Conclusion: jsoo/wasmoo live happily **in the core switch**; no throwaway switch
> was needed for the *tooling*. (A separate switch **is** needed later for the
> *patched Rocq build* — see §5 — because that changes rocq-runtime itself.)

## 1b. Minimal link experiment — what the browser is actually missing

Minimal program linking just `rocq-runtime.{boot,clib,lib,kernel,library}` and
calling `Global.env ()`, built to bytecode and run through `js_of_ocaml`
(`spike/jsoo-seam/spike.ml`):

```
Missing primitives:
  caml_thread_id
  caml_thread_initialize
  caml_thread_self
  caml_unix_getpid
```

Two headline findings:

1. **Zero zarith `ml_z_*` primitives.** `ocamlobjinfo` on the bytecode confirms
   `ml_z_ count: 0`. Rocq 9.2's kernel uses native `int63`/`float64` and
   `Bigarray`, all of whose primitives (`caml_ba_*`, int63, float) are already in
   jsoo's runtime. **This kills the old jsCoq worry about supplying zarith JS
   stubs — for our surface it is a non-issue.**
2. The only gaps are **thread + getpid** stubs (single-threaded no-ops; jsCoq
   supplies exactly these). The **full** comparator surface (all of `src/dune`:
   vernac, parsing, printing, ltac, unix, str, yojson, memprof-limits) reports the
   **same 4** and nothing more (`spike/jsoo-seam/full_missing.txt`).

Shim the 4 (`spike/jsoo-seam/shim.js`) and run under node → we get *past* linking
and hit the real wall at runtime:

```
Fatal error: exception File "kernel/uint63_63.ml", line 13, characters 8-14: Assertion failed
```

## 1c. The one real blocker: native-int width

`kernel/uint63_63.ml` line 13 (Rocq master, unchanged in 9.x) is literally:

```ocaml
let _ = assert (Sys.word_size = 64)
```

Rocq's kernel is built with the OCaml native compiler (63-bit `int`, 64-bit
words), so `kernel/dune` picks the 63-bit implementation:

```
(rule (targets uint63.ml) (deps (:gen-file uint63_%{ocaml-config:int_size}.ml)) ...)
(rule (targets float64.ml) (deps (:gen-file float64_%{ocaml-config:int_size}.ml)) ...)
```

But the JS/WASM *target* has a narrower `int`. Measured this session
(`spike/jsoo-seam/intsize.ml`):

| target | `Sys.int_size` | `1 lsl 62` |
|---|---|---|
| native (build host) | **63** | correct |
| **js_of_ocaml 6.4.1** | **32** | wraps |
| **wasm_of_ocaml 6.4.1** | **31** | wraps |

`wasm_of_ocaml` has **no** flag to widen this (checked `--help`); it is fixed at
31-bit tagged ints. So **you cannot post-compile a natively-built rocq-runtime to
JS or WASM** — the kernel that was compiled assuming 63-bit ints runs on a 31/32-bit
target and asserts (or, worse if the assert were removed, silently miscomputes
hashes/universes). This is *the* reason a browser Rocq is not just "jsoo the opam
package".

---

## 2. How jsCoq / wacoq / coq-lsp actually solve it (the reusable art)

Read from `jscoq/wacoq-bin` (`v8.16` branch, author *Shachar Itzhaky*) — the build
is `git clone coq @ V8.16.0`, apply patches, `configure -native-compiler no
-bytecode-compiler no -coqide no`, build **bytecode** `icoq.bc`, then
`wasm_of_ocaml` it. Artifacts shipped: `icoq.bc`, **`dllcoqrun_stubs.wasm`** (the
`coqrun` C VM stubs compiled to WASM), `dlllib_stubs.wasm`, and **`.coq-pkg`**
archives (the stdlib `.vo` bundle). Build host is 64-bit; the Makefile applies:

```
COQ_PATCHES = timeout extern coerce-32bit
```

**`coerce-32bit.patch`** (the linchpin — small and mechanical):

- `kernel/dune`: hard-wire `uint63_31.ml` / `float64_31.ml` **instead of**
  `uint63_%{ocaml-config:int_size}.ml`. These implement 63-bit unsigned ints on
  top of **`Int64.t`** (boxed), so they are correct on any host int width.
- `kernel/uint63_31.ml`: comment out `assert (Sys.word_size = 32)` so the 31-impl
  can be *built* on a 64-bit host.
- `clib/hashset.ml`, `kernel/nativecode.ml`: `max_int = (1 lsl 30) - 1` and mask
  hash combines with `land 0x3fffffff` so hashes fit the 31-bit target int.
- `lib/objFile.ml`: `Marshal.to_channel ch v [Marshal.Compat_32]` so `.vo`
  marshalled data is readable by the 31-bit target.

**`timeout.patch`** rewrites the tactic monad (`engine/logic_monad.ml`) to a
**trampoline** — this is Itzhaky's "trampoline patch" that "greatly reduces the
Stack Overflow in the proof engine" in JS/WASM workers, and it is where in-browser
interruption/timeout is wired (native `Control.timeout` uses Unix `setitimer`,
which does not exist in the browser).

**Modern equivalent:** coq-lsp `0.2.4/0.2.5` ship a WASM worker "based on waCoq"
for **Rocq 9.1**, carrying the same lineage ("Update interrupt patch to account for
timeouts", "Add Shachar Itzhaky's trampoline patch"). `kernel/dune` and
`kernel/uint63_63.ml` are structurally identical in 9.2, so the patch set ports to
9.2 with only cosmetic rebasing.

---

## 3. Approach evaluation

### (a) jsoo/wasmoo-core — **CHOSEN**

Compile the core `rocq_comparator` library **together with a patched
rocq-runtime** to WASM, run it in a Web Worker with jsCoq's runtime shims (thread
+ getpid stubs; `dllcoqrun_stubs.wasm`; a virtual FS holding the prelude `.vo`
bundle). Our `Check.run_inner` and all kernel-level checks (`Compare` on `Constr`,
`Assumptions` by constructor, canonical `KerName`, `Envcheck` universe/flags,
`Shadowing`) run **as compiled OCaml where rocq-runtime runs** — i.e. our
guarantees are preserved exactly.

Why it fits us unusually well:

- **No zarith stub work** (§1b).
- **`-native-compiler no -bytecode-compiler no` is already our config.**
  `Config.rocq_args` always sets `-native-compiler no`, and `vm:false` sets
  `-bytecode-compiler no` — the same flags wacoq configures Coq with. In the
  browser we run with `vm:false`. `Driver.init` already calls
  `Global.set_native_compiler false`.
- Our **verdict-integrity design carries over.** The CLI's stdout-is-untrusted /
  verdict-file trick exists because a solution can print to stdout in a shared
  process; in the browser we do not parse stdout at all — the worker returns the
  `Verdict.t` object directly from `run_inner`, so a solution's `idtac "..."`
  cannot forge a verdict.

How much of jsCoq's harness we must reuse: the **build harness** (patched Rocq
source tree + `coerce-32bit`/`timeout` patches + `.coq-pkg`/`.vo` bundling +
worker FS + thread/coqrun shims). We do **not** need jsCoq's UI, its SerAPI
protocol, or its editor. Cleanest is to build in the **same opam switch coq-lsp
uses for its WASM worker** and add our library + a thin JS-facing entry module.

### (b) wacoq-worker (reuse a prebuilt worker) — **REJECTED for the product**

A prebuilt wacoq/jsCoq worker exposes a *command* protocol: send vernac, get
feedback/errors, run `Print Assumptions`. Our kernel checks are **OCaml linked
against rocq-runtime**; they cannot be expressed as vernac. So driving our
comparison "through" a prebuilt worker means dropping to a **text-level** check:
wrap solution in `Module M.`, replay, `Print Assumptions target`, string-match the
printed statement and axioms.

That **loses**, explicitly:

- kernel `Constr` equality up to conversion (statement identity) → downgraded to
  comparing *pretty-printed* strings (defeated by notation/alpha/universe/`Set`
  vs `Type` differences);
- dependency-closure / canonical-name matching (`Compare`) → gone;
- assumptions **by constructor over the real closure** (`Assumptions`) →
  downgraded to parsing `Print Assumptions` text, which a plugin/notation can
  perturb and which does not distinguish opaque-vs-axiom the way the kernel does;
- universe-entailment / typing-flags (`Envcheck`), joined-environment check,
  shadowing detection, and the AST `Filter`'s command allow-list → gone.

So (b) as *reuse* is a NO: it is a different, weaker product. (b) only "works" by
getting our OCaml into the worker's build — which is approach (a). Stated plainly:
**there is no shortcut that both reuses a stock worker and keeps the guarantees.**

---

## 4. GO / NO-GO

**GO on the architecture (approach a).** Every uncertainty that could have been a
true blocker has been retired with evidence: the seam links, zarith is a non-issue,
the flags already match, and the one real blocker (int width) has a small, known,
version-portable fix.

**Honest effort caveat — NO-GO for "a quick build".** The remaining work is not
glue; it is *rebuilding a patched rocq-runtime to WASM and producing a matching
prelude `.vo` bundle*. Concretely the risks/costs are:

1. **Patched-Rocq WASM build.** Reproduce `coerce-32bit` + `timeout` for the Rocq
   version we target and build to WASM. Days, not hours — but it is a known
   quantity (wacoq/coq-lsp do it in CI).
2. **Version alignment.** Our comparator requires `rocq-runtime >= 9.2`; the
   *existing* WASM Rocq (coq-lsp 0.2.4/0.2.5) is **9.1**. Two options:
   - **Recommended for reasonable effort:** relax the comparator to build against
     **9.1** and reuse coq-lsp's already-patched 9.1 WASM switch + `.vo` bundle.
     Least new build engineering.
   - **If 9.2 is required:** port the 3 patches to 9.2 and build ourselves (they
     apply structurally; expect only rebase friction), and generate our own `.vo`
     prelude bundle (`.vo` is version-locked; a 9.1 bundle will not load in a 9.2
     kernel).
3. **`coqrun` C stubs.** With `-bytecode-compiler no` the VM is not used for
   conversion, but the kernel still links `coqrun`; take wacoq's
   `dllcoqrun_stubs.wasm` (or dummy the referenced `caml_coq_*` prims). Low risk.
4. **Interruption/timeout.** In-browser there is no `setitimer`; rely on the
   `timeout` trampoline patch and on the UI **terminating the Web Worker** to
   enforce a wall-clock budget. `Config.timeout_s` becomes best-effort inside the
   worker; the hard cap is worker-kill from the main thread.
5. **Payload size.** A WASM Rocq + stdlib `.vo` bundle is tens of MB; fine for a
   one-page tool but plan for streamed/cached loading.

**What is achievable right now, this week, with no WASM build:**

- jsoo/wasmoo installed and proven in the switch (§1).
- The seam (Config-JSON → `run_inner` → Verdict-JSON) links to JS today; only
  kernel *execution* trips the int assert. So we can ship a **contract-compatible
  stub backend** (fixed/sample verdicts, real JSON shapes) that satisfies §6, and
  the whole UI can be built and finished against it. When the patched WASM build
  lands, it drops in behind the identical `window.RocqComparator` object.

---

## 5. Build plan for approach (a) (for the Build phase)

1. **Switch.** Create/borrow a dedicated opam switch with `js_of_ocaml` +
   `wasm_of_ocaml` and a **from-source, patched** rocq-runtime. Best: mirror
   coq-lsp's WASM switch (Rocq 9.1) and add our packages to it. Do **not** reuse
   the core `_opam` for the patched Rocq (it would replace the stock
   rocq-runtime); the core switch keeps the native build for the CLI.
2. **Patches.** Apply `coerce-32bit` (retarget `kernel/dune` to `uint63_31`/
   `float64_31`, un-assert `uint63_31.ml`, mask hashes, `Marshal.Compat_32`) and
   `timeout` (trampoline) to the Rocq source. Build to **bytecode**, then
   `wasm_of_ocaml`.
3. **Our library.** Depend on the core `rocq-comparator` as a library (unchanged).
   Add a thin entry module `web_backend.ml` that builds **browser hooks** and
   exposes one function to JS (§6). Browser hooks = the core `real_hooks` with
   `rocqchk = None` and no sandbox — i.e. real `Filter` / `Assumptions` /
   `Compare` / `Envcheck` / `Shadowing`, exactly `Check.permissive_hooks`'s
   opposite. `filter_status = Verdict.Ok`.
4. **VFS + prelude.** Mount the `.vo` prelude bundle (Corelib/Stdlib) in the jsoo
   virtual FS. On each `check`, write the challenge/solution sources (and any
   loadpath files) into the VFS, set `Config.challenge`/`solution` to those VFS
   paths, run, delete.
5. **Worker.** Run the artifact in a Web Worker; `postMessage` request/response;
   the main thread owns the hard timeout by terminating the worker.

---

## 6. Frontend ↔ Backend contract  (FROZEN — the Build phase codes against this)

The backend is a single JS global installed by the worker glue. The UI must not
know whether the backend is real WASM Rocq or a stub.

```ts
declare global {
  interface Window {
    RocqComparator: {
      /** Resolves once the Rocq runtime + prelude .vo FS are loaded and
       *  Driver.init has run once. Rejects only on catastrophic load failure
       *  (worker/wasm fetch failed, OOM at init). Never rejects for a bad proof. */
      ready: Promise<void>;

      /** Run one check. `request` is a JSON string (shape below).
       *  Resolves with a Verdict JSON string (shape below) for EVERY outcome the
       *  pipeline can express, including all rejections and config/internal errors
       *  — the verdict itself carries ok/reason/detail.
       *  Rejects ONLY for out-of-band failure: malformed request JSON, a wasm
       *  trap, OOM, or the worker being terminated (e.g. wall-clock kill). A
       *  rejection is an Error whose .message is a short human string. */
      check(request: string): Promise<string>;

      /** Optional, present on real builds: linked Rocq version, e.g. "9.1" / "9.2". */
      version?: string;
    };
  }
}
```

### Request JSON

```jsonc
{
  // REQUIRED. Exactly the comparator Config JSON (see core src/config.ml of_json).
  // Field-for-field identical to a CLI config.json, so configs are portable.
  "config": {
    "challenge": "challenge.v",            // VFS path; must be a key in "files"
    "solution":  "solution.v",             // VFS path; must be a key in "files"
    "theorem_names":    ["thm_a"],         // theorem_names OR definition_names non-empty
    "definition_names": [],
    "permitted_axioms": ["Coq.Logic.Classical_Prop.classic", "MyLib.*", "@classical"],
    "loadpath": [ {"Q": ["/lib/mylib", "MyLib"]} ],   // -Q/-R/-I; dirs are VFS paths
    "coqproject": null,
    "top": null,                            // logical name; derived if null
    "timeout_s": 300,                       // the check's budget: the engine's own deadline, and the hard cap (worker kill) 5 s later
    "sandbox": "none",                      // ignored in browser (origin is the sandbox)
    "rocqchk": false,                       // MUST be false in browser (no subprocess)
    "vm": false,                            // MUST be false in browser (no bytecode VM)
    "impredicative_set": false,
    "indices_matter": false,
    "noinit": false,
    "permitted_plugins": [],
    "permitted_libraries": [],              // if non-empty: dirpath prefixes the solution may Require
    "permit_challenge_axioms": true
  },

  // REQUIRED. Virtual files written into the worker FS before the run and removed
  // after. Keys are VFS paths (must match config.challenge/solution and any
  // loadpath entries); values are file contents (UTF-8). This is how the two .v
  // sources reach the backend — the browser has no OS filesystem.
  "files": {
    "challenge.v": "Theorem thm_a : 1 + 1 = 2. Proof. reflexivity. Qed.\n",
    "solution.v":  "Theorem thm_a : 1 + 1 = 2. Proof. lia. Qed.\n"
  }
}
```

Notes for the frontend:
- The UI collects challenge text, solution text, theorem names, and permitted
  axioms, then assembles this object. The two big text areas become
  `files["challenge.v"]` / `files["solution.v"]`; `config.challenge`/`solution`
  point at those keys. Everything else has sane defaults above.
- `config` is validated by the same `Config.of_json` as the CLI. A validation
  failure comes back as a normal verdict with `reason:"config_error"` (a resolved
  promise), **not** a rejection.
- Backend forces `rocqchk:false` and `vm:false` regardless of input; sending
  `true` for either is ignored (documented, not an error).

### Response JSON  (exactly core `src/verdict.ml` `to_json`)

```jsonc
{
  "ok": false,                       // bool: accepted iff true
  "reason": "forbidden_axiom",       // null when ok; else one of the reason strings below
  "detail": "…human explanation…",   // null | string
  "sandboxed": false,                // always false in browser
  "sandbox": "none",                 // "none" (browser origin is the sandbox)
  "rocq_version": "9.1",             // from the linked runtime
  "targets": [
    { "name": "thm_a",
      "status": "proved",            // "proved"|"not_proved"|"missing"|"mismatch"|"unchecked"
      "assumptions": ["Coq.Logic.Classical_Prop.classic"],   // permitted axioms actually used
      "detail": null }               // null | string
  ],
  "checks": {                        // fixed key order; each value is a status
    "filter": "ok",                  // status = "ok" | "skipped" | {"fail": "msg"}
    "challenge_compile": "ok",
    "solution_compile": "ok",
    "joined": "ok",
    "statements": "ok",
    "closure": "ok",
    "axioms": {"fail": "uses forbidden axiom X"},
    "hygiene": "skipped",
    "libraries": "skipped",
    "rocqchk": "skipped"             // ALWAYS "skipped" in browser (no rocqchk subprocess)
  },
  "timing_s": { "init": 0.4, "challenge": 0.2, "solution": 1.1, "compare": 0.05 }
  // "solution" key (the solution path) appears only in CLI batch mode; not here.
}
```

**`reason` enum** (core `verdict.ml`): `statement_mismatch`, `dependency_mismatch`,
`not_proved`, `target_not_found`, `kind_mismatch`, `forbidden_axiom`,
`unsafe_flags`, `forbidden_command`, `compile_error`, `challenge_error`,
`timeout`, `rocqchk_failed`, `library_violation`, `config_error`, `sandbox_error`,
`internal_error`.

**Verdict semantics the UI should surface:**
- `ok:true` → accepted; show green, list `targets[].assumptions` used.
- `ok:false` + `reason` in {`config_error`, `challenge_error`, `internal_error`}
  → *infrastructure*, "nothing was judged" (CLI exit code 2 class); render
  differently from a genuine rejection.
- everything else `ok:false` → the solution was **rejected**; `reason`+`detail`
  say why, `checks` shows which stage failed, `targets` shows per-theorem status.
- `checks.rocqchk` is always `"skipped"` in the browser — do not present its
  absence as a failure. `checks.filter` is `"ok"` (the strict AST filter runs).

### Lifecycle & concurrency

- **Init.** `await window.RocqComparator.ready` once before the first `check`
  (Rocq runtime + prelude `.vo` load; tens of MB — show a loading state).
- **Idempotent runtime.** `Driver.init` runs once and freezes root state; each
  `check` restores from that frozen root, so challenge/solution runs are isolated
  and the worker is reused across checks. No re-init per call.
- **Serialization.** The worker is single-threaded; `check` calls are queued and
  run one at a time. The frontend should disable Run while a check is in flight
  (or the glue queues them — pick one and document; recommended: glue queues,
  resolves in order).
- **Hard timeout.** To guarantee termination against an adversarial proof, the
  main thread arms a timer when the worker reports `{stage:"check"}` (library
  downloads never count) and `config.timeout_s + 5` s later **terminates the
  Web Worker**, rejects that call's promise with `Error("timeout")` and
  respawns the worker (re-`ready`; a check posted meanwhile waits for the new
  worker's ready, and downloads its packs again).
  `config.timeout_s` is also the engine's own budget, Rocq's deadline checked
  between sentences; a single mathcomp-analysis `Require` can exceed 60 s, so
  the page defaults to 300 s (Advanced options) and tells the user which
  timeout stopped a check.

---

### 6.1 Progress events

`check(requestJson, onProgress?)` accepts an optional callback. While the
worker fetches the library packs a request imports it calls
`onProgress({stage:"download", pack, packsDone, packsTotal, bytes, bytesTotal})`
after every file (byte totals come from `packs.json`), then
`onProgress({stage:"check"})` when the engine starts. The page shows a
byte-accurate bar during downloads and an elapsed timer during the check,
because no finer progress exists inside a single Rocq `Require`. The `check`
event is also what arms the hard timeout above. The callback is per call; the
frozen contract without it is unchanged.

### 6.2 Browser support, loading stages and the JSPI fallback

The engines need WebAssembly GC, tail calls and exception handling, in the
legacy `try`/`catch` form `wasm_of_ocaml` 6.4.1 emits for browsers (it emits
`try_table` only for WASI): Chrome and Edge 119+, Firefox 122+, Safari 18.2+,
Node 22+. Before spawning the worker the loader validates one minimal module
per extension with `WebAssembly.validate` (a `struct` type; a `return_call`; a
tag with `try`/`throw`/`catch`) and exposes the result as
`support: {gc, tailCalls, exceptions}`. When one is missing no worker is
spawned and `ready` rejects with a message naming it; the page shows it in
place of the generic failure and keeps the demo verdicts.

While `ready` is pending the worker reports `{type:'loading', stage:'engine'}`
(fetching and compiling the module, a minute or more on a phone) then
`{stage:'prelude'}` (mounting the Corelib); the loader exposes it as `stage`
and the page shows an elapsed timer. The engine glue instantiates its module in
an async function nobody awaits, so a failure there only surfaces as an
unhandled rejection or an error event in the worker: the worker records it
until the engine is installed and posts it as the fatal, with the browser's
own text, instead of waiting out the poll (now 300 s). Every fatal names its
engine; when `engine-jspi` fails and no `?engine=` is forced, the loader
respawns the worker once with `?engine=cps`, keeps the error as `fallback`
and reports the engine that came up as `engine`. These fields are additions;
the three frozen members are unchanged.

## 7. Files produced by this spike

- `spike/jsoo-seam/` — reproducible minimal experiments (`spike.ml`,
  `fullspike.ml`, `intsize.ml`, `shim.js`), captured logs (`full_missing.txt`,
  `full_jsoo.log`, `jsoo.log`), and a `README.md` with exact commands.
- This `BACKEND.md`.

## 8. Sources

- jsCoq — <https://github.com/jscoq/jscoq>
- wacoq-bin (build harness, patches read directly) — <https://github.com/jscoq/wacoq-bin> (branch `v8.16`)
- coq-lsp WASM worker / CHANGES — <https://ocaml.org/p/coq-lsp/0.2.5%2B9.1/CHANGES.html>
- wasm_of_ocaml — <https://tarides.com/blog/2023-11-01-webassembly-support-for-ocaml-introducing-wasm-of-ocaml/>
- Rocq kernel `uint63_63.ml` / `kernel/dune` — <https://github.com/rocq-prover/rocq> (`master`)

---

## 9. Build phase — what is implemented (this project)

The OCaml browser seam and its js_of_ocaml build now exist in this project. The
core comparator at `/Users/gbaudart/Project/llm4rocq/rocq-comparator` is **not**
modified; it is consumed as a library (its `src/` is symlinked into this
project's build scope as `core-src`, because the core's `rocq_comparator` library
is private — no `public_name` — and a private library is invisible across a
separate dune project).

### Files (owned by the backend)

| Path | Role |
|---|---|
| `web/web_check.ml` | **The REAL seam.** js_of_ocaml entry that parses the request's config with `Config.of_json`, writes the inline `files` into the js_of_ocaml pseudo-FS, builds **browser hooks** (real `Filter` Strict/Lenient · `Assumptions.check` · `Compare` via `Check` · `Envcheck.check`/`trusted_roots` · `Shadowing` inside `Check`; `rocqchk = None`; no sandbox; `filter_status = Ok`), calls `Check.run_inner`, and returns `Verdict.to_string`. Forces `rocqchk:false`, `vm:false`, `sandbox:none`. Installs `window.RocqComparator`. |
| `web/web_stub.ml` | **The STUB backend.** Same `window.RocqComparator` contract, but links only the kernel-free `stubcore` library, so it **runs in the browser today**. Real `Config.of_json` validation + real `Verdict` JSON; a valid request returns an honest `internal_error` "kernel not wired" verdict (all checks `skipped`, all targets `unchecked`). |
| `web/stubcore/{config,verdict,presets}.ml` | Symlinks to the **real, unmodified** core sources. These three modules have no rocq-runtime dependency, so they compile+run under js_of_ocaml. Built as a standalone lib (`stubcore`, deps: `yojson` only). |
| `web/runtime_shims.js` | jsCoq-style thread + getpid no-op shims (the 4 primitives the spike found missing), bundled into the js output. |
| `web/dune`, `dune-project`, `dune`, `core-src` (symlink) | Build wiring. `dune-project` is `(lang dune 3.17)` (needed for `compilation_mode whole_program`). |
| `Makefile` | Build/test/dist entry points (see below). |
| `test/contract_test.cjs` | Node contract test (16 assertions) over `window.RocqComparator`. |

### Build / run

```sh
# from this directory; the switch defaults to the sibling core's project-local
# switch (which has js_of_ocaml + wasm_of_ocaml + rocq-runtime).
make            # build stub JS, verify the real seam links, assemble dist/
make stub       # -> _build/default/web/web_stub.bc.js  (the runnable backend)
make test       # node contract test over the stub (16/16 PASS)
make check-bc   # link the REAL seam to bytecode (75 MB) — proves the pipeline links
make check-js   # compile the REAL seam through js_of_ocaml (whole-program)
make blocker    # build the real seam to JS and RUN it -> reproduces the int trap
make dist       # assemble dist/: rocq_comparator.js (stub) + frontend statics
```

### Verified this phase

- **Real seam links.** `make check-bc` produces a 75 MB `web_check.bc` linking
  the entire pipeline (Config, Check, Filter, Assumptions, Compare, Envcheck,
  Shadowing, Driver, Verdict) against `rocq_comparator` + full `rocq-runtime`.
- **Real seam compiles through js_of_ocaml.** `make check-js` (whole-program)
  emits `web_check.bc.js`. Only the 4 known primitives are missing and they are
  shimmed.
- **The blocker reproduces exactly.** Running that JS under node:
  `Fatal error: exception File "kernel/uint63_63.ml", line 13, characters 8-14: Assertion failed`
  — the `Sys.word_size = 64` assert, at module-init time (before
  `window.RocqComparator` is even installed). This is the same wall the spike
  hit, now with the actual product entry point. Confirms: the seam is complete;
  only a **patched WASM rocq-runtime** is missing.
- **The stub satisfies the contract end to end.** `make test` → 16/16 PASS:
  global installed; `ready` resolves; `check` returns the exact verdict shape
  (all 10 `checks` keys, `rocqchk:"skipped"`, targets, `timing_s`); real
  `Config` validation surfaces `config_error` (incl. unknown `@preset`);
  malformed / config-less requests **reject** out-of-band with an `Error`. The
  frontend's exact `buildRequest()` payload is accepted.

### Frontend integration (one line, owned by the frontend)

The stub installs `window.RocqComparator` synchronously on load. `app.js`
already talks to that global and degrades gracefully when it is absent. To wire
the backend in, `index.html` needs **one line before `app.js`**:

```html
<script src="rocq_comparator.js"></script>
<script src="app.js"></script>
```

`make dist` copies `rocq_comparator.js` next to the frontend statics so this
relative path resolves. The stub is a plain script (no worker, no `fetch`, no
`.wasm`), so it even works from `file://`. When the real WASM build lands, only
`rocq_comparator.js` changes; the contract and this `<script>` line stay put.

---

## 10. Finishing the real WASM backend — precise steps

The seam (`web/web_check.ml`) is the finished product entry point. What remains
is entirely on the **runtime** side: produce a patched rocq-runtime compiled to
WASM plus a matching prelude `.vo` bundle, then point the worker glue at it. The
recommended, least-effort route reuses coq-lsp's Rocq-9.1 WASM harness.

**Step 1 — a WASM switch with a patched, from-source rocq-runtime.**
Do **not** reuse the core `_opam` (it holds the native rocq-runtime the CLI
needs). Either:
- (recommended) mirror **coq-lsp 0.2.4/0.2.5**'s WASM worker switch (Rocq
  **9.1**) and add our packages to it; or
- build Rocq from source in a fresh switch and apply the three patches yourself.

**Step 2 — apply the patches to the Rocq source** (from wacoq-bin `v8.16`
`COQ_PATCHES = timeout extern coerce-32bit`, ported to the target version — they
apply structurally to 9.1/9.2, only cosmetic rebasing):
- `coerce-32bit`: in `kernel/dune`, hard-wire `uint63_31.ml` / `float64_31.ml`
  instead of `uint63_%{ocaml-config:int_size}.ml`; comment out the
  `assert (Sys.word_size = 32)` in `kernel/uint63_31.ml`; mask hash combines to
  30 bits in `clib/hashset.ml` and `kernel/nativecode.ml`
  (`max_int = (1 lsl 30) - 1`, `land 0x3fffffff`); add `Marshal.Compat_32` in
  `lib/objFile.ml` so `.vo` marshalling is 31-bit-readable.
- `timeout`: Itzhaky's trampoline rewrite of `engine/logic_monad.ml` (removes
  the setitimer-based `Control.timeout`, reduces stack overflows in the worker;
  this is where in-worker interruption hooks live).

**Step 3 — build to bytecode, then WASM.** Configure Rocq with
`-native-compiler no -bytecode-compiler no -coqide no` (already exactly our
`Config.rocq_args`: `-native-compiler no` always, and `vm:false` →
`-bytecode-compiler no`), build **bytecode**, then run `wasm_of_ocaml` (installed
in the core switch: `wasm_of_ocaml 6.4.1`).

**Step 4 — build our seam into that switch.** Add this project's `web/` +
`stubcore` is unused for the real build; point `web_check`'s `(libraries)` at the
patched `rocq_comparator`/`rocq-runtime` in the WASM switch and
`wasm_of_ocaml` `web_check.bc` (swap the `(modes js)` for a `wasm` build, or run
`wasm_of_ocaml` from the Makefile). No source change to `web/web_check.ml` is
expected — it is already the drop-in.

**Step 5 — runtime shims + coqrun stubs.** Keep `web/runtime_shims.js` (thread +
getpid). Take wacoq's `dllcoqrun_stubs.wasm` (the `coqrun` C VM stubs) — the
kernel still links `coqrun` even with `-bytecode-compiler no` — or dummy the
referenced `caml_coq_*` primitives. `zarith` needs **no** stubs (spike §1b: 0
`ml_z_*` referenced).

**Step 6 — prelude `.vo` bundle in the VFS.** `.vo` is version-locked, so the
bundle must match the kernel version. If reusing coq-lsp's 9.1 switch, reuse its
`.coq-pkg` / `.vo` bundle. If building 9.2, generate your own bundle with the
patched compiler. Mount it in the js_of_ocaml FS (`Sys_js.mount` / preloaded
files) so `Driver.init`'s `Require` of the Corelib/Stdlib prelude resolves.
`web/web_check.ml` already writes the per-request `files` into that same FS via
`Sys_js.create_file`.

**Step 7 — worker glue + hard timeout.** Run `web_check` in a Web Worker;
`postMessage` request/response; the glue installs `window.RocqComparator` on the
main thread (same object shape as the stub) and forwards `check` to the worker.
The main thread owns the **hard** wall-clock cap: on `config.timeout_s` expiry it
`terminate()`s the worker, rejects that call with `Error("timeout")`, and
respawns (re-`ready`). `Config.timeout_s` stays the soft, in-worker budget.

**Version note.** `web_check.ml`/`stubcore` compile against the core (currently
`rocq-runtime 9.2`). For the 9.1 reuse route, relax the core's
`(rocq-runtime (>= 9.2))` to `>= 9.1` (a core-project change, coordinate with the
core owner) or keep 9.2 and build the WASM runtime yourself (Step 2 alt).

**Known limitation to carry into the worker design.** `Driver.init` is
idempotent (inits once, freezes root state, each check restores it → isolation).
So the loadpath is fixed at the first `init`. `web/web_check.ml` therefore lets
the **first** check's loadpath stick for the worker's lifetime; to change the
loadpath the main thread respawns the worker. For prelude-only challenges (the
common case) this is a non-issue.

---

## 11. Build phase 2 — the real backend RUNS in the browser (js_of_ocaml)

**Status: a real `rocq-comparator` check now runs entirely client-side.** The
one hard blocker from §1c (the kernel's `Sys.word_size = 64` assert) is cleared,
and `window.RocqComparator.check(...)` returns a genuine kernel-checked verdict
under js_of_ocaml (verified headlessly under node; see the results below). This
supersedes §9's stub: the stub has been removed. Target chosen: **js_of_ocaml,
Rocq 9.2** (not WASM, not the 9.1 reuse route) — it got a running in-browser
check soonest and keeps us on our own 9.2 core.

### 11.1 What made it run (the mechanism)

1. **coerce-32bit, done surgically without disturbing the core switch.**
   `kernel/uint63.mli` is a *single* interface shared by both `uint63_63.ml`
   (`type t = int`, 63-bit, asserts word_size=64) and `uint63_31.ml`
   (`type t = Int64.t`, correct on any int width). So only the kernel *bytecode*
   archive needs rebuilding: `web/build-real.sh` copies the opam-extracted Rocq
   9.2 source, flips `kernel/dune` to hard-wire `uint63_31.ml`/`float64_31.ml`
   (and comments the `assert (Sys.word_size = 32)` in `uint63_31.ml`), and
   `dune build kernel/kernel.cma` (seconds, via the dune cache). The patched
   `kernel.cma` is dropped into an **OCAMLPATH overlay** — an APFS clone of
   `_opam/lib/rocq-runtime` (+ `stublibs`) with just that one file replaced.
   Because the interface CRC of `Uint63` is unchanged (`9876a8b5…`), every other
   installed rocq-runtime sub-archive links against it untouched. The core
   switch's native rocq-runtime (used by the CLI) is never modified.

2. **Runtime shims (`web/runtime_shims.js`).** Real IEEE `Float64` primitives
   (`rocq_fadd_byte`, …, called by `float64_31.ml`'s module-init self-test) plus
   thread/getpid no-ops and *benign* stubs for the three init-time VM tcode
   producers (`rocq_accumulate`, `rocq_pushpop`/`mkPopStopCode`,
   `rocq_makeaccu`, `rocq_curry2_1_addr`, …). The VM interpreter primitives
   (`rocq_interprete_byte`, `rocq_push_*`, …) are deliberately left as jsoo's
   Failure-raising dummies — with `vm:false` they are never called, and if the
   VM path were ever taken it fails loudly instead of returning a wrong answer.

3. **zarith (`web/zarith_stubs.js`).** rocq-runtime's META requires `zarith`,
   whose `Z` module initialises at load (`ml_z_init`). Vendored Jane Street
   `zarith_stubs_js` v0.17.0 (pure-JS `ml_z_*`, ABI-matches the switch's zarith
   1.14). *(This corrects §1b: the minimal `kernel,library` link referenced no
   zarith, but the full comparator surface does.)*

4. **In-worker timeout without `setitimer`.** Rocq's native `Control.timeout`
   arms a Unix interval timer (`getitimer`/`setitimer` + SIGALRM), absent in the
   browser. `web_check.ml` installs, via the public `Control.set_timeout` hook, a
   run-to-completion timeout (`fun _ f x -> Ok (f x)`) — the runtime equivalent
   of wacoq's timeout-trampoline patch, no rocq-runtime source change. The soft
   `timeout_s` is best-effort; the hard cap is worker-kill (§6, §11.3).

5. **VFS/init fixes in `web_check.ml`.** At load it writes a minimal
   `/static/findlib.conf` (Rocq inits findlib at startup) and sets `config_dir`
   to the jsoo cwd (`/static`) so the inline `files` it materialises line up with
   the paths Config resolves.

### 11.2 Files delivered (this project; core still unmodified)

| Path | Role |
|---|---|
| `web/web_check.ml` | The seam. Real `Filter`/`Assumptions`/`Compare`/`Envcheck`/`Shadowing`; `rocqchk=None`; no sandbox; forces `rocqchk/vm=false`; findlib + `Control.set_timeout` setup. |
| `web/runtime_shims.js` | Float64 + thread/getpid + init-time VM tcode shims. |
| `web/zarith_stubs.js` | Vendored `zarith_stubs_js` (pure-JS `ml_z_*`). |
| `web/build-real.sh` | One-shot reproducible build: patch kernel → overlay → jsoo → assemble `dist/`. |
| `web/rocq_worker.js` | Web Worker that hosts the engine (`importScripts('rocq_engine.js')`). |
| `web/rocq_comparator.js` | Main-thread loader: installs `window.RocqComparator`, serialises `check`, enforces the hard kill-timeout, respawns. |
| `dist/rocq_engine.js` | The 28 MB js_of_ocaml engine (built artifact; runs the check). |
| `test/judge_test.cjs` | Node judge harness (accept / forbidden-axiom / permit / mismatch / OOB). |

### 11.3 Exact repro commands

```sh
cd rocq-comparator-web
make            # == web/build-real.sh: build dist/rocq_engine.js (~15s w/ dune cache)
make test       # node judge harness against the engine  -> 7 passed, 0 failed
make serve      # python3 -m http.server 8000 in dist/    -> open http://localhost:8000/
```

Full worker path headlessly (no browser): the emulation harness
(`scratchpad/worker_e2e.cjs`) loads `dist/rocq_comparator.js`, shims the Web
Worker with `worker_threads`, and drives `check()` end to end.

### 11.4 Verified (headless, node)

`make test` → **7 passed, 0 failed.** Representative accept verdict (real):

```json
{"ok":true,"reason":null,"rocq_version":"9.2",
 "targets":[{"name":"id_fun","status":"proved","assumptions":[],"detail":null}],
 "checks":{"filter":"ok","challenge_compile":"ok","solution_compile":"ok","joined":"ok",
   "statements":"ok","closure":"ok","axioms":"ok","hygiene":"ok","libraries":"ok","rocqchk":"skipped"},
 "timing_s":{"init":0.022,"challenge":0.016,"solution":0.002,"compare":0.001}}
```

Rejections are equally real: a forbidden axiom → `forbidden_axiom` (kernel
assumption analysis names `challenge.cheat`); permitting it → `ok:true` with
`assumptions:["challenge.cheat"]`; a changed statement → `statement_mismatch`
(`targets[0].status:"mismatch"`, from kernel `Constr` comparison). The hard
worker-kill timeout was verified with a non-responding worker: the call rejects
with `Error("timeout")` and the next call is served by a respawned worker.

### 11.5 The one remaining limitation — the prelude `.vo` bundle

Checks run with **`-noinit`** (core Gallina only: `forall`/`fun`, no prelude
notations like `->`/`=`, no `nat`). Reason, now proven exactly: loading a
natively-built prelude `.vo` under the jsoo kernel fails with

```
Error when parsing .vo (… Corelib.Init.Equality.vo …): input_value: integer too large.
```

Native `.vo` embed 63-bit hashes that jsoo's 32-bit int unmarshaller cannot
read. This is a *write-side* problem: the `.vo` must be regenerated by a
compiler built with the full coerce-32bit patch (`Marshal.Compat_32` in
`lib/objFile.ml` + 30-bit hash masking in `clib/hashset.ml`/`kernel/nativecode.ml`).
**Next step for stdlib support:** build a patched rocq-runtime + rocq-core
*natively* with those two extra patches, run that `rocqc` to rebuild the 5.4 MB
Corelib bundle (65 `.vo`), mount it in the VFS (via `Sys_js` at engine load),
add `-Q /corelib Corelib` + `-coqlib`, and drop `-noinit`. The seam
(`web_check.ml`) already writes per-request files into that same VFS, so no seam
change is expected. This is the multi-day item flagged in §4; everything else in
the pipeline is done.

### 11.6 WASM note

`wasm_of_ocaml` (6.4.1) + binaryen are installed, but wasmoo's int is **31-bit**
(narrower than jsoo's 32-bit), so it needs the *same* coerce-32bit overlay —
plus `dllcoqrun_stubs.wasm` for the VM C prims (jsoo tolerates them as unused
dummies; a wasm link may not). js_of_ocaml was chosen to get a running check
first; the overlay + shims + `Control.set_timeout` approach ports to wasmoo
unchanged once the coqrun wasm stubs are supplied.

---

## 12. Build phase 3 — the Corelib prelude runs in the browser (Milestone 1)

**Status: `-noinit` is gone. A real `nat` + tactics proof kernel-checks
in-browser with the Corelib prelude loaded.** The §11.5 limitation is cleared.

Verified (headless, node — real-fs `make test` **and** a faithful browser-worker
emulation that hides `process` so the engine uses the in-memory VFS + browser
`exit` path, exactly as a real Web Worker does):

```
challenge  Theorem add_0_r : forall n : nat, n + 0 = n. Proof. Admitted.
solution   Theorem add_0_r : forall n : nat, n + 0 = n.
           Proof. induction n as [| n IH]; simpl.
             - reflexivity.
             - rewrite IH. reflexivity. Qed.
=> ok:true, targets[0].status="proved",
   checks all "ok" (filter/…/statements/closure/axioms/hygiene/libraries), rocqchk "skipped"
```

An admitted solution → `ok:false, reason:"not_proved"`; a changed statement →
`statement_mismatch`. `make test` = 10 passed, 0 failed.

### 12.1 Finishing the coerce-32bit port to 9.2 (the write side)

§11.1 rebuilt only `kernel.cma` (uint63_31/float64_31). The prelude needs the
*marshalling* half of wacoq/coq-lsp `coerce-32bit.patch`
(`web/patches/coerce-32bit.reference.patch`), ported to 9.2:

| file | change | why |
|---|---|---|
| `clib/hashset.ml` | `Combine.combine`/`combinesmall` `land 0x3fffffff` | cached hash fields in marshalled terms must fit a 31/32-bit int (`kernel/nativecode.ml` `open Hashset.Combine`, so it is covered too) |
| `lib/system.ml` | `marshal_out … [Marshal.Compat_32]` | 32-bit-readable marshalling |
| `lib/objFile.ml` | segment writer `… [Marshal.Compat_32]` | the `.vo` segment writer moved here in 9.x; this is the one that matters for `.vo` |

The `.v` Admits in the reference patch (Int63/Ring63 `vm_compute` proofs) are
**not** needed: we compile the `.vo` on a **native** host (63-bit), where the
Int64-backed kernel computes `vm_compute` correctly. `web/build-real.sh` now
builds and overlays patched `kernel.cma` + `lib.cma` + `clib.cma` (all `.mli`
unchanged ⇒ interface CRCs preserved ⇒ the rest of installed rocq-runtime links
untouched). The **same** patched archives sit under the jsoo engine AND the
native `rocqc` that writes the `.vo`.

### 12.2 Regenerating 32-bit-safe `.vo` (`web/build-native.sh`)

`web/build-native.sh` builds a **native** patched Rocq from the same
`.rocq-build/rocq-src` tree (`make dunestrap` + `dune build rocq-core.install`)
and regenerates the Corelib prelude (65 `.vo`, ~1.9 MB) + Ltac2 (42 `.vo`,
~0.2 MB) with it. The core opam switch is never touched (all output stays in
`_build`; `dune build` in the core still exits 0). Native stock `.vo` fail under
jsoo with `input_value: integer too large`; these load cleanly.

### 12.3 Mounting + loadpath + dropping `-noinit` (`web_check.ml`, `rocq_worker.js`)

- `RocqComparator.mount(path, bytes)` writes a file into the VFS (`Js.to_bytestring`
  keeps the `.vo` bytes intact). `rocq_worker.js` fetches `coqlib/manifest.json`
  then every `.vo` + a stripped findlib `META` and mounts them **before** ready;
  `test/judge_test.cjs` does the same from disk. Absent bundle ⇒ silent `-noinit`
  fallback.
- The coqlib root is **`/static/coqlib`**, not `/coqlib`: `/static` is jsoo's
  in-memory fake device under *both* the browser and node, whereas a top-level
  `/coqlib` is node's real filesystem root (mounts there are unreadable). This is
  the one non-obvious portability rule.
- A missing directory-`stat` was the loadpath blocker: Rocq's `lib/system.ml`
  reads `(Unix.stat dir).st_kind` while scanning the coqlib, and jsoo's
  `MlFakeDevice` has no `stat`. `runtime_shims.js` now provides `caml_unix_stat`
  (real stat on the node device; synthesized `[…,st_kind,…]` on the fake device).
- `web_check.ml` injects `-coqlib /static/coqlib` by pre-calling the idempotent
  `Driver.init` (first-call-wins) with the request args **plus** `-coqlib`, then
  drops `-noinit` whenever a bundle is mounted. No core `Config`/`Driver` change.

### 12.4 The prelude's `Declare ML Module` — static plugins, no Dynlink

`Corelib.Init.Prelude` (and Ltac/Tauto) `Declare ML Module` for `ltac`, `cc`,
`firstorder`, `number_string_notation`, `tauto`. jsoo has no Dynlink, so:

1. **Statically link** those plugins into the engine (`web/dune` `libraries`,
   with `-linkall`) — their tactic/notation/grammar extensions register at module
   init, so the code is present.
2. **Mount a stripped `rocq-runtime.META`** (all `archive(…)`/`plugin(…)` lines
   removed, `requires` kept). Rocq's `Mltop.declare_ml_modules` still resolves the
   dependency graph via findlib (`add_deps`, `digest`), but with no `archive` the
   plugin file list is empty ⇒ zero `Dynlink.loadfile` calls, zero `Digest.file`
   on missing `.cmxs`. The `Declare ML Module` becomes a no-op over already-linked
   code.

This is the jsCoq/wacoq "static plugin" idea, done with a stripped META instead
of a patched loader. Adding a plugin to the demo = add it to `web/dune` (the
stripped META already lists every rocq-runtime plugin).

### 12.5 Bundle sizes

| layer | `.vo` | size |
|---|---|---|
| Corelib prelude (`theories/`) | 65 | ~1.9 MB |
| Ltac2 (`user-contrib/Ltac2`) | 42 | ~0.2 MB |
| **total `dist/coqlib/`** (incl. stripped META + manifest) | 107 | **~6.1 MB on disk** |
| engine `dist/rocq_engine.js` (with the 5 statically-linked plugins) | — | ~33 MB |

---

## 13. Build phase 4 — a Stdlib subset runs in the browser (Milestone 2)

**Status: `ring` / `field` / `lia` / `lra` over `Z`, `Q`, `R` kernel-check
in-browser.** Verified headlessly (browser-worker emulation + node `make test`):

```
From Stdlib Require Import ZArith.  ... (a+b)*(a+b) = a*a+2*a*b+b*b   by ring  -> ok:true proved
From Stdlib Require Import ZArith Lia.  ... n <= n+1                  by lia   -> ok:true proved
From Stdlib Require Import Reals Lra.  ... (x+y)*(x+y)=...            by ring  -> ok:true proved
                                        x<>0 -> x/x = 1               by field -> ok:true proved
                                        x<=y -> x-1<=y                by lra   -> ok:true proved
```

### 13.1 Building the Stdlib with the patched rocqc — the two real snags

`rocq-stdlib.9.1.0` is a separate dune `coq.theory`. Building it turned on two
problems that did **not** hit Corelib:

1. **dune resolved the *stock* switch Corelib.** `dune build` in the stdlib tree
   used `/…/_opam/bin/coqc … -R /…/_opam/lib/coq/theories Coq` — the stock,
   *unpatched* Corelib (63-bit hashes) — even with OCAMLPATH pointed at the
   patched install. Stdlib `.vo` then inherited stock Corelib's unmasked hashes
   and `Marshal.Compat_32` rejected them (`integer cannot be read back on 32-bit
   platform`). Fix: **bypass dune** — `web/.rocq-build/build-stdlib-manual.sh`
   compiles every `.v` in `coqdep -sort` order with the patched
   `rocq compile -coqlib <patched-corelib> -R theories Stdlib`. With the patched
   Corelib, **0 readback failures**.

2. **Plugin `.cmxs` were missing / mislocated.** `rocq-core.install` does not
   build the `.cmxs` for the stdlib plugins (ring, micromega(+_core), zify,
   nsatz(+_core), btauto, rtauto, funind), and the native `rocqc` Dynlinks them
   when a `.v` does `Declare ML Module`. Built them (`dune build …/<p>_plugin.cmxs`,
   **dev profile — must match the binary or Dynlink fails with `symbol not found
   … _camlHints$N`**) and placed each at the findlib **package**-named dir
   (`micromega_core/`, `nsatz_core/`, `zify/`), not the source dir.

After both fixes: **568 / 583 `.vo` build** (the 14 skips are extraction,
Floats/Int63 `vm_compute` proofs — which the reference patch also Admits — and a
couple of `Numbers` edge cases; none are on the Z/Q/R + ring/lia/lra path).

### 13.2 Engine + bundle

- `web/dune` statically links the stdlib plugins too (ring, micromega(+_core),
  zify, btauto, rtauto, nsatz(+_core), funind) — engine grows to ~38 MB. The
  stripped META already lists them, so `Declare ML Module` stays a no-op.
- The bundle ships a **Stdlib subset** at `user-contrib/Stdlib` (logical
  `Stdlib.*`), auto-added to the loadpath by `-coqlib`. Full Stdlib is ~41 MB /
  583 `.vo`; the shipped subset (Init/Logic/Bool/Classes/Setoids/Relations/
  Structures/Wellfounded/Program/Lists/BinNums/Arith/PArith/NArith/ZArith/QArith/
  Numbers/setoid_ring/micromega/omega/btauto/nsatz/Reals) is **~28 MB / 432 `.vo`**.

### 13.3 Bundle sizes (per layer)

| layer | `.vo` | size |
|---|---|---|
| Corelib prelude | 65 | ~1.9 MB |
| Ltac2 | 42 | ~0.2 MB |
| Stdlib subset (Z/Q/R + ring/field/lia/lra closure) | 432 | ~28 MB |
| **total `dist/coqlib/`** | 539 | **~35 MB** |
| engine `dist/rocq_engine.js` (16 statically-linked plugins) | — | ~38 MB |

---

## 14. Milestone 3 — mathcomp + mathcomp-analysis: assessed, NOT bundled

**Decision: not feasible to ship in the GitHub Pages bundle. Reported here with
a recommended path; no mathcomp .vo are bundled.** This follows the milestone's
own instruction to STOP and report if the size/build time is impractical.

### 14.1 The numbers (measured on this switch)

| pack | installed? | `.vo` | size | notes |
|---|---|---|---|---|
| mathcomp/boot | yes | 25 | 12.2 MB | ssreflect base (seq, ssrnat, eqtype, …) |
| mathcomp/order | yes | 3 | 20.8 MB | `order.vo` alone is 18.5 MB |
| mathcomp/algebra | yes | 39 | 63.6 MB | the bulk |
| mathcomp/finite_group | yes | 10 | 4.5 MB | |
| mathcomp/ssreflect | yes | 1 | ~0 | wrapper |
| **mathcomp core total** | yes | **78** | **101 MB** | |
| Hierarchy Builder (HB) | yes | 1 | 2.4 MB | + elpi programs |
| **mathcomp-analysis 1.18** | **NO** | — | **~100 MB+ (upstream)** | not installed; needs `opam install rocq-mathcomp-analysis` first |

So the demo the user asked for (import mathcomp **and** mathcomp-analysis) is a
**~200 MB+** `.vo` payload, with the largest single `.vo` ~18 MB.

### 14.2 Feasibility of the *mechanism* (good news)

mathcomp 2.x is built on Hierarchy Builder, i.e. **Coq-Elpi** (`rocq-elpi`), an
ELPI (λProlog) interpreter plugin. The open question was whether that can run
under js_of_ocaml at all. **It can:** the `elpi` library jsoo-compiles cleanly
(2.6 MB, no missing primitives — probed this session), it has **no C stubs**,
and `elpi_plugin.cmxs` is only 2.7 MB. So the in-browser story is exactly the
Corelib/Stdlib one: statically link `rocq-elpi.{elpi,cs,tc,coercion}` + HB into
the engine (~+5–8 MB), add them to the stripped META, regenerate the mathcomp
`.vo` with the patched native rocqc (HB/elpi Dynlinked in, as done for the
stdlib plugins), and mount them via `RocqComparator.mount`. Nothing here is a
fundamental blocker — it is purely **size and build time**.

### 14.3 Why it is impractical for Pages, and how long it would take

- **Fetch size.** A Pages page would have to fetch 100 MB (core) to ~200 MB+
  (core + analysis) of `.vo` before the first mathcomp check. That is not a
  usable web page load, independent of the 100 MB/file and ~1 GB/repo Pages
  limits (which the individual `.vo`, ≤18 MB, do not hit, but the repo would
  balloon).
- **Build time.** Regenerating mathcomp core with the patched rocqc is HB-heavy
  (elaboration per file; `algebra` is the long pole) — estimate **30–90 min**.
  analysis is **not installed**, so it would first need a fresh
  `opam install rocq-mathcomp-analysis` (pulling more deps) and then a patched
  rebuild — **several hours** end to end.

### 14.4 Recommendation

Do **not** put mathcomp/analysis in the Pages bundle. Instead:

1. **Lazy-load, layered packs.** Serve mathcomp as separate `.vo` packs
   (`boot`, `order`, `algebra`, `finite_group`, `analysis`) and have the worker
   fetch a pack only when a challenge actually `From mathcomp Require`s it
   (parse the imports, or fetch-on-first-missing-library). The mounting seam
   (`mount` + stripped META + static plugins) already supports this unchanged.
2. **Host the packs off Pages** — a GitHub Release asset or a CDN/object store —
   so the Pages repo stays small and the big payload is fetched on demand (and
   cached by the browser) rather than shipped with every page load.
3. **Engine:** statically link `rocq-elpi` + HB plugins once (jsoo-compatible,
   ~+5–8 MB) so any mathcomp pack can be mounted without further engine changes.

A minimal proof-of-concept (mathcomp/boot only, ~12 MB + HB) is achievable with
the same pipeline if a small in-browser mathcomp demo is wanted; the full
mathcomp + analysis demo should be lazy-loaded/off-Pages as above.

---

## 15. Build phase 6 — two WebAssembly engines (cps default + JSPI upgrade), no js_of_ocaml

**Status: the shipped engine is a `wasm_of_ocaml` build, and the js_of_ocaml
backend has been removed.** The same coerce-32bit overlay, the same 32-bit-safe
`.vo` bundle, and the same seam (`web/web_check.ml`) produce **two** engines
from one bytecode, differing only in the `wasm_of_ocaml` effects backend:

- **`dist/engine-cps/`** (`--effects=cps`) — the **default**: needs no JSPI, so
  it runs wherever the engines run at all (WebAssembly GC, tail calls and
  exception handling: Chrome/Edge 119+, Firefox 122+, Safari 18.2+, Node 22+;
  §6.2). ~12 MB `.wasm`.
- **`dist/engine-jspi/`** (`--effects=jspi`) — a smaller/faster **upgrade**
  (~5 MB `.wasm`) using the JS Promise Integration API; loaded only where
  `WebAssembly.Suspending` exists (Chrome/Edge ≥ 137, Node 24+).

`web/rocq_worker.js` feature-detects JSPI at load and fetches exactly one engine.
Both are verified headless under Node (`make test` → **12 passed, 0 failed** for
*each*, incl. `nat`+induction, ZArith `ring`, Reals `lra`). There is **no**
`js_of_ocaml` build path any more.

### 15.1 Sizes (measured)

| engine | module | glue | total | audience |
|---|---|---|---|---|
| **WASM cps (default)** | 12.3 MB `.wasm` | 20 KB `.js` | **~12.3 MB** | Chrome/Edge 119+, Firefox 122+, Safari 18.2+, Node 22+ |
| WASM jspi (upgrade) | 5.10 MB `.wasm` | 20 KB `.js` | ~5.12 MB | Chrome/Edge ≥ 137, Node 24+ |

Each visitor downloads exactly one of these. The `.vo` bundle (`dist/coqlib/`,
~35 MB) is **reused unchanged** by both — the 31-bit wasm runtime reads the same
30-bit-hash-masked `.vo` the 32-bit build did.

### 15.0 The browser fetch bug (fixed) — `mount()` must get byte-exact bytes

The engine's `mount(path, content)` writes `content` into the OCaml VFS via
`Js.to_bytestring`, which reads **each JS char code as one raw byte (0-255)**.
So a binary asset (`.vo`, META) must reach `mount()` as a string whose char code
`i` equals byte `i`. The shipped worker built that string with
`new TextDecoder('latin1').decode(bytes)` — which is **not** byte-exact in a
browser: per the WHATWG Encoding Standard the label `latin1` is an alias for
**windows-1252**, whose decoder remaps bytes `0x80–0x9F` to other code points.
A `.vo` size field in that range then read as a huge/negative length and the
kernel raised `Invalid_argument("Bytes.create")` while parsing `Prelude.vo`:

```
Error when parsing .vo (from .../Init/Prelude.vo) for library Corelib.Init.Prelude:
Anomaly "Uncaught exception Invalid_argument("Bytes.create")."
```

(Node's own `TextDecoder` happens to decode `0x80–0x9F` byte-for-byte, which is
exactly why the node test passed while every real browser broke.) **Fix:**
`web/rocq_bytes.js` — a single shared conversion using `String.fromCharCode`
over the fetched `Uint8Array` (byte-exact in every JS engine, no `TextDecoder`),
loaded by both the worker and the node test. The `.wasm` itself is fetched
byte-safely by the glue (`instantiateStreaming`), so only these VFS assets need
the explicit conversion. **Guard:** `test/judge_test.cjs` feeds the `.vo`/META
through the *same* `rocq_bytes.js` conversion the worker uses (not node's
`Buffer.toString('latin1')`, which hid the bug), and `ROCQ_DECODE=browser`
forces the pre-fix windows-1252 decode to reproduce the failure headlessly.

### 15.2 The one structural difference — C primitives must be WebAssembly

`wasm_of_ocaml` resolves an OCaml `external` C primitive from the **WASM**
runtime only: a JS `//Provides` fragment (how the now-removed js_of_ocaml
backend's `runtime_shims.js` / `zarith_stubs.js` worked) is **not** consulted and
becomes a throwing dummy (verified with a one-line probe). So every custom primitive the
natively-built rocq-runtime references is supplied as WebAssembly in
**`web/rocq_shims.wat`** (passed to `wasm_of_ocaml compile` as a runtime file;
the compiler assigns it module `env`, binaryen merges it into the runtime):

- **Float64** (`rocq_f{add,sub,mul,div,sqrt}_byte`, `rocq_next_{up,down}_byte`) —
  real `f64` ops; boxes via `struct.new $float` (binaryen canonicalises the
  identical struct type with the runtime's). The kernel's IEEE self-test at
  module-init exercises these, so they must be correct — they are.
- **threads.posix** (`caml_thread_*`) — single-threaded no-ops (`ref.i31 0`).
- **VM init** (`init_rocq_vm`, `rocq_accumulate`, `rocq_makeaccu`,
  `rocq_offset_tcode`, …) — benign dummies (VM is off, `vm:false`); the VM
  *interpreter* prims stay throwing dummies (never reached).
- **`caml_unix_getpid`** — fixed pid.
- **zarith** (`ml_z_*`, ~30 referenced) — the interesting one, below.

### 15.3 zarith backed by JavaScript BigInt (correct arbitrary precision)

`rocq-runtime.interp` (a *core* library, needed by every check) requires
`zarith`, and its `Z` module calls `ml_z_*` at load — so the engine cannot even
boot without a working zarith. `external`s are inlined as primitive references
at the call sites of the already-compiled `interp`/`micromega`, so an OCaml
zarith overlay cannot remove them; they must be provided as wasm.

The wasm `ml_z_*` stubs in `rocq_shims.wat` are thin marshallers: they represent
a *small* `Z.t` as an OCaml `i31` int and a *big* one as a JS `BigInt` wrapped by
the runtime's `wrap`, and delegate the actual arithmetic to JS `BigInt` helpers
(`web/rocq_zarith.js`, `globalThis.rocqz_*`). `BigInt` gives **exact arbitrary
precision**, so this is a correct zarith, not an approximation (Reals `lra`,
which drives micromega's rational certificate search through zarith, passes).

The wasm imports the helpers from the **`js`** import module, which
`wasm_of_ocaml` binds to a small object `ag`; a one-line post-build patch
augments it — `js:ag` → `js:Object.assign(ag, globalThis.__rocqz)` — and
`rocq_zarith.js` (loaded by the worker *before* the engine) sets
`globalThis.__rocqz`. `int64`/`string`/tuple marshalling uses the runtime's
exported `caml_copy_int64`/`Int64_val`/`caml_string_of_jsstring`/
`caml_jsstring_of_string` and a `$block` (tag at index 0).

### 15.4 VFS read-side patches (`web/patches/coerce-wasm-readside.pl`)

The in-browser VFS (`Sys_js` → the wasm runtime's virtual filesystem) works, but
is stricter than jsoo's, so three read-side spots in the overlaid `lib.cma` /
`clib.cma` needed patching (no effect on `.vo`, and no-ops on native/jsoo):

1. `lib/system.ml` `apply_subdir`: the loadpath scanner read `(Unix.stat p).st_kind`;
   the VFS has no `Unix.stat` (it throws → `S_BLK` → the mounted coqlib is
   skipped). Use `Sys.is_directory` / `Sys.file_exists`, which are VFS-aware.
2. `clib/cUnix.ml` `canonical_path_name`: it canonicalises via `Sys.chdir p;
   Sys.getcwd ()`. Under jsoo `chdir` tracks a virtual cwd (works); under wasm +
   node `chdir` into a VFS dir fails and the fallback prepended the *real* cwd,
   mangling the absolute `-coqlib` path. For an absolute path, return it as-is.
3. `lib/system.ml` `file_exists_respecting_case`: it appended `Filename.concat
   path "."` (→ `"path/."`) which the VFS does not normalise and cannot
   `readdir`; use `path` directly when the dir component is `.`.

The seam's Promise helpers were also made backend-portable (`Promise.resolve`
wrapped in a function expression, so `fun_call` keeps the right `this` on wasm).

### 15.5 Build / worker / test wiring

- `web/build-real.sh`: builds the seam bytecode against the overlay, then runs
  `wasm_of_ocaml compile web/rocq_shims.wat …` **twice** (`--effects=cps` →
  `dist/engine-cps/`, `--effects=jspi` → `dist/engine-jspi/`). Per engine it
  applies the `js:ag` glue patch and rewrites the glue's `src` to
  `engine-<eff>/rocq_engine.assets` (the glue fetches the `.wasm` relative to the
  worker's URL, and the engine lives in a subdir while the worker sits at dist
  root). It also stages the shared `dist/rocq_bytes.js` / `dist/rocq_zarith.js`.
- `web/rocq_worker.js`: `jspiAvailable()` = `typeof WebAssembly.Suspending ===
  "function"`; `ENGINE_DIR` = `engine-jspi` when true, else `engine-cps`. Then
  `importScripts('rocq_bytes.js', 'rocq_zarith.js', ENGINE_DIR+'/rocq_engine.js')`
  (byte-exact conversion + BigInt backend first), and waits for the
  asynchronously-installed `RocqComparator` (wasm instantiates async). VFS assets
  are fetched via `RocqBytes.bytesToBinaryString` (§15.0).
- `test/judge_test.cjs`: an orchestrator that runs the 12-check suite against
  **both** engines (one child process each — `RocqComparator` + its VFS are
  per-process singletons), feeding the `.vo`/META through the same
  `rocq_bytes.js` conversion the worker uses, plus a byte-exact preflight guard.
  `ROCQ_DECODE=browser` forces the pre-fix windows-1252 decode to reproduce the
  fetch bug headlessly (§15.0).

### 15.6 Browser caveat (could not be verified live — no browser here)

Verified **headless under Node 24** only (both engines, 12/12 each). Selection is
by capability, not user-agent: `engine-jspi/` where `WebAssembly.Suspending`
exists (Chrome/Edge ≥ 137, Node 24+), else `engine-cps/` (the cps backend uses
no JSPI at all; both still need WasmGC, tail calls and exception handling; §6.2).
GitHub Pages
serves `.wasm` as `application/wasm` and both engines are single-threaded, so no
COOP/COEP headers are needed. Live in-browser behaviour (Worker `importScripts`,
the JSPI feature-detect, `fetch` of the `.assets` `.wasm` relative to the worker
URL, byte-exact `.vo` mount, the hard kill-timeout) follows the documented
contract but was not exercised in a real browser this session.

### 15.6.1 A library that does not download

`ensurePacks` runs before the check. Until now a failure there was swallowed
and the check ran anyway, so a pack that did not arrive surfaced as the engine
reporting `Unable to locate library ...`, which reads as a broken proof. A
failed fetch now ends the check with `library download failed: the "<pack>"
library did not download (...)`, which the page shows as "Library download
failed". Each file is retried once first, since a dropped connection in the
middle of a 200 MB pack is common. The browser test covers it by serving 404
for one pack's files and asserting the page's banner.

### 15.7 One linear memory (Safari)

Safari on iOS 26.6.1 refused both engines: `WebAssembly.Module doesn't parse at
byte 2528934: Memory section has more than one memory, WebAssembly currently
only allows zero or one`. Safari has no multi-memory support ([WebKit bug
277743](https://bugs.webkit.org/show_bug.cgi?id=277743)); Chrome, Firefox and
Node have it, which is why every test passed. The cause is the stock
`wasm_of_ocaml` 6.4.1 runtime: `runtime-cps.wasm` and `runtime-standard.wasm`
define three memories, the C runtime's (zstd and its malloc, 4 pages), blake2's
(2 pages) and the one-page string scratch buffer `jsstring.wat` exports as
`caml_buffer`, which the JS glue reads at offset 0 (`read_string`,
`write_string`). Upstream fixed this on master after 6.4.1 ([PR
2405](https://github.com/ocsigen/js_of_ocaml/pull/2405) "Use a single linear
memory", CHANGES: "Safari (and hence Bun) does not support modules with several
memories"); no released version or compiler flag emits one memory yet, so the
build post-processes each engine with `web/wasm_memories.cjs --lower`:

1. It points the `caml_buffer` export at memory 0 (binaryen's pass only keeps
   the first memory's export) and runs
   `wasm-opt --enable-gc --enable-multivalue --enable-exception-handling
   --enable-reference-types --enable-tail-call --enable-bulk-memory
   --enable-nontrapping-float-to-int --enable-strings --enable-multimemory
   --enable-mutable-globals --enable-sign-ext --enable-bulk-memory-opt
   --multi-memory-lowering in.wasm -o out.wasm` (binaryen 132), which lays the
   three memories out one after the other in a single memory (4+2+1 pages) and
   rewrites every access to memories 1 and 2 through an offset global. The
   result defines one memory, imports none, and exports it as `caml_buffer`.
   Sizes: cps 18249586 to 18249374 bytes, jspi 7589352 to 7587588 bytes.
2. The scratch buffer is now the last 65536 bytes of that memory. The only
   `memory.grow` in the module is the C runtime's malloc on memory 0; the pass
   then grows the combined memory and moves the other two regions up, which
   keeps the scratch buffer at the end but detaches the `ArrayBuffer` the glue
   cached at start-up. So the glue is patched to derive the view on every
   call, `k=()=>{var b=I.buffer;return new Uint8Array(b,b.byteLength-65536)}`
   in place of the cached `buffer` and `out_buffer` of `read_string`,
   `read_string_stream` and `write_string` (master's `runtime.js` does the same
   on demand). The wasm side (`caml_extract_bytes` and the `jsstring.wat`
   helpers) is rewritten by the pass.

Guard: `test/judge_test.cjs` parses each shipped module's import, memory and
export sections (no dependencies) and fails unless it has one memory in total.
Verified headless (Node, both engines) and in Chromium; not on Safari itself.

---

## 16. Build phase 7 — Phase 2: trusted `.vos` lazy-import framework (mathcomp)

**Status: works end to end. The `.vos` trust model works in the browser engine;
the lazy per-pack import framework works (Corelib always-on, Stdlib + mathcomp
packs fetched only when a source imports them); the mathcomp toolchain builds
every pack as 32-bit-safe `.vos`; `From mathcomp Require Import all_ssreflect`
proofs are checked in both wasm engines, in node (`make test`) and in a real
browser (`make test-browser`). The one-time "Unknown dynamic tag" failure was a
missing plugin link, not a wasm_of_ocaml limit (section 16.6).**

### 16.1 Why `.vos` (the trust rationale)

A `.vos` is a library **interface**: constant types + transparent definitions,
with the opaque (`Qed`) proof terms stripped. Loading a `.vos` type-checks the
SOLUTION *against* the library without its proof terms — i.e. it **trusts** the
library. That is already the browser trust model (rocqchk is off in-browser, so
even `.vo` are trusted there), so `.vos` changes nothing about soundness and is
smaller. Proven directly: a one-file library with an opaque lemma compiled
`rocqc -vos` (proof stripped, 981 B vs 1297 B `.vo`), mounted into the engine,
lets a solution `exact: mylemma` type-check → `ok:true`, with the lemma reported
under `assumptions` (`Mylib.Foo.mylemma`) — the kernel sees the stripped opaque
proof as a trusted assumption. Trusted-library assumptions are permitted by the
existing **Imported** axiom policy (`src/check.ml`: every library the challenge
`Require`d is permitted as `<lib>.*`), so a mathcomp solution's use of mathcomp
lemmas is accepted without a per-axiom list.

Reality check for mathcomp: `.vos` is only ~3% smaller than `.vo` there — mathcomp's
bulk is **transparent** (the HB algebraic hierarchy: structures, coercions,
canonical instances), not opaque proofs. The win is brotli + lazy loading, not
opaque-stripping.

### 16.2 The one real port for elpi/HB (`hash_bits = 30`)

mathcomp 2.x is built on Hierarchy Builder → Coq-Elpi → the ELPI interpreter.
Rebuilding elpi/HB/mathcomp as 32-bit `.vos` with the patched native `rocqc` hit
`Failure("output_value: integer cannot be read back on 32-bit platform")` — elpi's
clause index hashes with `hash_bits = Sys.int_size - 1`, which is **62** on the
64-bit build host, so the serialized index reaches `2^62-1`, which `Marshal.Compat_32`
refuses (and the 31-bit wasm reader could not read). Fix (exactly analogous to the
kernel's 30-bit hashset masking, §12.1): patch elpi to `hash_bits = 30` (the value
a 32-bit host uses) and `all_1 size = (1 lsl size) - 1`, so compile-time and
wasm-runtime hashes agree and fit. With that, elpi.vos, HB.structures.vos, and all
mathcomp packs marshal and load. The index is a heuristic candidate filter (elpi
verifies by unification), so different hash values are sound. A second wasm-safe
patch replaces one `Marshal.to_string ast [Marshal.Closures]` digest (elpi
`API.ml`) with a closure-free `Program.show_decl_list` digest (marshalling a
closure needs the bytecode section table, absent without `--toplevel`).

Native ABI note: a plugin dynlinked into the patched native `rocqc` must be built
against the patched runtime's **own** native `.cmx` (`rocq-runtime.install`), not
the overlay (whose native `.cmx` are stock — the overlay only swaps the `.cma`
bytecode archives for the wasm engine). Mixing them gives `Dynlink error:
implementation mismatch on <Module>`.

### 16.3 Static-linking elpi into the wasm engine

The engine (`web/dune`) statically links `rocq-elpi.elpi` and its apps
(`rocq-elpi.coercion`/`cs`/`tc`), Rocq's own `ssreflect` and `ssrmatching`
plugins, and (for mathcomp algebra's tactics, §16.7) `rocq-micromega-plugin.plugin`
and `.zify`; their `Libobject`/`Dyn`/`Genarg` registrations run at engine init, so the
libraries' `Declare ML Module` lines are no-ops over already-linked code
(stripped METAs, same trick as §12.4). The rule: every plugin whose objects or
generic arguments appear in a shipped `.vo`/`.vos` must be linked, or loading
that file fails with `Unknown dynamic tag`. On wasm `Sys.int_size = 31 ⇒ hash_bits = 30`, matching the
patched-native `.vos` (verified: 0/701 `Hashtbl.hash` mismatches between the wasm
engine and native for every registered `Dyn` tag). `wasm_of_ocaml compile
--linkall` is now required: without it, DCE drops object-type registrations that
are only reached as init side effects, and loading a `.vo`/`.vos` carrying such an
object fails with `Not_found`/`Unknown dynamic tag`. elpi wasm-compiles cleanly
(no C stubs); the engine grows ~12 MB → ~15.5 MB (cps).

### 16.4 Lazy per-pack import (the framework)

Libraries are published as separate **packs** (`dist/coqlib/packs.json`), each a
set of `.vos`/`.vo` sharing a logical-name prefix. Manifest format:

```json
{ "coqlib_vfs": "/static/coqlib",
  "packs": [
    { "name":"corelib", "always":true, "prefixes":["Corelib"],
      "meta":"rocq-runtime.META", "meta_vfs":"/static/lib/rocq-runtime/META",
      "size": 1998000, "vo":["theories/Init/Prelude.vo", ...] },
    { "name":"stdlib", "prefixes":["Stdlib"], "size":..., "vo":[...] },
    { "name":"mathcomp-hb", "prefixes":["HB","elpi","elpi_elpi"],
      "meta":"rocq-elpi.META", "meta_vfs":"/static/lib/rocq-elpi/META", "vo":[...] },
    { "name":"mathcomp-boot", "prefixes":["mathcomp.boot"],
      "requires":["mathcomp-hb"], "size":..., "vo":[...] },
    { "name":"mathcomp-order", "prefixes":["mathcomp.order"],
      "requires":["mathcomp-hb","mathcomp-boot"], ... }, ...
  ] }
```

Three optional fields serve the page's Libraries strip: `internal: true` marks
a support pack (never listed), `import` is the example line a visitor can
insert (`stage-packs.sh` derives it from the pack's `all_*` or own module), and
`featured: true` marks the entry points the strip shows (the other packs are
reached through them).

Mechanism (`web/rocq_packs.js`, shared by the worker and the node test):
1. **Scan** the challenge + solution sources for `Require` / `From X Require`
   (`scanRequires`), yielding imported logical names.
2. **Resolve** those to packs (`resolvePacks`): longest matching `prefix`, else by
   module basename (so `From mathcomp Require Import all_ssreflect` → the pack
   whose `vo` contains `all_ssreflect`), then close over each pack's `requires`.
3. **Fetch + mount** only those packs, byte-exact (§15.0), **cached** across checks
   so each pack downloads once. `always` packs (Corelib) mount at startup; a pack
   the sources never import is never downloaded.

One subtlety: Rocq's recursive coqlib loadpath enumerates subdirs **once** at the
first check's `Driver.init`, so a pack dir mounted later would not be bound. The
worker therefore **predeclares** every pack's directories (a 0-byte `.keep` per
dir, generated from `packs.json` — no download) at startup, so the loadpath binds
every logical name; the `.vo` themselves stay lazy (`select_vo_file` re-checks
file existence per `Require`). A served `.vos` is mounted at a `.vo` VFS path (its
content IS opaque-stripped vos-format; the `.vo` name sidesteps the `.vos`
loadpath branch's `Unix.stat`, which wasm_of_ocaml does not provide for the VFS).

Verified headless (both engines, `make test`, 15/15): Corelib always-on; the
Stdlib ZArith/Reals checks fetch **only** the `stdlib` pack on their `From Stdlib
Require`; non-mathcomp checks fetch **no** mathcomp pack; the resolver maps
`all_ssreflect` → `mathcomp-hb+boot+order+ssreflect` and `Stdlib` → `stdlib` only.

### 16.5 packs: sizes (raw `.vos`)

Built from mathcomp 2.6.0 and mathcomp-analysis 1.18.0 with the patched `rocqc`
(`web/build-mathcomp.sh`, `-vos`, one `make -j8` over a Makefile generated from
`rocq dep`; about 42 min):

| pack | files | raw |
|---|---|---|
| corelib (always) | 65 | 1.9 MB |
| stdlib (subset) | 432 | 27.5 MB |
| mathcomp-hb (elpi + locker + HB) | 4 | 3.5 MB |
| elpi-derive (elpi.apps.derive, used by the algebra tactics) | 32 | 19.7 MB |
| micromega-plugin (user-contrib/micromega_plugin) | 14 | 0.2 MB |
| mathcomp-boot | 25 | 11.0 MB |
| mathcomp-order | 3 | 21.1 MB |
| mathcomp-fingroup | 10 | 4.4 MB |
| mathcomp-ssreflect (all_ssreflect) | 1 | 0.0 MB |
| mathcomp-algebra | 39 | 62.1 MB |
| mathcomp-solvable | 21 | 7.3 MB |
| mathcomp-field | 13 | 8.8 MB |
| mathcomp-finmap | 3 | 1.8 MB |
| mathcomp-bigenough | 1 | 0.0 MB |
| mathcomp-classical | 15 | 10.2 MB |
| mathcomp-reals | 5 | 5.3 MB |
| mathcomp-analysis | 98 | 50.9 MB |
| **all packs** | **881** | **235.8 MB** (dist 264 MB) |

What an import fetches (pack closure, from `packs.json`): `all_ssreflect` 4 packs,
35.5 MB; `all_algebra` 7 packs, 122.0 MB; an analysis import (`all_ssreflect
all_algebra reals sequences exp`, or `all_analysis`) 14 packs, 206.4 MB, which
`gzip -9` would bring to 102 MB (nothing is shipped compressed; GitHub Pages
compresses on the wire). Pack `requires` are no longer hand-written: `rocq dep`
over the staged sources is saved as `deps.txt` and `stage-packs.sh` maps each
dependency path to the pack that ships it.

### 16.6 The "Unknown dynamic tag" failure, resolved

Loading the boot/order layer at first failed in the wasm engine with `Unknown
dynamic tag 362944419` (`clib/dyn.ml`). A `Dyn` tag is `Hashtbl.hash` of the
tag's name, so hashing every string literal in the Rocq, rocq-elpi and elpi
sources found the name: `ssrhintarg`, a generic-argument type registered by
Rocq's **ssreflect plugin** (mathcomp's `Ltac done` carries one). `Corelib.ssr`
declares that plugin with `Declare ML Module`, which the stripped META turns into
a silent no-op, and `web/dune` did not link it. Linking `ssreflect` and
`ssrmatching` (and the rocq-elpi apps) fixed it; the engines grow by about 0.9 MB
(cps) / 0.4 MB (jspi). Two build-order rules came out of the same investigation:
`build-real.sh` must not wipe the overlay's `elpi`/`rocq-elpi` entries (it did,
so any `make real` after `make mathcomp` re-linked the stock elpi), and Corelib,
Stdlib and the mathcomp `.vos` must all come from one native build (a `.vo`
records the digests of its dependencies). `web/stage-packs.sh` now proves the
latter by compiling a probe with the patched native `rocqc` against the staged
`dist/coqlib` (`ZArith`, `Reals`, `lia`, `lra`, `all_ssreflect`, `all_fingroup`)
and failing the build on any mismatch.

### 16.7 mathcomp-analysis: built and verified

`rocq-mathcomp-analysis 1.18.0` (with `classical`, `reals`, `finmap`, `bigenough`,
`solvable`, `field`) is installed in the core switch (no runtime file touched) and
every `.v` of every `user-contrib/mathcomp/*` dir compiles to `.vos` (284/284,
plus `elpi.apps.derive` 32/32 and `micromega_plugin` 14/14). Two things were
needed beyond the ssreflect layer:

- mathcomp 2.6's `ring`/`field`/`lra` tactics (`algebra/ring_tactic.v` etc.) use
  the standalone opam `rocq-micromega-plugin` (theories under
  `user-contrib/micromega_plugin`, plugins `rocq-micromega-plugin.plugin` and
  `.zify`, module names distinct from rocq-runtime's), plus `elpi.apps.derive`
  (`derive.std`, `param2`) and the `*.elpi` files of `algebra/` that are only in
  the source tree. The plugin is rebuilt against the patched runtime (like
  rocq-elpi) for the native `.vos` build, statically linked in `web/dune` for the
  engine, and resolved through a stripped META. Stdlib is not needed by any of it
  and is not on the build loadpath (it made an unqualified `Require ssreflect` in
  `derive` ambiguous).
- `Local Import` in `topology_theory/function_spaces.v` trips
  `unsupported-attributes` (an error by default); analysis builds with `-w
  -parsing`, the script now passes `-w -unsupported-attributes`.

The native probe compiles `all_algebra` + `ring` and `all_reals all_analysis` (an
`expR0` lemma) against `dist/coqlib`. Verified end to end: `make test` (22/22 per
engine, node children run with a 16 GB heap) and `make test-browser` (headless
Brave, both engines): `From mathcomp Require Import all_ssreflect all_algebra
reals sequences exp`, `Lemma foo (R : realType) : expR 0 = 1 :> R` proved by
`expR0`, first analysis check 78 s on the JSPI engine and 128 s on cps, the
Admitted variant rejected as `not_proved`. Cost: the wasm engine keeps the loaded
libraries in the JS heap; the `exp` closure peaks at about 9 GB RSS in node
(native `rocqc`: 1.6 GB), `all_analysis` at 16 GB, so node's default 4 GB heap is
not enough and a browser needs several GB free. `all_ssreflect` alone fits the
old budget.

### 16.8 How to add a pack

1. Compile the library's `.vos` with the patched `rocqc` (extend
   `web/build-mathcomp.sh`: add its source dir + loadpath, compile in
   `rocq dep -sort` order against the patched Corelib).
2. Stage it (`web/stage-packs.sh`): copy the `.vos` under
   `dist/coqlib/user-contrib/<Lib>/`, and add a pack entry to `packs.json` with
   its `prefixes` (logical-name roots), `requires` (other packs it depends on),
   and `vo` list. `always:true` for prelude-level packs.
3. If the library `Declare`s an ML plugin, statically link it in `web/dune` and
   add a stripped META (archive/plugin lines removed).
No worker/engine change is needed — the scan→resolve→fetch→mount path is generic.

### 16.9 Files (Phase 2)

- `web/rocq_packs.js` — shared lazy scan (`scanRequires`) + resolve (`resolvePacks`).
- `web/rocq_worker.js` — packs-aware: predeclare dirs, mount `always` packs, lazy
  `ensurePacks` per check. `?engine=cps|jspi` on the page URL forces a variant.
- `web/web_check.ml` — `Loadpath.load_vos_libraries := true`; links `rocq-elpi.elpi`.
- `web/build-mathcomp.sh` — reproducible patched elpi/HB/mathcomp `.vos` build.
- `web/stage-packs.sh` — copy the `.vos` packs into `dist/coqlib`, write
  `packs.json`, and run the native consistency probe (fails on digest mismatch).
- `test/judge_test.cjs` — 28 cases per engine via lazy packs, including the
  mathcomp, mathcomp-analysis, Coquelicot and Equations proofs and their lazy fetch.
- `test/browser_smoke.cjs` — the same in a real headless browser (`make
  test-browser`), both engines, including the mathcomp and analysis proofs and
  lazy fetch (it prints the first analysis check's wall-clock time).
- `Makefile` `bundle` — the required order from scratch: `native`, `stdlib`,
  `mathcomp`, `libs`, `real`.

## 17. Build phase 8: full Stdlib split per directory, Coquelicot, Equations

### 17.1 Stdlib: every module, one pack per directory, built with the VM off

`web/build-stdlib.sh` now compiles all 582 modules of rocq-stdlib 9.2.0 (a
Makefile generated from `rocq dep`, parallel and incremental) with
`-bytecode-compiler no`. The rule: the patched native rocqc represents primitive
ints as Int64 on the OCaml side (coerce-32bit) while its C bytecode VM still uses
native 63-bit ints, so VM evaluation of `Uint63` constants disagrees with the
kernel (`Uint63.v` fails with "Cannot find witness", and with it Sint63, Cyclic63,
Ring63, Floats, PArray, PString, ZifyUint63, ZifySint63 and extraction/ExtrOCaml*,
the 14 modules the old build could not produce). With the VM off `vm_compute`
falls back to `compute` and every module builds; a VM-on and a VM-off build of
the other modules give byte-identical `.vo`, and the browser engine runs with
`vm=false` anyway (there is no VM in wasm). The native probe of
`web/stage-packs.sh` compiles with the same flag.

`build-real.sh` stages every built `.vo` under `user-contrib/Stdlib`; there is
no subset list any more. `stage-packs.sh` writes one pack per top-level Stdlib
directory (`stdlib-<Dir>`, prefix `Stdlib.<Dir>`; root-level modules, if any,
would form a `stdlib` pack) and derives every pack's `requires` from the raw
`rocq dep` output each build leaves behind (`mc-build/deps.txt`,
`stdlib-src/deps.txt`, `libs-build/src/deps.txt`). The resolver
(`web/rocq_packs.js`) resolves a basename shipped by several packs (`ssreflect`
in both `Stdlib.ssr` and `mathcomp.boot`) to the pack whose prefix shares the
import's root. Result: 41 packs, 582 files, 40.8 MB; `From Stdlib Require Import
ZArith` (or `Lia`, or `Reals Lra`) fetches 27 packs, 29.9 MB, because the
directories depend on each other (ZArith -> micromega -> Reals); `Floats`,
`Strings`, `Vectors`, `MSets`, `FSets`, `Zmod` and the rest are fetched only when
imported. The "Stdlib" chip of the page is the `stdlib-ZArith` pack (label
`Stdlib`, import `From Stdlib Require Import ZArith.`).

### 17.2 Coquelicot 3.4.5 and Equations 1.3.2+9.2 (`web/build-libs.sh`)

Policy: no library patches. A library ships only if its released opam version
builds unmodified on Rocq 9.2 with the installed mathcomp 2.6. Interval 4.11.4
does not (it needs upstream compatibility commits), so Interval and its
dependencies Flocq and Bignums are not shipped until a release builds on 9.2.

`web/build-libs.sh` (Makefile `libs`, run after `mathcomp` in `bundle`) stages
the installed sources into `.rocq-build/libs-build/src/<Lib>`, and compiles them
to `.vos` in `rocq dep -sort` order with `-bytecode-compiler no` against the
native Corelib, `stdlib-src` and `mc-build` (the library being compiled bound
with `-R`, the other with `-Q`). Both are pure `.v` libraries as far as the
kernel is concerned:

- Coquelicot: 24 modules, 1.9 MB of `.vos`; Requires `Stdlib.ssr` and
  `mathcomp.boot`, so its pack requires `mathcomp-boot`, `mathcomp-hb` and the
  Stdlib directories of Reals; the import closure is 31 packs, 46.3 MB.
- Equations: 39 modules, 1.2 MB of `.vos`; its OCaml plugin
  `rocq-equations.plugin` (pure OCaml, no C stubs; depends on
  `rocq-runtime.plugins.cc` and `.extraction`) is rebuilt by build-libs.sh
  against the patched runtime into `.rocq-build/overlay/rocq-equations` (which
  build-real.sh preserves) for the native rocqc, and linked statically into the
  engines (`web/dune`, with `rocq-runtime.plugins.extraction`, declared by
  `Corelib/extraction/Extraction.v` which Equations Requires, and
  `rocq-runtime.plugins.derive`, declared by `Corelib/derive/Derive.v`).
  `stage-packs.sh` ships the stripped META at `/static/lib/rocq-equations/META`.
  The import closure is 32 packs, 31.5 MB (Equations reaches
  `Stdlib.extraction`, hence `Floats` and `Array`). The comparator's filter
  still denies Extraction vernacs; the `Equations` command and `funelim` are
  allowed like any other plugin command.

The native probe now also checks `is_lim_seq_INR` (Coquelicot) and a `funelim`
proof over an `Equations` definition, with the VM off. `make test` has one case
per library (exact lazy pack closure, an accepted proof, Admitted rejected) and
`make test-browser` runs the same two proofs in the real browser with
served-file assertions (Coquelicot, Stdlib/ssr and mathcomp/boot fetched only by
that import; the Equations pack only by its import).
