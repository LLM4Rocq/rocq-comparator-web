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
#   2. build patched rocq-elpi plugin -> overlay/rocq-elpi
#   3. compile elpi_elpi/elpi/locker/HB + the mathcomp packs to .vos
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
HBSRC="$SW/.opam-switch/sources/rocq-hierarchy-builder.1.10.3"
MC="$SW/lib/coq/user-contrib/mathcomp"
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

echo "== [mc 3/5] stage sources (elpi theory + HB + mathcomp .v) =="
rm -rf "$ST"; mkdir -p "$ST/theories" "$ST/elpi_elpi" "$ST/apps/locker"
cp -R "$RE/elpi"/* "$ST/elpi_elpi/" 2>/dev/null || true
[ -f "$ST/elpi_elpi/dummy.v" ] || echo "(* dummy *)" > "$ST/elpi_elpi/dummy.v"
rocq_elpi_optcomp "9.2" "$RE/theories/elpi.v.in" > "$ST/theories/elpi.v"
cp -R "$RE/apps/locker/theories" "$ST/apps/locker/theories"; cp -R "$RE/apps/locker/elpi" "$ST/apps/locker/elpi"
cp -R "$HBSRC/HB" "$ST/HB"
mkdir -p "$ST/mathcomp"
for pk in boot order finite_group ssreflect; do  # algebra needs micromega_plugin .vos (documented slot)
  [ -d "$MC/$pk" ] || continue
  cp -R "$MC/$pk" "$ST/mathcomp/$pk"; find "$ST/mathcomp/$pk" -type f ! -name '*.v' ! -name '*.elpi' -delete
done

echo "== [mc 4/5] compile .vos (patched rocqc) =="
cd "$ST"
LP=(-Q elpi_elpi elpi_elpi -R theories elpi -Q apps/locker/theories elpi.apps.locker -Q apps/locker/elpi elpi.apps.locker.elpi -Q HB HB -R mathcomp mathcomp)
WARN=(-w -elpi.accumulate-syntax -w -elpi.typecheck-syntax -w -elpi.flex-clause -w -deprecated -w -notation-for-abbreviation -w -elpi.typecheck -w -deprecated-since-9.2 -w -notation-incompatible-prefix)
C(){ $ROCQ compile -vos -coqlib "$CORELIB" "${LP[@]}" "${WARN[@]}" "$1" >/tmp/mcvc.log 2>&1 || { echo "  FAIL $1 :: $(grep -iE 'error|anomaly|output_value|cannot' /tmp/mcvc.log|head -1|cut -c1-100)"; exit 1; }; }
C elpi_elpi/dummy.v; C theories/elpi.v; C apps/locker/theories/locker.v; C HB/structures.v
mapfile -t ALLV < <(find mathcomp -name '*.v' | sort)
ORDER=$(rocq dep -sort -coqlib "$CORELIB" "${LP[@]}" "${ALLV[@]}" 2>/dev/null | tr ' ' '\n' | sed 's/"//g')
for f in $ORDER; do [ -z "$f" ] && continue; [ -f "${f%.v}.vos" ] && continue
  $ROCQ compile -vos -coqlib "$CORELIB" "${LP[@]}" "${WARN[@]}" "$f" >/tmp/mcvc.log 2>&1 || echo "  FAIL $f :: $(grep -iE 'error|anomaly|cannot' /tmp/mcvc.log|head -1|cut -c1-90)"
done
echo "  boot=$(ls mathcomp/boot/*.vos 2>/dev/null|wc -l) order=$(ls mathcomp/order/*.vos 2>/dev/null|wc -l) finite_group=$(ls mathcomp/finite_group/*.vos 2>/dev/null|wc -l) ssreflect=$(ls mathcomp/ssreflect/*.vos 2>/dev/null|wc -l)"

echo "== [mc 5/5] stage packs into dist/coqlib (+ native consistency probe) =="
if [ -d "$HERE/dist/coqlib/theories" ]; then bash "$HERE/web/stage-packs.sh"
else echo "   dist/coqlib not staged yet: 'make real' will stage these packs (and link the patched elpi)"; fi
echo "== build-mathcomp done =="
