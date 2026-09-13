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
  rm -rf "$CQ/user-contrib/elpi" "$CQ/user-contrib/elpi_elpi" "$CQ/user-contrib/HB"
  mkdir -p "$CQ/user-contrib/elpi/apps" "$CQ/user-contrib/elpi_elpi" "$CQ/user-contrib/HB"
  cp "$ST/theories/elpi.vos"   "$CQ/user-contrib/elpi/elpi.vos"
  cp "$ST/elpi_elpi/dummy.vos" "$CQ/user-contrib/elpi_elpi/dummy.vos"
  cp "$ST/HB/structures.vos"   "$CQ/user-contrib/HB/structures.vos"
  for app in "$ST"/apps/*/; do app=$(basename "$app")   # locker, derive: elpi.apps.<app>.*
    ( cd "$ST/apps/$app/theories" && find . -name '*.vos' | while read -r f; do mkdir -p "$CQ/user-contrib/elpi/apps/$app/${f%/*}"; cp "$f" "$CQ/user-contrib/elpi/apps/$app/$f"; done )
  done
  # stripped rocq-elpi META: findlib resolves the package names to the plugin
  # code already linked into the engine (no archive/plugin lines = no Dynlink)
  cat > "$CQ/rocq-elpi.META" <<'META'
package "elpi" ( directory = "elpi" )
package "coercion" ( directory = "coercion" )
package "cs" ( directory = "cs" )
package "tc" ( directory = "tc" )
META
  # stripped rocq-micromega-plugin META (mathcomp algebra's ring/lia backend; the
  # plugin + zify libraries are linked into the engine, see web/dune)
  cat > "$CQ/rocq-micromega-plugin.META" <<'META'
package "plugin" ( directory = "plugin" requires = "rocq-runtime.plugins.ltac rocq-runtime.vernac" )
package "zify" ( directory = "zify" requires = "rocq-runtime.plugins.ltac" )
META
  rm -rf "$CQ/user-contrib/micromega_plugin" "$CQ/user-contrib/mathcomp"
  for d in "$ST"/micromega_plugin "$ST"/mathcomp/*/; do d=${d%/}; d=${d#"$ST"/}
    [ -d "$ST/$d" ] || continue
    n=$(find "$ST/$d" -name '*.vos' | wc -l | tr -d ' ')
    nv=$(find "$ST/$d" -name '*.v' | wc -l | tr -d ' ')
    # only ship a pack whose every .v compiled (a partial pack is a trap for Require)
    if [ "$n" != "$nv" ]; then echo "  skip $d: $n/$nv .vos built"; continue; fi
    ( cd "$ST" && find "$d" -name '*.vos' | while read -r f; do mkdir -p "$CQ/user-contrib/${f%/*}"; cp "$f" "$CQ/user-contrib/$f"; done )
  done
  cp -f "$ST/deps.txt" "$CQ/deps.txt" 2>/dev/null || true
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
  const hb=vos("user-contrib/elpi_elpi",".vos").concat(vos("user-contrib/elpi",".vos").filter(f=>!f.includes("/apps/derive/")),vos("user-contrib/HB",".vos"));
  packs.push({name:"mathcomp-hb", prefixes:["HB","elpi","elpi_elpi"], meta:"rocq-elpi.META", meta_vfs:"/static/lib/rocq-elpi/META", vo:hb});
  // elpi.apps.derive is only needed by the algebra tactics and weighs 20 MB: its own pack
  if(fs.existsSync("user-contrib/elpi/apps/derive")) packs.push({name:"elpi-derive", prefixes:["elpi.apps.derive"], requires:["mathcomp-hb","mathcomp-boot"], vo:vos("user-contrib/elpi/apps/derive",".vos")});
  // pack `requires` come from the real dependencies: deps.txt is `rocq dep` over the
  // staged sources (build-mathcomp.sh); a source path maps to the pack that ships it.
  const key=p=>{ p=p.replace(/^"|"$/g,""); if(/stdlib-src\/theories\//.test(p))return "stdlib";
    if(/^micromega_plugin\//.test(p))return "micromega-plugin"; if(/^apps\/derive\//.test(p))return "elpi-derive"; if(/^(HB|theories|apps|elpi_elpi)\//.test(p))return "mathcomp-hb";
    const m=/^mathcomp\/([^/]+)\//.exec(p); return m?(m[1]==="finite_group"?"mathcomp-fingroup":"mathcomp-"+m[1]):null; };
  const deps={};
  if(fs.existsSync("deps.txt")) for(const line of fs.readFileSync("deps.txt","utf8").split("\n")){
    const i=line.indexOf(": "); if(i<0)continue;
    const from=key(line.slice(0,i).split(/\s+/)[0]); if(!from)continue;
    for(const t of line.slice(i+2).split(/\s+/)){ if(!/\.vos?$/.test(t))continue; const k=key(t); if(k&&k!==from)(deps[from]=deps[from]||new Set()).add(k); }
  }
  const mc=(name,dir,prefixes,extra)=>{ const vo=vos(dir,".vos"); if(!vo.length)return;
    packs.push(Object.assign({name,prefixes,requires:[...(deps[name]||[])].sort()},extra,{vo})); };
  mc("micromega-plugin","user-contrib/micromega_plugin",["micromega_plugin"],{meta:"rocq-micromega-plugin.META",meta_vfs:"/static/lib/rocq-micromega-plugin/META"});
  const dirs=fs.existsSync("user-contrib/mathcomp")?fs.readdirSync("user-contrib/mathcomp"):[];
  // dependency order (base packs first) so the manifest reads top-down
  const order=[]; const visit=d=>{ if(order.includes(d))return; const n=key("mathcomp/"+d+"/x"); for(const r of deps[n]||[]) for(const e of dirs) if(key("mathcomp/"+e+"/x")===r)visit(e); order.push(d); };
  dirs.sort().forEach(visit);
  for(const d of order) mc(key("mathcomp/"+d+"/x"),"user-contrib/mathcomp/"+d,["mathcomp."+d].concat(d==="finite_group"?["mathcomp.fingroup"]:[]),{});
  // a pack whose requirement is not shipped cannot be loaded: drop it
  for(let dropped=true;dropped;){ dropped=false; for(let i=packs.length-1;i>=0;i--){ const miss=(packs[i].requires||[]).filter(r=>!packs.some(p=>p.name===r)); if(miss.length){console.log("  drop "+packs[i].name+": needs unshipped "+miss.join(",")); packs.splice(i,1); dropped=true;} } }
}
packs.forEach(p=>p.size=size(p.vo));
// user-facing metadata for the Libraries strip of the page: support packs are
// internal; every other pack gets an example import line (its all_* module if
// it has one, else its own module), taken from the files it ships.
for(const p of packs){
  if(["mathcomp-hb","elpi-derive","micromega-plugin"].includes(p.name)){ p.internal=true; continue; }
  if(p.always) continue;
  if(p.name==="stdlib"){ p.import="From Stdlib Require Import ZArith."; continue; }
  const mods=p.vo.map(f=>path.basename(f).replace(/\.vos?$/,""));
  const all=mods.find(m=>/^all_/.test(m)), dir=p.name.replace(/^mathcomp-/,"");
  const own=mods.find(m=>m===dir);
  if(p.name==="mathcomp-analysis") p.import="From mathcomp Require Import all_ssreflect all_algebra all_reals all_analysis.";
  else if(all||own) p.import="From mathcomp Require Import "+(all||own)+".";
}
// the strip shows only the entry points; the rest are reached through them
for(const p of packs) if(["stdlib","mathcomp-ssreflect","mathcomp-algebra","mathcomp-analysis","coquelicot","interval","equations"].includes(p.name)) p.featured=true;
fs.writeFileSync("packs.json", JSON.stringify({coqlib_vfs:"/static/coqlib", packs}));
packs.forEach(p=>console.log("  "+p.name+(p.always?"*":"")+": "+p.vo.length+" files, "+(p.size/1048576).toFixed(1)+" MB"));
'
rm -f "$CQ/manifest.json" "$CQ/deps.txt"

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
    echo 'From mathcomp Require Import all_algebra ring.'
    echo 'Local Open Scope ring_scope.'
    echo 'Lemma probe_algebra (R : comRingType) (a b : R) : (a + b) * (a - b) = a * a - b * b. Proof. by ring. Qed.'
  fi
  if [ -d "$CQ/user-contrib/mathcomp/analysis" ]; then
    echo 'From mathcomp Require Import all_reals all_analysis.'
    echo 'Import Order.Theory.'
    echo 'Lemma probe_analysis (R : realType) (x : R) : x <= x. Proof. exact: lexx. Qed.'
    echo 'Lemma probe_expR (R : realType) : expR 0 = 1 :> R. Proof. exact: expR0. Qed.'
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
