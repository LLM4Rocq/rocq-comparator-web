#!/usr/bin/env bash
# build-stdlib.sh — regenerate the Stdlib .vo with the PATCHED native rocqc.
#
# Prereqs: web/build-native.sh has produced the patched native rocqc + Corelib
# in .rocq-build/rocq-src/_build. This script then:
#   1. builds the stdlib plugins' .cmxs (dev profile, to match the rocqc binary)
#      and installs each at its findlib PACKAGE dir, so the native rocqc can
#      Dynlink them while compiling stdlib .v that Declare ML Module;
#   2. compiles every stdlib .v in `coqdep -sort` order with the patched
#      `rocq compile -coqlib <patched Corelib> -R theories Stdlib`.
#
# Why not dune: dune's coq.theory build resolved the STOCK switch Corelib
# (unpatched, 63-bit hashes), so stdlib .vo failed Marshal.Compat_32
# ("integer cannot be read back on 32-bit platform"). Driving the patched rocqc
# directly against the patched Corelib gives 0 readback failures. The core opam
# switch is never touched. See BACKEND.md §13.
set -uo pipefail
SWITCH="${SWITCH:-/Users/gbaudart/Project/llm4rocq/rocq-comparator}"
SW="$SWITCH/_opam"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$HERE/.rocq-build}"
SRCT="$WORK/rocq-src"                                   # patched monorepo (build-native.sh)
STDT="$WORK/stdlib-src"
INSTBIN="$SRCT/_build/install/default/bin"
INSTLIB="$SRCT/_build/install/default/lib"
CORELIB="$INSTLIB/coq"
PLUG="$INSTLIB/rocq-runtime/plugins"
export PATH="$INSTBIN:$SW/bin:/opt/homebrew/bin:$PATH"
export OCAMLPATH="$INSTLIB:$SW/lib"
export CAML_LD_LIBRARY_PATH="$SW/lib/stublibs:$SW/lib/ocaml/stublibs"
export OPAM_SWITCH_PREFIX="$SW"

[ -x "$INSTBIN/rocq" ] || { echo "run web/build-native.sh first (no patched rocqc)"; exit 1; }

echo "== [stdlib 1/3] unpack stdlib source =="
if [ ! -d "$STDT" ]; then
  cp -R "$SW/.opam-switch/sources/rocq-stdlib.9.1.0" "$STDT"
  echo "(lang dune 3.8)" > "$STDT/dune-workspace"
fi

echo "== [stdlib 2/3] build + install stdlib plugin .cmxs (dev profile) =="
# (source-dir : findlib-package-dir) — the _core / zify plugins live in a
# different source dir than their findlib package name.
MAP="ring/ring_plugin:ring \
 micromega/micromega_core_plugin:micromega_core micromega/micromega_plugin:micromega micromega/zify_plugin:zify \
 btauto/btauto_plugin:btauto rtauto/rtauto_plugin:rtauto \
 nsatz/nsatz_core_plugin:nsatz_core nsatz/nsatz_plugin:nsatz funind/funind_plugin:funind"
( cd "$SRCT" && for m in $MAP; do src="plugins/${m%%:*}.cmxs"; dune build --root . "$src" 2>/dev/null || true; done )
for m in $MAP; do
  src="$SRCT/_build/default/plugins/${m%%:*}.cmxs"; dst="$PLUG/${m##*:}"
  [ -f "$src" ] && { mkdir -p "$dst"; cp -f "$src" "$dst/$(basename ${m%%:*}).cmxs"; }
done

echo "== [stdlib 3/3] compile Stdlib .vo (patched rocqc, coqdep -sort order) =="
cd "$STDT"
FILES=$(find theories -name '*.v' ! -name 'All.v' | sort)
ORDER=$(rocq dep -sort -coqlib "$CORELIB" -R theories Stdlib $FILES 2>/dev/null)
n=0; fail=0
for f in $ORDER; do
  f="${f%\"}"; f="${f#\"}"; [ -z "$f" ] && continue
  vo="${f%.v}.vo"; [ -f "$vo" ] && { n=$((n+1)); continue; }
  if rocq compile -coqlib "$CORELIB" -R theories Stdlib "$f" >/tmp/sc.log 2>&1; then n=$((n+1)); else fail=$((fail+1)); echo "FAIL: $f  ($(grep -m1 -iE 'error|no such|read back' /tmp/sc.log | head -c 80))"; fi
done
echo "== stdlib: $n ok, $fail failed ($(find theories -name '*.vo' | wc -l) .vo). Now run: make site (build-real.sh stages the subset) =="
