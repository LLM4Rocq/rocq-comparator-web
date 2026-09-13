# rocq-comparator-web — build & serve the client-side Rocq comparator.
#
# The whole rocq-comparator check runs client-side on a WebAssembly build
# (wasm_of_ocaml) of rocq-runtime 9.2 + rocq-comparator. The one hard blocker
# (the kernel's Sys.word_size=64 assert) is cleared by rebuilding ONLY kernel.cma
# with the coerce-32bit choice (Int64-backed uint63_31/float64_31) and overlaying
# it via OCAMLPATH — WITHOUT touching the core switch's installed rocq-runtime.
# All of that lives in web/build-real.sh. See BACKEND.md.
#
# TWO engines ship, built from the SAME bytecode, differing only in the
# wasm_of_ocaml effects backend:
#   * dist/engine-cps/  — --effects=cps : UNIVERSAL (all browsers + any Node).
#                         The default the worker loads. Larger .wasm (~12 MB).
#   * dist/engine-jspi/ — --effects=jspi: smaller/faster .wasm (~5 MB), but needs
#                         JSPI (Node 24+, Chrome/Edge 137+). The worker upgrades
#                         to it when WebAssembly.Suspending is available.
# There is no js_of_ocaml backend.
#
# Two kinds of build:
#   * `make site`  — assemble the static bundle in dist/ from the committed
#                    frontend + the (already built) engines. Fast, needs NO opam
#                    switch. This is what CI / GitHub Pages runs.
#   * `make real`  — rebuild BOTH wasm engines + stage the .vo bundle.
#                    Needs the opam switch with rocq-runtime 9.2 sources.
#
# If neither engine is present, the page still loads and the demo-verdict buttons
# work (the live check is simply disabled) — so `make serve` always gives a
# reviewable page.

SWITCH ?= /Users/gbaudart/Project/llm4rocq/rocq-comparator
NODE    = node
PORT   ?= 8000

# Canonical frontend sources copied into dist/ by `make site`. rocq_bytes.js is
# the byte-exact mount() conversion shared by the worker and the node test.
ROOT_STATIC = index.html app.js styles.css
WEB_STATIC  = rocq_comparator.js rocq_worker.js rocq_bytes.js rocq_packs.js rocq_zarith.js
# Docs shipped alongside the site (the in-page honesty note links to BACKEND.md).
DOC_STATIC  = BACKEND.md README.md

.PHONY: all build real engine native prelude stdlib mathcomp libs packs site serve test test-browser clean help

## all: build the real engines and assemble dist/ (needs the opam switch)
all: real

## build: type-check / compile the OCaml seam (dune build; needs the opam switch)
build:
	opam exec --switch=$(SWITCH) -- dune build

## real: (re)build both wasm engines + stage the .vo bundle (needs opam switch + rocq source)
real engine:
	SWITCH=$(SWITCH) bash web/build-real.sh

## native: build the patched native rocqc + regenerate the Corelib prelude .vo (tens of min, once)
native prelude:
	SWITCH=$(SWITCH) bash web/build-native.sh

## stdlib: regenerate the full Stdlib .vo with the patched rocqc, VM off (needs `make native` first)
stdlib:
	SWITCH=$(SWITCH) bash web/build-stdlib.sh

## bundle: everything from scratch, in the required order (native -> stdlib -> mathcomp -> libs -> real)
bundle: native stdlib mathcomp libs real

## mathcomp: build the mathcomp (+elpi/HB) .vos packs + the patched elpi overlay the engine links (needs `make native`; run BEFORE `make real`)
mathcomp:
	SWITCH=$(SWITCH) bash web/build-mathcomp.sh

## libs: build the Coquelicot and Equations .vos packs (+ the Equations plugin overlay); needs stdlib and mathcomp
libs:
	SWITCH=$(SWITCH) bash web/build-libs.sh

## packs: (re)stage dist/coqlib packs + packs.json from already-built .vos
packs:
	SWITCH=$(SWITCH) bash web/stage-packs.sh

## site: assemble dist/ from the committed frontend + engines (fast, no opam needed)
site:
	@mkdir -p dist
	@for f in $(ROOT_STATIC); do cp -f $$f dist/; done
	@for f in $(WEB_STATIC); do cp -f web/$$f dist/; done
	@for f in $(DOC_STATIC); do [ -f $$f ] && cp -f $$f dist/ || true; done
	@[ -d examples ] && cp -R examples dist/ || true
	@touch dist/.nojekyll
	@have=""; \
	 [ -f dist/engine-cps/rocq_engine.js ]  && have="$$have cps"; \
	 [ -f dist/engine-jspi/rocq_engine.js ] && have="$$have jspi"; \
	 if [ -n "$$have" ]; then \
	   echo "site: dist/ assembled (wasm engines:$$have -> live in-browser check enabled)"; \
	 else \
	   echo "site: dist/ assembled (engines ABSENT -> demo-verdict fallback only; run 'make real' to build them)"; \
	 fi

## serve: assemble the static site and serve dist/ on http://localhost:$(PORT)/
serve: site
	@echo "Serving dist/ at http://localhost:$(PORT)/   (Ctrl-C to stop)"
	@cd dist && python3 -m http.server $(PORT)

## test: run the node judge harness against BOTH built engines (28/28 each)
test:
	$(NODE) test/judge_test.cjs "$$PWD/dist"

## test-browser: open the served site in a headless Chromium-family browser (Brave/Chrome/Edge) and check proofs (SMOKE_HEAVY=0 skips analysis)
test-browser: site
	$(NODE) test/browser_smoke.cjs "$$PWD/dist"

## test-live: run the browser checks against the deployed site (URL=https://...)
test-live:
	$(NODE) test/browser_smoke.cjs --url "$(URL)"

## clean: remove build artifacts (keeps the committed engines in dist/)
clean:
	rm -rf _build .rocq-build

## help: list targets
help:
	@grep -E '^## ' Makefile | sed 's/^## //'
