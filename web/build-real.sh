#!/usr/bin/env bash
# build-real.sh — build the REAL in-browser rocq-comparator backend.
#
# Produces dist/rocq_engine.js: the full rocq-comparator pipeline + a patched
# (Int64-backed, 31-bit-uint63) rocq-runtime kernel, compiled with
# js_of_ocaml, that ACTUALLY RUNS a Rocq check in the browser / node.
#
# The one hard blocker (BACKEND.md 1c) is the kernel's Sys.word_size=64 assert:
# a natively-built rocq-runtime uses uint63_63 (type t = int, 63-bit) which is
# wrong on jsoo's 32-bit int target. We rebuild ONLY the kernel bytecode
# archive (kernel.cma) with the coerce-32bit choice (uint63_31/float64_31,
# Int64-backed) and overlay it via OCAMLPATH, WITHOUT touching the core switch's
# installed rocq-runtime (the native CLI keeps working). uint63.mli is a single
# shared interface, so downstream .cma link unchanged (interface CRC preserved).
#
# Usage:  web/build-real.sh
# Env:    SWITCH (default: the sibling core project's project-local switch)
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # project root (rocq-comparator-web)
SWITCH="${SWITCH:-/Users/gbaudart/Project/llm4rocq/rocq-comparator}"
SW="$SWITCH/_opam"
SRC="$SW/.opam-switch/sources/rocq-runtime.9.2.0"  # opam-extracted Rocq source
WORK="${WORK:-$HERE/.rocq-build}"                  # build scratch (git-ignored)

export PATH="$SW/bin:/opt/homebrew/bin:$PATH"
export OCAMLPATH="$SW/lib"
export CAML_LD_LIBRARY_PATH="$SW/lib/stublibs:$SW/lib/ocaml/stublibs"
export OPAM_SWITCH_PREFIX="$SW"

echo "== [1/5] patch + build kernel.cma (coerce-32bit) =="
mkdir -p "$WORK"
if [ ! -d "$WORK/rocq-src" ]; then
  cp -R "$SRC" "$WORK/rocq-src"
  echo "(lang dune 3.8)" > "$WORK/rocq-src/dune-workspace"
  # coerce-32bit: hard-wire the Int64-backed 31-bit implementations
  perl -0pi -e 's/\(deps \(:gen-file uint63_%\{ocaml-config:int_size\}\.ml\)\)/(deps (:gen-file uint63_31.ml))/' "$WORK/rocq-src/kernel/dune"
  perl -0pi -e 's/\(deps \(:gen-file float64_%\{ocaml-config:int_size\}\.ml\)\)/(deps (:gen-file float64_31.ml))/' "$WORK/rocq-src/kernel/dune"
  # the 31-bit impl asserts Sys.word_size=32; comment it (matches jsoo, harmless)
  perl -0pi -e 's/^let _ = assert \(Sys\.word_size = 32\)/let _ = () (* coerce-32bit *)/m' "$WORK/rocq-src/kernel/uint63_31.ml"
fi
( cd "$WORK/rocq-src" && dune build --root . --profile release kernel/kernel.cma )
PATCHED_CMA="$WORK/rocq-src/_build/default/kernel/kernel.cma"

echo "== [2/5] build OCAMLPATH overlay with the patched kernel.cma =="
OVERLAY="$WORK/overlay"
rm -rf "$OVERLAY"; mkdir -p "$OVERLAY"
cp -Rc "$SW/lib/rocq-runtime" "$OVERLAY/" 2>/dev/null || cp -R "$SW/lib/rocq-runtime" "$OVERLAY/"
cp -Rc "$SW/lib/stublibs"     "$OVERLAY/" 2>/dev/null || cp -R "$SW/lib/stublibs"     "$OVERLAY/"
cp -f "$PATCHED_CMA" "$OVERLAY/rocq-runtime/kernel/kernel.cma"

echo "== [3/5] compile the seam through js_of_ocaml against the overlay =="
export OCAMLPATH="$OVERLAY:$SW/lib"
( cd "$HERE" && dune build web/web_check.bc.js )

echo "== [4/5] assemble dist/ =="
mkdir -p "$HERE/dist"
cp -f "$HERE/_build/default/web/web_check.bc.js" "$HERE/dist/rocq_engine.js"
for f in index.html app.js styles.css rocq_comparator.js rocq_worker.js; do
  [ -f "$HERE/web/$f" ] && cp -f "$HERE/web/$f" "$HERE/dist/" || true
  [ -f "$HERE/$f" ]     && cp -f "$HERE/$f"     "$HERE/dist/" || true
done
[ -d "$HERE/examples" ] && cp -R "$HERE/examples" "$HERE/dist/" || true
touch "$HERE/dist/.nojekyll"

echo "== [5/5] done: dist/rocq_engine.js ($(wc -c < "$HERE/dist/rocq_engine.js") bytes) =="
