#!/usr/bin/env bash
# build-native.sh — build a NATIVE patched rocqc and regenerate 32-bit-safe .vo.
#
# The jsoo engine reads .vo but cannot read STOCK native .vo (their 63-bit
# hashes/ints overflow the 31/32-bit unmarshaller: "input_value: integer too
# large"). We rebuild a native Rocq compiler from the SAME coerce-32bit-patched
# source tree the engine overlay uses (.rocq-build/rocq-src: uint63_31/float64_31
# Int64-backed kernel + 30-bit hash masking + Marshal.Compat_32), then run that
# rocqc to regenerate the Corelib (and later Stdlib) .vo so they load under jsoo.
# The core opam switch is never touched (all output stays in _build).
set -euo pipefail
SWITCH="${SWITCH:-/Users/gbaudart/Project/llm4rocq/rocq-comparator}"
SW="$SWITCH/_opam"
WORK="${WORK:-/Users/gbaudart/Project/llm4rocq/rocq-comparator-web/.rocq-build}"
SRCT="$WORK/rocq-src"
export PATH="$SW/bin:/opt/homebrew/bin:$PATH"
export OCAMLPATH="$SW/lib"                    # external deps (zarith,...); rocq-* built from source
export CAML_LD_LIBRARY_PATH="$SW/lib/stublibs:$SW/lib/ocaml/stublibs"
export OPAM_SWITCH_PREFIX="$SW"
cd "$SRCT"
echo "== [native 1/2] dunestrap (generate theories/Corelib/dune, theories/Ltac2/dune) =="
make dunestrap
echo "== [native 2/2] dune build rocq-core.install (native rocqc + Corelib/Ltac2 .vo) =="
dune build --root . rocq-core.install
echo "== native build done =="
ls -la _build/install/default/lib/coq/theories/Init/Prelude.vo 2>/dev/null || \
  ls -la _build/default/theories/Corelib/Init/Prelude.vo 2>/dev/null || true
