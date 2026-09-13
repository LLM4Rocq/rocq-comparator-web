#!/usr/bin/env bash
# build-mathcomp.sh — Phase 2: build the mathcomp (+ elpi/HB) library packs as
# 32-bit-safe .vos with the patched native rocqc, and stage them as lazy packs.
#
# WHY .vos: a .vos is a library INTERFACE — constant types + transparent
# definitions, with opaque (Qed) proof terms stripped. Loading it type-checks a
# solution AGAINST the library without its proof terms, i.e. TRUSTS the library.
# That is already the browser trust model (rocqchk is off in-browser, so even .vo
# are trusted there), so .vos changes nothing about soundness and is smaller.
#
# THE ONE REAL PORT (analogous to the kernel's 30-bit hash masking, BACKEND §12.1):
# elpi's clause index hashes with `hash_bits = Sys.int_size - 1` = 62 on the
# 64-bit build host, so the serialized index reaches 2^62-1 — which Marshal.Compat_32
# refuses and the 31-bit wasm reader cannot read. We patch elpi to `hash_bits = 30`
# (the value a 32-bit host uses) so compile-time and wasm-runtime hashes agree and
# fit. See .rocq-build/elpi-src/src/runtime/runtime{,_trace_off}.ml.
#
# Prereqs: web/build-real.sh has built the coerce-32bit overlay + patched native
# rocqc (.rocq-build/rocq-src, rocq-runtime.install + rocq-core.install). This
# script then, all against the SAME patched rocqc/Corelib (no core switch touched):
#   1. build patched elpi lib (hash_bits=30) -> overlay/elpi
#   2. build patched rocq-elpi plugin -> overlay/rocq-elpi, and the patched
#      rocq-micromega-plugin (mathcomp algebra's ring/lia backend) -> overlay
#   3. compile elpi_elpi/elpi/locker/derive/HB + micromega_plugin + EVERY
#      installed mathcomp/* dir (boot .. analysis) to .vos
#   4. stage dist/coqlib packs + packs.json (the lazy-import manifest)
set -euo pipefail
SWITCH="${SWITCH:-/Users/gbaudart/Project/llm4rocq/rocq-comparator}"
SW="$SWITCH/_opam"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$HERE/.rocq-build}"
SRC="$WORK/rocq-src"; SRCI="$SRC/_build/install/default"
OVERLAY="$WORK/overlay"; ST="$WORK/mc-build"
CORELIB="$SRCI/lib/coq"; ROCQ="$SRCI/bin/rocq"
ELSRC="$SW/.opam-switch/sources/elpi.3.7.3"
RESRC="$SW/.opam-switch/sources/rocq-elpi.3.5.1"
MMSRC="$SW/.opam-switch/sources/rocq-micromega-plugin.1.1.1"
HBSRC="$SW/.opam-switch/sources/rocq-hierarchy-builder.1.10.3"
MC="$SW/lib/coq/user-contrib/mathcomp"
MP="$SW/lib/coq/user-contrib/micromega_plugin"
export PATH="$SRCI/bin:$SW/bin:/opt/homebrew/bin:$PATH"
export CAML_LD_LIBRARY_PATH="$SW/lib/stublibs:$SW/lib/ocaml/stublibs"
export OPAM_SWITCH_PREFIX="$SW"

[ -x "$ROCQ" ] || { echo "run web/build-real.sh first (no patched rocqc)"; exit 1; }

echo "== [mc 1/5] patched elpi lib (hash_bits=30) =="
EL="$WORK/elpi-src"
if [ ! -d "$EL" ]; then
  cp -R "$ELSRC" "$EL"; echo "(lang dune 3.13)" > "$EL/dune-workspace"
  # hash_bits: 62 on the 64-bit host -> serialized elpi index hits 2^62-1, which
  # Marshal.Compat_32 refuses and the 31-bit reader cannot read. Force 30 (the
  # 32-bit-host value) so compile-time and wasm-runtime hashes agree and fit.
  for f in runtime.ml runtime_trace_off.ml; do
    perl -0pi -e 's/let hash_bits = Sys\.int_size - 1 \(\* the sign \*\)/let hash_bits = 30 (* coerce-32bit: host-independent 30-bit serialized index *)/' "$EL/src/runtime/$f"
    perl -0pi -e 's/  let all_1 size = max_int lsr \(hash_bits - size\) in/  let all_1 size = (1 lsl size) - 1 in (* coerce-32bit *)/' "$EL/src/runtime/$f"
  done
  # the MaximizeForFunctional indexing depth is max_int too (2^62-1); 2^30-1 is
  # "index fully" for any real program and fits 31 bits.
  perl -0pi -e 's/-> max_int \| _ -> 0\) modes/-> (1 lsl 30) - 1 | _ -> 0) modes/' "$EL/src/compiler/type_checker.ml"
  # elpi digests a runtime-built program with Marshal.to_string [Closures]; the AST
  # holds CData whose type-descriptor carries closures, and marshalling a closure
  # needs the bytecode section table (--toplevel) which wasm lacks. Native keeps the
  # Marshal path; add a closure-free show-based fallback for the wasm engine.
  perl -0pi -e 's/\Qlet digest = Digest.string (Marshal.to_string ast [Marshal.Closures]) in\E/let digest = Digest.string (Program.show_decl_list ast) in/' "$EL/src/API.ml"
