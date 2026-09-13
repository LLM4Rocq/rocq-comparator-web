#!/usr/bin/env bash
# build-libs.sh: build the Coquelicot and Equations lazy packs as .vos with the
# patched native rocqc, after build-stdlib.sh and build-mathcomp.sh (Coquelicot
# Requires Stdlib.ssr and mathcomp.boot). Idempotent: a .vos already built is kept.
#
# Policy: no library patches. Only libraries whose released opam version builds
# unmodified on Rocq 9.2 + the installed mathcomp ship here (Interval 4.11.4 does
# not; it waits for a release that does).
#
# Every .vos is compiled with -bytecode-compiler no, the engine's vm=false flag
# (core-src/config.ml): the patched rocqc's C VM disagrees with its Int64-backed
# uint63, and the browser has no VM anyway (see web/build-stdlib.sh).
#
# Equations needs its OCaml plugin (rocq-equations.plugin, pure OCaml, no C
# stubs). The engine links it statically (web/dune); the native rocqc that
# compiles the .vos Dynlinks a .cmxs rebuilt against the patched runtime, so both
# are installed in the overlay build-real.sh preserves (.rocq-build/overlay).
set -euo pipefail
SWITCH="${SWITCH:-/Users/gbaudart/Project/llm4rocq/rocq-comparator}"
SW="$SWITCH/_opam"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$HERE/.rocq-build}"
SRCI="$WORK/rocq-src/_build/install/default"
OVERLAY="$WORK/overlay"; LB="$WORK/libs-build"
CORELIB="$SRCI/lib/coq"; ROCQ="$SRCI/bin/rocq"
STD="$WORK/stdlib-src/theories"; MC="$WORK/mc-build"
EQSRC="$SW/.opam-switch/sources/rocq-equations.1.3.2+9.2"
CQSRC="$SW/.opam-switch/sources/coq-coquelicot.3.4.5"
export PATH="$SRCI/bin:$SW/bin:/opt/homebrew/bin:$PATH"
export OCAMLPATH="$SRCI/lib:$OVERLAY:$SW/lib"
export ROCQRUNTIMELIB="$SRCI/lib/rocq-runtime"
export CAML_LD_LIBRARY_PATH="$SW/lib/stublibs:$SW/lib/ocaml/stublibs"
export OPAM_SWITCH_PREFIX="$SW"
[ -x "$ROCQ" ] || { echo "run web/build-real.sh first (no patched rocqc)"; exit 1; }
[ -f "$STD/ssr/ssreflect.vo" ] || { echo "run web/build-stdlib.sh first (Coquelicot needs Stdlib.ssr)"; exit 1; }
[ -f "$MC/mathcomp/boot/seq.vos" ] || { echo "run web/build-mathcomp.sh first (Coquelicot needs mathcomp.boot)"; exit 1; }
mkdir -p "$LB"

echo "== [libs 1/4] Equations plugin, ABI-matched to the patched rocqc (.cmxs + .cma) =="
EQ="$LB/equations-src"
if [ ! -d "$EQ" ]; then cp -R "$EQSRC" "$EQ"; echo "(lang dune 3.13)" > "$EQ/dune-workspace"; fi
( cd "$EQ" && dune build --root . --profile release src/equations_plugin.cmxs src/equations_plugin.cma >/dev/null 2>&1 )
rm -rf "$OVERLAY/rocq-equations"; cp -R "$SW/lib/rocq-equations" "$OVERLAY/rocq-equations"
cp -f "$EQ/_build/default/src/equations_plugin.cmxs" "$EQ/_build/default/src/equations_plugin.cma" "$OVERLAY/rocq-equations/plugin/"

echo "== [libs 2/4] stage sources =="
mkdir -p "$LB/src"
[ -d "$LB/src/Coquelicot" ] || cp -R "$CQSRC/theories" "$LB/src/Coquelicot"
[ -d "$LB/src/Equations" ]  || cp -R "$SW/lib/coq/user-contrib/Equations" "$LB/src/Equations"
find "$LB/src" -type f ! -name '*.v' ! -name '*.vos' -delete

echo "== [libs 3/4] compile .vos (patched rocqc, VM off, rocq dep -sort order) =="
LIBS=(Coquelicot Equations)
cd "$LB/src"; : > deps.txt
for L in "${LIBS[@]}"; do
  # the library being compiled is bound with -R (its files Require each other
  # unqualified), every other one with -Q (fully qualified names only)
  LP=(-R "$STD" Stdlib -R "$MC/mathcomp" mathcomp -Q "$MC/HB" HB -R "$MC/theories" elpi -Q "$MC/elpi_elpi" elpi_elpi
      -Q "$MC/apps/locker/theories" elpi.apps.locker -Q "$MC/apps/locker/elpi" elpi.apps.locker.elpi
      -R "$MC/apps/derive/theories" elpi.apps.derive -Q "$MC/apps/derive/elpi" elpi.apps.derive.elpi
      -Q "$MC/micromega_plugin" micromega_plugin)
  for l in "${LIBS[@]}"; do if [ "$l" = "$L" ]; then LP+=(-R "$LB/src/$l" "$l"); else LP+=(-Q "$LB/src/$l" "$l"); fi; done
  mapfile -t FILES < <(find "$L" -name '*.v' | sort)
  rocq dep -coqlib "$CORELIB" "${LP[@]}" "${FILES[@]}" >> deps.txt 2>/dev/null   # stage-packs.sh: pack `requires`
  ok=0; fail=0
  for f in $(rocq dep -sort -coqlib "$CORELIB" "${LP[@]}" "${FILES[@]}" 2>/dev/null | tr -d '"' | tr ' ' '\n' | grep "^$L/"); do
    [ -f "${f%.v}.vos" ] && { ok=$((ok+1)); continue; }
    if $ROCQ compile -vos -bytecode-compiler no -w -all -coqlib "$CORELIB" "${LP[@]}" "$f" > "$f.log" 2>&1; then ok=$((ok+1)); rm -f "$f.log"
    else fail=$((fail+1)); rm -f "${f%.v}.vos"; echo "  FAIL $f :: $(grep -m1 -E 'Error' "$f.log" | cut -c1-120)"; fi
  done
  echo "  $L: $ok ok, $fail failed of ${#FILES[@]}"
done

echo "== [libs 4/4] stage packs into dist/coqlib (+ native consistency probe) =="
if [ -d "$HERE/dist/coqlib/theories" ]; then bash "$HERE/web/stage-packs.sh"
else echo "   dist/coqlib not staged yet: 'make real' will stage these packs"; fi
echo "== build-libs done =="
