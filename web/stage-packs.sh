#!/usr/bin/env bash
# stage-packs.sh — assemble dist/coqlib as LAZY PACKS + packs.json, then PROVE the
# bundle is consistent by compiling a probe against it with the patched native rocqc.
#
# Expects dist/coqlib to already hold the Corelib prelude (theories/) and the
# Stdlib subset (user-contrib/Stdlib/), staged by build-real.sh from the native
# build. This script then:
#   1. copies the elpi/HB/mathcomp .vos from .rocq-build/mc-build (if built);
#   2. writes packs.json, the lazy-import manifest the worker fetches:
#        { "coqlib_vfs":"/static/coqlib",
#          "packs":[ {"name","always"?,"prefixes":[..],"requires":[..],
#                     "meta"?,"meta_vfs"?,"size","vo":[relpaths...]}, ... ] }
#      The worker (rocq_worker.js) scans the challenge+solution for Require /
#      From X Require, maps imported logical-name PREFIXES -> packs (longest
#      match, then module basename), closes over `requires`, and fetches+mounts
#      ONLY those (byte-exact, cached). `always` packs (Corelib) mount at startup.
#      A served .vos mounts at a .vo VFS path (its content IS opaque-stripped
#      vos-format; the .vo name sidesteps the .vos loadpath branch's Unix.stat,
#      absent for the wasm VFS).
#   3. compiles a probe with the native patched rocqc using dist/coqlib as
#      -coqlib. Every .vo/.vos records the digests of the libraries it was built
#      against; if Corelib, Stdlib and mathcomp were not all produced from the
#      SAME native build, Require fails here ("inconsistent assumptions") instead
#      of in a visitor's browser as challenge_error.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$HERE/.rocq-build}"; SW="${SWITCH:-/Users/gbaudart/Project/llm4rocq/rocq-comparator}/_opam"
ST="$WORK/mc-build"; CQ="$HERE/dist/coqlib"
SRCI="$WORK/rocq-src/_build/install/default"; OVERLAY="$WORK/overlay"
[ -d "$CQ/theories" ] || { echo "dist/coqlib/theories missing: run build-real.sh (make real) first"; exit 1; }

# ---- 1. elpi/HB/mathcomp .vos (built by build-mathcomp.sh), if present ----
if [ -f "$ST/HB/structures.vos" ]; then
  mkdir -p "$CQ/user-contrib/elpi/apps/locker" "$CQ/user-contrib/elpi_elpi" "$CQ/user-contrib/HB"
  cp "$ST/theories/elpi.vos"               "$CQ/user-contrib/elpi/elpi.vos"
  cp "$ST/elpi_elpi/dummy.vos"             "$CQ/user-contrib/elpi_elpi/dummy.vos"
  cp "$ST/apps/locker/theories/locker.vos" "$CQ/user-contrib/elpi/apps/locker/locker.vos"
  cp "$ST/HB/structures.vos"               "$CQ/user-contrib/HB/structures.vos"
  # stripped rocq-elpi META: findlib resolves the package names to the plugin
  # code already linked into the engine (no archive/plugin lines = no Dynlink)
  cat > "$CQ/rocq-elpi.META" <<'META'
package "elpi" ( directory = "elpi" )
package "coercion" ( directory = "coercion" )
package "cs" ( directory = "cs" )
package "tc" ( directory = "tc" )
META
  for pk in boot order finite_group ssreflect algebra; do
    [ -d "$ST/mathcomp/$pk" ] || continue
    n=$(find "$ST/mathcomp/$pk" -name '*.vos' | wc -l | tr -d ' ')
    nv=$(find "$ST/mathcomp/$pk" -name '*.v' | wc -l | tr -d ' ')
    # only ship a pack whose every .v compiled (a partial pack is a trap for Require)
    if [ "$n" != "$nv" ]; then echo "  skip mathcomp/$pk: $n/$nv .vos built"; continue; fi
    mkdir -p "$CQ/user-contrib/mathcomp/$pk"
    find "$ST/mathcomp/$pk" -name '*.vos' -exec cp {} "$CQ/user-contrib/mathcomp/$pk/" \;
  done
fi