fi
( cd "$EL" && OCAMLPATH="$SW/lib" dune build --root . --profile release @install >/dev/null )
rm -rf "$OVERLAY/elpi"; cp -RL "$EL/_build/install/default/lib/elpi" "$OVERLAY/elpi"
mkdir -p "$WORK/bin"; for b in elpi elpi-trace-elaborator; do cp -f "$EL/_build/install/default/bin/$b" "$WORK/bin/$b" 2>/dev/null || cp -f "$SW/bin/$b" "$WORK/bin/$b"; done

echo "== [mc 2/5] patched rocq-elpi plugin (ABI-matched to patched rocqc) =="
RE="$WORK/rocq-elpi-src"
if [ ! -d "$RE" ]; then
  cp -R "$RESRC" "$RE"; echo "(lang dune 3.13)" > "$RE/dune-workspace"
  # the codegen rules embed local .elpi files; drop the (package elpi) dep so the
  # build does not require elpi's binaries under the overlay's findlib layout.
  perl -0pi -e 's/\(deps ([^\n]*?) \(package elpi\)\)/(deps $1)/g' "$RE/src/dune"
fi
export OCAMLPATH="$SRCI/lib:$OVERLAY:$SW/lib"     # patched runtime FIRST (native ABI), then patched elpi
( cd "$RE" && dune build --root . --profile release \
    src/elpi_plugin.cmxs apps/coercion/src/elpi_coercion_plugin.cmxs \
    apps/cs/src/elpi_cs_plugin.cmxs apps/tc/src/elpi_tc_plugin.cmxs >/dev/null 2>&1 )
rm -rf "$OVERLAY/rocq-elpi"; cp -R "$SW/lib/rocq-elpi" "$OVERLAY/rocq-elpi"
for p in "elpi/elpi_plugin:src/elpi_plugin" "coercion/elpi_coercion_plugin:apps/coercion/src/elpi_coercion_plugin" \
         "cs/elpi_cs_plugin:apps/cs/src/elpi_cs_plugin" "tc/elpi_tc_plugin:apps/tc/src/elpi_tc_plugin"; do
  cp -f "$RE/_build/default/${p##*:}.cmxs" "$OVERLAY/rocq-elpi/${p%%:*}.cmxs"
done

echo "== [mc 2b/5] patched rocq-micromega-plugin (ABI-matched to patched rocqc) =="
# mathcomp algebra's ring/field/lia tactics use the standalone micromega plugin
# (user-contrib/micromega_plugin, package rocq-micromega-plugin), not the
# rocq-runtime one; its .cmxs must match the patched native rocqc like rocq-elpi.
MM="$WORK/micromega-src"
if [ ! -d "$MM" ]; then cp -R "$MMSRC" "$MM"; echo "(lang dune 3.13)" > "$MM/dune-workspace"; fi
( cd "$MM" && dune build --root . --profile release src/micromega_ml_plugin.cmxs src/zify_ml_plugin.cmxs >/dev/null 2>&1 )
rm -rf "$OVERLAY/rocq-micromega-plugin"; cp -R "$SW/lib/rocq-micromega-plugin" "$OVERLAY/rocq-micromega-plugin"
cp -f "$MM/_build/default/src/micromega_ml_plugin.cmxs" "$OVERLAY/rocq-micromega-plugin/plugin/"
cp -f "$MM/_build/default/src/zify_ml_plugin.cmxs"      "$OVERLAY/rocq-micromega-plugin/zify/"

