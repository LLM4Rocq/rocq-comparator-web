# rocq-comparator-web — build & serve the client-side Rocq comparator.
#
# The whole rocq-comparator check runs client-side on a js_of_ocaml build of
# rocq-runtime 9.2 + rocq-comparator. The one hard blocker (the kernel's
# Sys.word_size=64 assert) is cleared by rebuilding ONLY kernel.cma with the
# coerce-32bit choice (Int64-backed uint63_31/float64_31) and overlaying it via
# OCAMLPATH — WITHOUT touching the core switch's installed rocq-runtime. All of
# that lives in web/build-real.sh. See BACKEND.md.
#
# Two kinds of build:
#   * `make site`  — assemble the static bundle in dist/ from the committed
#                    frontend + the (already built) engine. Fast, needs NO opam
#                    switch. This is what CI / GitHub Pages runs.
#   * `make real`  — rebuild dist/rocq_engine.js itself (the js_of_ocaml engine).
#                    Needs the opam switch with rocq-runtime 9.2 sources.
#
# If dist/rocq_engine.js is absent, the page still loads and the demo-verdict
# buttons work (the live check is simply disabled) — so `make serve` always
# gives a reviewable page.

SWITCH ?= /Users/gbaudart/Project/llm4rocq/rocq-comparator
NODE    = node
PORT   ?= 8000

# Canonical frontend sources copied into dist/ by `make site`.
ROOT_STATIC = index.html app.js styles.css
WEB_STATIC  = rocq_comparator.js rocq_worker.js
# Docs shipped alongside the site (the in-page honesty note links to BACKEND.md).
DOC_STATIC  = BACKEND.md README.md

.PHONY: all build real engine site serve test clean help

## all: build the real engine and assemble dist/ (needs the opam switch)
all: real

## build: type-check / compile the OCaml seam (dune build; needs the opam switch)
build:
	opam exec --switch=$(SWITCH) -- dune build

## real: (re)build dist/rocq_engine.js + stage the .vo bundle (needs opam switch + rocq source)
real engine:
	SWITCH=$(SWITCH) bash web/build-real.sh

## native: build the patched native rocqc + regenerate the Corelib prelude .vo (tens of min, once)
native prelude:
	SWITCH=$(SWITCH) bash web/build-native.sh

## stdlib: regenerate the Stdlib .vo with the patched rocqc (needs `make native` first)
stdlib:
	SWITCH=$(SWITCH) bash web/build-stdlib.sh

## site: assemble dist/ from the committed frontend + engine (fast, no opam needed)
site:
	@mkdir -p dist
	@for f in $(ROOT_STATIC); do cp -f $$f dist/; done
	@for f in $(WEB_STATIC); do cp -f web/$$f dist/; done
	@for f in $(DOC_STATIC); do [ -f $$f ] && cp -f $$f dist/ || true; done
	@[ -d examples ] && cp -R examples dist/ || true
	@touch dist/.nojekyll
	@if [ -f dist/rocq_engine.js ]; then \
	  echo "site: dist/ assembled (engine present -> live in-browser check enabled)"; \
	else \
	  echo "site: dist/ assembled (engine ABSENT -> demo-verdict fallback only; run 'make real' to build it)"; \
	fi

## serve: assemble the static site and serve dist/ on http://localhost:$(PORT)/
serve: site
	@echo "Serving dist/ at http://localhost:$(PORT)/   (Ctrl-C to stop)"
	@cd dist && python3 -m http.server $(PORT)

## test: run the node judge harness against the built engine (accept/reject cases)
test:
	$(NODE) test/judge_test.cjs "$$PWD/dist/rocq_engine.js"

## clean: remove build artifacts (keeps the committed engine in dist/)
clean:
	rm -rf _build .rocq-build

## help: list targets
help:
	@grep -E '^## ' Makefile | sed 's/^## //'
