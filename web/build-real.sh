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
  # coerce-32bit, marshalling half (BACKEND.md 11.5; wacoq/coq-lsp
  # coerce-32bit.patch ported to 9.2, see web/patches/coerce-32bit.reference.patch):
  #  * clib/hashset.ml: mask the generic hash combiners to 30 bits so cached
  #    hash fields fit a 31/32-bit target int (kernel/nativecode.ml opens
  #    Hashset.Combine, so this covers it too — no separate nativecode patch).
  #  * lib/system.ml + lib/objFile.ml: write marshalled data (incl. the .vo
  #    segments, whose writer moved to objFile.ml in 9.x) with Marshal.Compat_32,
  #    so the 31/32-bit unmarshaller can read it (else "input_value: integer too
  #    large"). The SAME patched kernel/lib/clib must sit under BOTH the jsoo
  #    engine overlay AND the native rocqc that produced the .vo (build-native.sh).
  perl -0pi -e 's/    let combine x y     = x \* alpha \+ y\n/    let combine x y     = (x * alpha + y) land 0x3fffffff\n/' "$WORK/rocq-src/clib/hashset.ml"
  perl -0pi -e 's/    let combinesmall x y = beta \* x \+ y\n/    let combinesmall x y = (beta * x + y) land 0x3fffffff\n/' "$WORK/rocq-src/clib/hashset.ml"
  perl -0pi -e 's/let marshal_out ch v = Marshal\.to_channel ch v \[\]; flush ch/let marshal_out ch v = Marshal.to_channel ch v [Marshal.Compat_32]; flush ch/' "$WORK/rocq-src/lib/system.ml"
  perl -0pi -e 's/  let \(\) = Marshal\.to_channel ch v \[\] in/  let () = Marshal.to_channel ch v [Marshal.Compat_32] in/' "$WORK/rocq-src/lib/objFile.ml"
fi
# Three patched bytecode archives for the jsoo overlay. uint63.mli / hashset.mli
# / system.mli / objFile.mli are all unchanged, so interface CRCs are preserved
# and every other installed rocq-runtime sub-archive links against them
# untouched (same trick as the kernel.cma-only overlay before).
( cd "$WORK/rocq-src" && dune build --root . --profile release kernel/kernel.cma lib/lib.cma clib/clib.cma )
PATCHED_KERNEL_CMA="$WORK/rocq-src/_build/default/kernel/kernel.cma"
PATCHED_LIB_CMA="$WORK/rocq-src/_build/default/lib/lib.cma"
PATCHED_CLIB_CMA="$WORK/rocq-src/_build/default/clib/clib.cma"

echo "== [2/5] build OCAMLPATH overlay with patched kernel.cma/lib.cma/clib.cma =="
OVERLAY="$WORK/overlay"
rm -rf "$OVERLAY"; mkdir -p "$OVERLAY"
cp -Rc "$SW/lib/rocq-runtime" "$OVERLAY/" 2>/dev/null || cp -R "$SW/lib/rocq-runtime" "$OVERLAY/"
cp -Rc "$SW/lib/stublibs"     "$OVERLAY/" 2>/dev/null || cp -R "$SW/lib/stublibs"     "$OVERLAY/"
cp -f "$PATCHED_KERNEL_CMA" "$OVERLAY/rocq-runtime/kernel/kernel.cma"
cp -f "$PATCHED_LIB_CMA"    "$OVERLAY/rocq-runtime/lib/lib.cma"
cp -f "$PATCHED_CLIB_CMA"   "$OVERLAY/rocq-runtime/clib/clib.cma"

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

# Stage the coqlib .vo bundle (Corelib prelude + Ltac2 + whatever else the
# native build produced) into dist/coqlib, alongside a stripped findlib META
# (archive/plugin lines removed so Rocq's findlib resolves the statically-linked
# plugins without Dynlink) and a manifest the worker fetches. Only if the native
# patched build (web/build-native.sh) has produced the .vo; otherwise the site
# still ships and runs -noinit.
NATIVE_COQLIB="$WORK/rocq-src/_build/install/default/lib/coq"
if [ -d "$NATIVE_COQLIB/theories" ]; then
  echo "== [4b/5] stage coqlib bundle from native build =="
  rm -rf "$HERE/dist/coqlib"; mkdir -p "$HERE/dist/coqlib"
  cp -RL "$NATIVE_COQLIB/theories"     "$HERE/dist/coqlib/theories"
  [ -d "$NATIVE_COQLIB/user-contrib" ] && cp -RL "$NATIVE_COQLIB/user-contrib" "$HERE/dist/coqlib/user-contrib" || true
  grep -vE '^[[:space:]]*(archive|plugin)\(' "$SW/lib/rocq-runtime/META" > "$HERE/dist/coqlib/rocq-runtime.META"
  ( cd "$HERE/dist/coqlib" && node -e '
    const fs=require("fs"),path=require("path");
    function walk(d){let r=[];for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name);if(e.isDirectory())r=r.concat(walk(f));else if(e.name.endsWith(".vo"))r.push(path.relative(process.cwd(),f));}return r;}
    let vo=[]; for(const top of ["theories","user-contrib"]) if(fs.existsSync(top)) vo=vo.concat(walk(top));
    fs.writeFileSync("manifest.json",JSON.stringify({coqlib_vfs:"/static/coqlib",meta_vfs:"/static/lib/rocq-runtime/META",meta:"rocq-runtime.META",vo}));
    console.log("   manifest: "+vo.length+" .vo, bundle "+ (require("child_process").execSync("du -sh .").toString().split(/\s/)[0]));
  ' )
fi

echo "== [5/5] done: dist/rocq_engine.js ($(wc -c < "$HERE/dist/rocq_engine.js") bytes) =="
