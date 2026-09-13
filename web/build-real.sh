#!/usr/bin/env bash
# build-real.sh — build the REAL in-browser rocq-comparator engines (WebAssembly).
#
# Produces TWO wasm engines (no js_of_ocaml backend) under dist/, each the full
# rocq-comparator pipeline + a patched (Int64-backed, 31-bit-uint63) rocq-runtime
# kernel, compiled with wasm_of_ocaml, that ACTUALLY RUNS a Rocq check:
#   dist/engine-cps/   — --effects=cps : universal, runs on ALL browsers + any
#                        Node. Larger .wasm. The DEFAULT the worker loads.
#   dist/engine-jspi/  — --effects=jspi: JS Promise Integration; smaller/faster
#                        .wasm, only where JSPI exists (Node 24+, Chrome/Edge 137+).
# The worker (web/rocq_worker.js) feature-detects JSPI at load and fetches ONE.
#
# The one hard blocker (BACKEND.md 1c) is the kernel's Sys.word_size=64 assert:
# a natively-built rocq-runtime uses uint63_63 (type t = int, 63-bit) which is
# wrong on the wasm 32-bit int target. We rebuild ONLY the kernel bytecode
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

echo "== [1/6] patch + build kernel.cma (coerce-32bit) =="
mkdir -p "$WORK"
if [ ! -d "$WORK/rocq-src" ]; then
  cp -R "$SRC" "$WORK/rocq-src"
  echo "(lang dune 3.8)" > "$WORK/rocq-src/dune-workspace"
  # coerce-32bit: hard-wire the Int64-backed 31-bit implementations
  perl -0pi -e 's/\(deps \(:gen-file uint63_%\{ocaml-config:int_size\}\.ml\)\)/(deps (:gen-file uint63_31.ml))/' "$WORK/rocq-src/kernel/dune"
  perl -0pi -e 's/\(deps \(:gen-file float64_%\{ocaml-config:int_size\}\.ml\)\)/(deps (:gen-file float64_31.ml))/' "$WORK/rocq-src/kernel/dune"
  # the 31-bit impl asserts Sys.word_size=32; comment it (matches wasm, harmless)
  perl -0pi -e 's/^let _ = assert \(Sys\.word_size = 32\)/let _ = () (* coerce-32bit *)/m' "$WORK/rocq-src/kernel/uint63_31.ml"
  # coerce-32bit, marshalling half (BACKEND.md 11.5; wacoq/coq-lsp
  # coerce-32bit.patch ported to 9.2, see web/patches/coerce-32bit.reference.patch):
  #  * clib/hashset.ml: mask the generic hash combiners to 30 bits so cached
  #    hash fields fit a 31/32-bit target int (kernel/nativecode.ml opens
  #    Hashset.Combine, so this covers it too — no separate nativecode patch).
  #  * lib/system.ml + lib/objFile.ml: write marshalled data (incl. the .vo
  #    segments, whose writer moved to objFile.ml in 9.x) with Marshal.Compat_32,
  #    so the 31/32-bit unmarshaller can read it (else "input_value: integer too
  #    large"). The SAME patched kernel/lib/clib must sit under BOTH the wasm
  #    engine overlay AND the native rocqc that produced the .vo (build-native.sh).
  perl -0pi -e 's/    let combine x y     = x \* alpha \+ y\n/    let combine x y     = (x * alpha + y) land 0x3fffffff\n/' "$WORK/rocq-src/clib/hashset.ml"
  perl -0pi -e 's/    let combinesmall x y = beta \* x \+ y\n/    let combinesmall x y = (beta * x + y) land 0x3fffffff\n/' "$WORK/rocq-src/clib/hashset.ml"
  perl -0pi -e 's/let marshal_out ch v = Marshal\.to_channel ch v \[\]; flush ch/let marshal_out ch v = Marshal.to_channel ch v [Marshal.Compat_32]; flush ch/' "$WORK/rocq-src/lib/system.ml"
  perl -0pi -e 's/  let \(\) = Marshal\.to_channel ch v \[\] in/  let () = Marshal.to_channel ch v [Marshal.Compat_32] in/' "$WORK/rocq-src/lib/objFile.ml"
