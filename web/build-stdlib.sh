#!/usr/bin/env bash
# build-stdlib.sh: regenerate the FULL Stdlib .vo with the PATCHED native rocqc.
#
# Prereqs: web/build-native.sh has produced the patched native rocqc + Corelib
# in .rocq-build/rocq-src/_build. This script then:
#   1. copies the rocq-stdlib 9.2.0 sources to .rocq-build/stdlib-src (fresh
#      when the version marker differs);
#   2. builds the stdlib plugins' .cmxs (dev profile, to match the rocqc binary)
#      and installs each at its findlib PACKAGE dir, so the native rocqc can
#      Dynlink them while compiling stdlib .v that Declare ML Module;
#   3. compiles EVERY stdlib .v (a Makefile generated from `rocq dep`, so the
#      build is parallel and incremental) with the patched
#      `rocq compile -bytecode-compiler no -coqlib <patched Corelib> -R theories Stdlib`.
#
# Why -bytecode-compiler no: the patched rocqc represents primitive ints as
# Int64 on the OCaml side (coerce-32bit) while its C bytecode VM still uses
# native 63-bit ints, so VM evaluation of Uint63 constants disagrees with the
# kernel (Uint63.v "Cannot find witness", and every dependent: Sint63, Floats,
# PArray, PString, extraction/ExtrOCaml*). With the VM off, vm_compute falls
# back to compute and every file builds; the browser engine runs with vm=false
# anyway (no VM in wasm), and a VM-on and VM-off build of the other files give
# byte-identical .vo. deps.txt (the raw `rocq dep` output) is kept for
# stage-packs.sh, which derives the per-directory pack `requires` from it.
#
# Why not dune: dune's coq.theory build resolved the STOCK switch Corelib
# (unpatched, 63-bit hashes), so stdlib .vo failed Marshal.Compat_32
# ("integer cannot be read back on 32-bit platform"). Driving the patched rocqc
# directly against the patched Corelib gives 0 readback failures. The core opam
# switch is never touched. See BACKEND.md sections 13 and 17.
set -uo pipefail
SWITCH="${SWITCH:-/Users/gbaudart/Project/llm4rocq/rocq-comparator}"
SW="$SWITCH/_opam"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$HERE/.rocq-build}"
SRCT="$WORK/rocq-src"                                   # patched monorepo (build-native.sh)
STDT="$WORK/stdlib-src"
STDSRC="rocq-stdlib.9.2.0"
INSTBIN="$SRCT/_build/install/default/bin"
INSTLIB="$SRCT/_build/install/default/lib"
CORELIB="$INSTLIB/coq"
PLUG="$INSTLIB/rocq-runtime/plugins"
export PATH="$INSTBIN:$SW/bin:/opt/homebrew/bin:$PATH"
export OCAMLPATH="$INSTLIB:$SW/lib"
export CAML_LD_LIBRARY_PATH="$SW/lib/stublibs:$SW/lib/ocaml/stublibs"
export OPAM_SWITCH_PREFIX="$SW"

[ -x "$INSTBIN/rocq" ] || { echo "run web/build-native.sh first (no patched rocqc)"; exit 1; }

echo "== [stdlib 1/3] unpack stdlib source ($STDSRC) =="
if [ "$(cat "$STDT/SOURCE" 2>/dev/null)" != "$STDSRC" ]; then
  rm -rf "$STDT"; cp -R "$SW/.opam-switch/sources/$STDSRC" "$STDT"
  echo "$STDSRC" > "$STDT/SOURCE"
fi

echo "== [stdlib 2/3] build + install stdlib plugin .cmxs (dev profile) =="
# (source-dir : findlib-package-dir) the _core / zify plugins live in a
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

echo "== [stdlib 3/3] compile every Stdlib .vo (patched rocqc, VM off, parallel) =="
cd "$STDT"
mapfile -t FILES < <(find theories -name '*.v' ! -name 'All.v' | sort)
rocq dep -coqlib "$CORELIB" -R theories Stdlib "${FILES[@]}" > deps.txt 2>/dev/null
{ cat deps.txt
  printf '%%.vo: %%.v\n\t@%s && rm -f $@.log || { echo "  FAIL $< :: $$(grep -iE "error|anomaly|cannot" $@.log | head -1 | cut -c1-90)"; rm -f $@; false; }\n' \
    "rocq compile -bytecode-compiler no -coqlib $CORELIB -R theories Stdlib \$< > \$@.log 2>&1"
} > Makefile.vo
make -k -s -j8 -f Makefile.vo "${FILES[@]/%.v/.vo}" 2>&1 | grep -v '^make' || true
n=$(find theories -name '*.vo' | wc -l | tr -d ' ')
echo "== stdlib: $n of ${#FILES[@]} .vo built. Now run: make real (build-real.sh stages every Stdlib directory as a pack) =="
[ "$n" = "${#FILES[@]}" ]