echo "== [mc 3/5] stage sources (elpi theory + HB + micromega_plugin + mathcomp .v) =="
rm -rf "$ST"; mkdir -p "$ST/theories" "$ST/elpi_elpi" "$ST/apps/locker"
cp -R "$RE/elpi"/* "$ST/elpi_elpi/" 2>/dev/null || true
[ -f "$ST/elpi_elpi/dummy.v" ] || echo "(* dummy *)" > "$ST/elpi_elpi/dummy.v"
rocq_elpi_optcomp "9.2" "$RE/theories/elpi.v.in" > "$ST/theories/elpi.v"
for app in locker derive; do  # derive: mathcomp algebra's ring/field tactics use elpi.apps.derive (std, param2)
  mkdir -p "$ST/apps/$app"; cp -R "$RE/apps/$app/theories" "$ST/apps/$app/theories"; cp -R "$RE/apps/$app/elpi" "$ST/apps/$app/elpi"
done
cp -R "$HBSRC/HB" "$ST/HB"
# every installed mathcomp/* dir (boot, order, finite_group, ssreflect, algebra,
# solvable, field, finmap, bigenough, classical, reals, analysis, ...)
cp -R "$MP" "$ST/micromega_plugin"; cp -R "$MC" "$ST/mathcomp"
find "$ST/micromega_plugin" "$ST/mathcomp" -type f ! -name '*.v' -delete
# the .elpi files algebra's tactics accumulate at compile time are not installed: take them from the source tree
for f in "$SW"/.opam-switch/sources/rocq-mathcomp-algebra.*/*/*.elpi; do
  rel="${f#*/sources/rocq-mathcomp-algebra.*/}"; [ -d "$ST/mathcomp/${rel%/*}" ] && cp -f "$f" "$ST/mathcomp/$rel"
done

echo "== [mc 4/5] compile .vos (patched rocqc) =="
cd "$ST"
LP=(-Q elpi_elpi elpi_elpi -R theories elpi -Q apps/locker/theories elpi.apps.locker -Q apps/locker/elpi elpi.apps.locker.elpi
    -R apps/derive/theories elpi.apps.derive -Q apps/derive/elpi elpi.apps.derive.elpi -Q HB HB
    -Q micromega_plugin micromega_plugin -R mathcomp mathcomp)   # no Stdlib: nothing here needs it
WARN=(-w -elpi.accumulate-syntax -w -elpi.typecheck-syntax -w -elpi.flex-clause -w -deprecated -w -notation-for-abbreviation -w -elpi.typecheck -w -deprecated-since-9.2 -w -notation-incompatible-prefix -w -unsupported-attributes)
C(){ $ROCQ compile -vos -coqlib "$CORELIB" "${LP[@]}" "${WARN[@]}" "$1" >/tmp/mcvc.log 2>&1 || { echo "  FAIL $1 :: $(grep -iE 'error|anomaly|output_value|cannot' /tmp/mcvc.log|head -1|cut -c1-100)"; exit 1; }; }
C elpi_elpi/dummy.v; C theories/elpi.v; C apps/locker/theories/locker.v; C HB/structures.v
mapfile -t ALLV < <(find apps/derive/theories micromega_plugin mathcomp -name '*.v' | sort)
# deps.txt: the raw `rocq dep` output (Makefile rules for .vo); stage-packs.sh derives
# each pack's `requires` from it, and here it becomes a Makefile of .vos rules so
# every .v compiles in parallel, in dependency order (a failure is reported and
# leaves no .vos; the pack is then not shipped).
rocq dep -coqlib "$CORELIB" "${LP[@]}" "${ALLV[@]}" > deps.txt 2>/dev/null
{ perl -pe 's/^(\S+)\.vo \S+ \S+ \S+: /$1.vos: /; s{ (?!\/)(\S+)\.vo(?=\s|$)}{ $1.vos}g' deps.txt
  printf '%%.vos: %%.v\n\t@%s && rm -f $@.log || { echo "  FAIL $< :: $$(grep -iE "error|anomaly|cannot" $@.log | head -1 | cut -c1-90)"; rm -f $@; false; }\n' \
    "$ROCQ compile -vos -coqlib $CORELIB ${LP[*]} ${WARN[*]} \$< > \$@.log 2>&1"
} > Makefile.vos
make -k -s -j8 -f Makefile.vos "${ALLV[@]/%.v/.vos}" 2>&1 | grep -v '^make' || true
for d in apps/derive/theories micromega_plugin mathcomp/*/; do d=${d%/}; echo "  $d: $(find "$d" -name '*.vos'|wc -l|tr -d ' ')/$(find "$d" -name '*.v'|wc -l|tr -d ' ') .vos"; done

echo "== [mc 5/5] stage packs into dist/coqlib (+ native consistency probe) =="
if [ -d "$HERE/dist/coqlib/theories" ]; then bash "$HERE/web/stage-packs.sh"
else echo "   dist/coqlib not staged yet: 'make real' will stage these packs (and link the patched elpi)"; fi
echo "== build-mathcomp done =="