fi
# Three patched bytecode archives for the wasm overlay. uint63.mli / hashset.mli
# / system.mli / objFile.mli are all unchanged, so interface CRCs are preserved
# and every other installed rocq-runtime sub-archive links against them
# untouched (same trick as the kernel.cma-only overlay before).
# read-side patches for the wasm engine (idempotent; no effect on .vo or native)
perl "$HERE/web/patches/coerce-wasm-readside.pl" "$WORK/rocq-src"
( cd "$WORK/rocq-src" && dune build --root . --profile release kernel/kernel.cma lib/lib.cma clib/clib.cma )
PATCHED_KERNEL_CMA="$WORK/rocq-src/_build/default/kernel/kernel.cma"
PATCHED_LIB_CMA="$WORK/rocq-src/_build/default/lib/lib.cma"
PATCHED_CLIB_CMA="$WORK/rocq-src/_build/default/clib/clib.cma"

echo "== [2/6] build OCAMLPATH overlay with patched kernel.cma/lib.cma/clib.cma =="
OVERLAY="$WORK/overlay"
rm -rf "$OVERLAY"; mkdir -p "$OVERLAY"
cp -Rc "$SW/lib/rocq-runtime" "$OVERLAY/" 2>/dev/null || cp -R "$SW/lib/rocq-runtime" "$OVERLAY/"
cp -Rc "$SW/lib/stublibs"     "$OVERLAY/" 2>/dev/null || cp -R "$SW/lib/stublibs"     "$OVERLAY/"
cp -f "$PATCHED_KERNEL_CMA" "$OVERLAY/rocq-runtime/kernel/kernel.cma"
cp -f "$PATCHED_LIB_CMA"    "$OVERLAY/rocq-runtime/lib/lib.cma"
cp -f "$PATCHED_CLIB_CMA"   "$OVERLAY/rocq-runtime/clib/clib.cma"

export OCAMLPATH="$OVERLAY:$SW/lib"
echo "== [3/6] compile the seam (bytecode) against the overlay =="
( cd "$HERE" && dune build web/web_check.bc )

echo "== [4/6] wasm_of_ocaml -> dist/engine-cps + dist/engine-jspi =="
# wasm_of_ocaml resolves OCaml `external` C primitives from the WASM runtime only
# (a JS //Provides fragment becomes a throwing dummy), so the custom primitives
# the rocq-runtime references (float64, threads, VM init, getpid, and the ~30
# zarith ml_z_*) are supplied as WebAssembly in web/rocq_shims.wat. The zarith
# stubs delegate arbitrary-precision arithmetic to JS BigInt helpers
# (web/rocq_zarith.js) imported from the "js" module (= globalThis); the glue
# patch below wires them in.  The SAME web_check.bc is compiled twice, differing
# only in --effects (cps = universal / jspi = JSPI upgrade); the two engines are
# behaviourally identical, so the node test runs both.
mkdir -p "$HERE/dist"
for EFF in cps jspi; do
  ENGDIR="$HERE/dist/engine-$EFF"
  rm -rf "$ENGDIR"; mkdir -p "$ENGDIR"
  ( cd "$HERE" && wasm_of_ocaml compile --effects="$EFF" \
      web/rocq_shims.wat _build/default/web/web_check.bc \
      -o "$ENGDIR/rocq_engine.js" )
  # (a) Wire the JS BigInt zarith backend into the wasm "js" import module (bound
  #     to globalThis): the runtime binds "js" to a small object `ag`; augment it
  #     with globalThis.__rocqz (set by rocq_zarith.js, loaded first by the
  #     worker). This is the wasm equivalent of the removed js_of_ocaml //Provides.
  perl -0pi -e "s/js:ag,/js:Object.assign(ag,globalThis.__rocqz||{}),/" "$ENGDIR/rocq_engine.js"
  # (b) The glue fetches its module at `<src>/code-*.wasm`, resolved relative to
  #     the WORKER's URL (a worker has no `document.currentScript`). The engine
  #     lives in a subdir while the worker sits at dist root, so qualify the
  #     default `src` with the subdir; then the browser fetch lands in
  #     engine-$EFF/rocq_engine.assets/ and the node test resolves the same path
  #     (require.main-relative) via a symlinked subdir.
  perl -0pi -e "s{\"src\":\"rocq_engine.assets\"}{\"src\":\"engine-$EFF/rocq_engine.assets\"}" "$ENGDIR/rocq_engine.js"
done
# Shared, engine-independent glue at dist root, loaded by the worker BEFORE the
# engine: the byte-exact mount() conversion (rocq_bytes.js — fixes the browser
# Prelude.vo "Bytes.create" bug: never uses TextDecoder) and the JS BigInt zarith
# backend (rocq_zarith.js).
cp -f "$HERE/web/rocq_bytes.js"  "$HERE/dist/rocq_bytes.js"
cp -f "$HERE/web/rocq_zarith.js" "$HERE/dist/rocq_zarith.js"