# ---- 2. packs.json ----
cd "$CQ"
node -e '
const fs=require("fs"),path=require("path");
function vos(dir,ext){ if(!fs.existsSync(dir))return []; let r=[]; (function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name); if(e.isDirectory())w(f); else if(e.name.endsWith(ext))r.push(path.relative(process.cwd(),f));}})(dir); return r.sort(); }
function size(l){ return l.reduce((a,f)=>a+fs.statSync(f).size,0); }
const packs=[];
packs.push({name:"corelib", always:true, prefixes:["Corelib"], meta:"rocq-runtime.META", meta_vfs:"/static/lib/rocq-runtime/META", vo:vos("theories",".vo")});
if(fs.existsSync("user-contrib/Stdlib")) packs.push({name:"stdlib", prefixes:["Stdlib"], vo:vos("user-contrib/Stdlib",".vo")});
if(fs.existsSync("user-contrib/HB")){
  const hb=["user-contrib/elpi_elpi/dummy.vos","user-contrib/elpi/elpi.vos","user-contrib/elpi/apps/locker/locker.vos","user-contrib/HB/structures.vos"].filter(f=>fs.existsSync(f));
  packs.push({name:"mathcomp-hb", prefixes:["HB","elpi","elpi_elpi"], meta:"rocq-elpi.META", meta_vfs:"/static/lib/rocq-elpi/META", vo:hb});
  const mc=pk=>vos("user-contrib/mathcomp/"+pk,".vos");
  if(mc("boot").length)         packs.push({name:"mathcomp-boot", prefixes:["mathcomp.boot"], requires:["mathcomp-hb"], vo:mc("boot")});
  if(mc("order").length)        packs.push({name:"mathcomp-order", prefixes:["mathcomp.order"], requires:["mathcomp-hb","mathcomp-boot"], vo:mc("order")});
  if(mc("finite_group").length) packs.push({name:"mathcomp-fingroup", prefixes:["mathcomp.fingroup","mathcomp.finite_group"], requires:["mathcomp-hb","mathcomp-boot"], vo:mc("finite_group")});
  if(mc("ssreflect").length)    packs.push({name:"mathcomp-ssreflect", prefixes:["mathcomp.ssreflect"], requires:["mathcomp-hb","mathcomp-boot","mathcomp-order"], vo:mc("ssreflect")});
  if(mc("algebra").length)      packs.push({name:"mathcomp-algebra", prefixes:["mathcomp.algebra"], requires:["mathcomp-hb","mathcomp-boot","mathcomp-order"], vo:mc("algebra")});
}
packs.forEach(p=>p.size=size(p.vo));
fs.writeFileSync("packs.json", JSON.stringify({coqlib_vfs:"/static/coqlib", packs}));
packs.forEach(p=>console.log("  "+p.name+(p.always?"*":"")+": "+p.vo.length+" files, "+(p.size/1048576).toFixed(1)+" MB"));
'
rm -f "$CQ/manifest.json"

# ---- 3. native consistency probe against the staged bundle ----
ROCQ="$SRCI/bin/rocq"
[ -x "$ROCQ" ] || { echo "probe skipped: no patched native rocqc at $ROCQ"; exit 0; }
export PATH="$SRCI/bin:$SW/bin:/opt/homebrew/bin:$PATH"
export OCAMLPATH="$SRCI/lib:$OVERLAY:$SW/lib"
export CAML_LD_LIBRARY_PATH="$SW/lib/stublibs:$SW/lib/ocaml/stublibs"
export OPAM_SWITCH_PREFIX="$SW"
# with -coqlib pointing at dist/coqlib, rocq would look for plugins next to it
export ROCQRUNTIMELIB="$SRCI/lib/rocq-runtime"
PROBE="$WORK/probe"; rm -rf "$PROBE"; mkdir -p "$PROBE"
{
  echo 'From Stdlib Require Import ZArith Reals Lia Lra.'
  echo 'Lemma probe_stdlib (a b : Z) : (a + b)%Z = (b + a)%Z. Proof. lia. Qed.'
  echo 'Lemma probe_reals (x : R) : (x <= x + 1)%R. Proof. lra. Qed.'
  if [ -d "$CQ/user-contrib/mathcomp/ssreflect" ]; then
    echo 'From mathcomp Require Import all_ssreflect.'
    echo 'Lemma probe_ssr (s : seq nat) : size (rev s) = size s. Proof. by rewrite size_rev. Qed.'
  fi
  if [ -d "$CQ/user-contrib/mathcomp/finite_group" ]; then
    echo 'From mathcomp Require Import all_fingroup.'
    echo 'Lemma probe_fingroup (gT : finGroupType) (G : {group gT}) : 1%g \in G. Proof. exact: group1. Qed.'
  fi
  if [ -d "$CQ/user-contrib/mathcomp/algebra" ]; then
    echo 'From mathcomp Require Import all_algebra.'
  fi
} > "$PROBE/probe.v"
# -vok: check the probe fully, loading dependencies as .vos where shipped as such
if "$ROCQ" compile -vok -coqlib "$CQ" -w -deprecated -w -notation-incompatible-prefix "$PROBE/probe.v" > "$PROBE/probe.log" 2>&1; then
  echo "  probe OK: the staged bundle is self-consistent ($(grep -oE 'Require Import [^.]+' "$PROBE/probe.v" | sed 's/Require Import //' | tr '\n' ' '))"
else
  echo "  PROBE FAILED: dist/coqlib is inconsistent (Corelib, Stdlib and mathcomp must come from ONE native build):"
  grep -iE 'error|anomaly|inconsistent|cannot find' "$PROBE/probe.log" | head -5 | sed 's/^/    /'
  exit 1
fi