echo "== [5/6] assemble dist/ (frontend + coqlib bundle) =="
for f in index.html app.js styles.css rocq_comparator.js rocq_worker.js; do
  [ -f "$HERE/web/$f" ] && cp -f "$HERE/web/$f" "$HERE/dist/" || true
  [ -f "$HERE/$f" ]     && cp -f "$HERE/$f"     "$HERE/dist/" || true
done
[ -d "$HERE/examples" ] && cp -R "$HERE/examples" "$HERE/dist/" || true
touch "$HERE/dist/.nojekyll"

# Stage the coqlib .vo bundle (Corelib prelude + Ltac2 + whatever else the
# native build produced) into dist/coqlib, alongside a stripped findlib META
# (archive/plugin lines removed so Rocq's findlib resolves the statically-linked
# plugins without Dynlink) and a manifest the worker fetches. Only if the native
# patched build (web/build-native.sh) has produced the .vo; otherwise the site
# still ships and runs -noinit.
NATIVE_COQLIB="$WORK/rocq-src/_build/install/default/lib/coq"
if [ -d "$NATIVE_COQLIB/theories" ]; then
  echo "== [5b/6] stage coqlib bundle from native build =="
  rm -rf "$HERE/dist/coqlib"; mkdir -p "$HERE/dist/coqlib"
  cp -RL "$NATIVE_COQLIB/theories"     "$HERE/dist/coqlib/theories"
  [ -d "$NATIVE_COQLIB/user-contrib" ] && cp -RL "$NATIVE_COQLIB/user-contrib" "$HERE/dist/coqlib/user-contrib" || true
  # Milestone 2: a Stdlib subset (Arith/PArith/NArith/ZArith/QArith/Numbers/
  # setoid_ring/micromega/Reals + their support dirs) regenerated by the patched
  # rocqc (web/.rocq-build/build-stdlib-manual.sh) under logical name Stdlib, at
  # user-contrib/Stdlib. Full Stdlib is ~41 MB / 583 .vo; this common subset
  # keeps the bundle web-sized while covering nat/Z/Q/R + ring/field/lia/lra.
  STDLIB_THEORIES="$WORK/stdlib-src/theories"
  STDLIB_SUBSET="Init Logic Bool Classes Setoids Relations Structures Wellfounded Program Lists BinNums Arith PArith NArith ZArith QArith Numbers setoid_ring micromega omega btauto nsatz Reals"
  if [ -d "$STDLIB_THEORIES/Reals" ]; then
    mkdir -p "$HERE/dist/coqlib/user-contrib/Stdlib"
    for d in $STDLIB_SUBSET; do
      [ -d "$STDLIB_THEORIES/$d" ] && cp -RL "$STDLIB_THEORIES/$d" "$HERE/dist/coqlib/user-contrib/Stdlib/$d" 2>/dev/null || true
    done
    # drop non-.vo build cruft that cp -RL may have pulled in
    find "$HERE/dist/coqlib/user-contrib/Stdlib" -type f ! -name '*.vo' -delete 2>/dev/null || true
  fi
  grep -vE '^[[:space:]]*(archive|plugin)\(' "$SW/lib/rocq-runtime/META" > "$HERE/dist/coqlib/rocq-runtime.META"
  ( cd "$HERE/dist/coqlib" && node -e '
    const fs=require("fs"),path=require("path");
    function walk(d){let r=[];for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.isDirectory())r=r.concat(walk(f));else if(e.name.endsWith(".vo"))r.push(path.relative(process.cwd(),f));}return r;}
    let vo=[]; for(const top of ["theories","user-contrib"]) if(fs.existsSync(top)) vo=vo.concat(walk(top));
    fs.writeFileSync("manifest.json",JSON.stringify({coqlib_vfs:"/static/coqlib",meta_vfs:"/static/lib/rocq-runtime/META",meta:"rocq-runtime.META",vo}));
    console.log("   manifest: "+vo.length+" .vo, bundle "+ (require("child_process").execSync("du -sh .").toString().split(/\s/)[0]));
  ' )
fi

echo "== [6/6] done: two wasm engines =="
for EFF in cps jspi; do
  ENGDIR="$HERE/dist/engine-$EFF"
  WASM=$(ls "$ENGDIR"/rocq_engine.assets/*.wasm 2>/dev/null | head -1)
  [ -n "$WASM" ] && echo "   engine-$EFF: glue $(wc -c < "$ENGDIR/rocq_engine.js") B + wasm $(wc -c < "$WASM") B (effects=$EFF)"
done
echo "   default engine = cps (universal); the worker upgrades to jspi where available."
