#!/usr/bin/env bash
# stage-packs.sh — assemble dist/coqlib as LAZY PACKS + packs.json, then PROVE the
# bundle is consistent by compiling a probe against it with the patched native rocqc.
#
# Expects dist/coqlib to already hold the Corelib prelude (theories/) and the
# full Stdlib (user-contrib/Stdlib/), staged by build-real.sh from the native
# build. This script then:
#   1. copies the elpi/HB/mathcomp .vos from .rocq-build/mc-build and the
#      Coquelicot/Equations .vos from .rocq-build/libs-build (if built);
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
#      absent for the wasm VFS). Stdlib is split into one pack per top-level
#      directory (Stdlib.ZArith, Stdlib.Reals, ...); every pack's `requires` is
#      derived from the `rocq dep` output the builds leave behind (deps.txt).
#   3. compiles a probe with the native patched rocqc using dist/coqlib as
#      -coqlib. Every .vo/.vos records the digests of the libraries it was built
#      against; if Corelib, Stdlib and mathcomp were not all produced from the
#      SAME native build, Require fails here ("inconsistent assumptions") instead
#      of in a visitor's browser as challenge_error.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$HERE/.rocq-build}"; SW="${SWITCH:-/Users/gbaudart/Project/llm4rocq/rocq-comparator}/_opam"
ST="$WORK/mc-build"; LB="$WORK/libs-build"; CQ="$HERE/dist/coqlib"
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
fi

# ---- 1b. Coquelicot / Equations .vos (built by web/build-libs.sh), if present ----
for L in Coquelicot Equations; do
  rm -rf "$CQ/user-contrib/$L"; [ -d "$LB/src/$L" ] || continue
  n=$(find "$LB/src/$L" -name '*.vos' | wc -l | tr -d ' '); nv=$(find "$LB/src/$L" -name '*.v' | wc -l | tr -d ' ')
  if [ "$n" != "$nv" ]; then echo "  skip $L: $n/$nv .vos built"; continue; fi
  ( cd "$LB/src" && find "$L" -name '*.vos' | while read -r f; do mkdir -p "$CQ/user-contrib/${f%/*}"; cp "$f" "$CQ/user-contrib/$f"; done )
done
# stripped rocq-equations META (the plugin is linked into the engine, see web/dune)
cat > "$CQ/rocq-equations.META" <<'META'
package "plugin" ( directory = "plugin" requires = "rocq-runtime.plugins.cc rocq-runtime.plugins.extraction" )
META

# every pack's `requires` comes from the real dependencies: the raw `rocq dep`
# output of each build (mathcomp, Stdlib, libs); Stdlib's relative paths get a
# Stdlib/ root so they cannot be confused with the elpi theory's theories/ dir
{ cat "$ST/deps.txt" 2>/dev/null
  perl -pe 's{(^|\s)theories/}{$1Stdlib/}g' "$WORK/stdlib-src/deps.txt" 2>/dev/null
  cat "$LB/src/deps.txt" 2>/dev/null; } > "$CQ/deps.txt"

# ---- 2. packs.json ----
cd "$CQ"
node -e '
const fs=require("fs"),path=require("path");
function vos(dir,ext){ if(!fs.existsSync(dir))return []; let r=[]; (function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=path.join(d,e.name); if(e.isDirectory())w(f); else if(e.name.endsWith(ext))r.push(path.relative(process.cwd(),f));}})(dir); return r.sort(); }
function size(l){ return l.reduce((a,f)=>a+fs.statSync(f).size,0); }
// a dependency path (relative to its build dir, or absolute) -> the pack that ships it
const key=p=>{ p=p.replace(/^"|"$/g,"").replace(/^.*\/mc-build\//,"").replace(/^.*\/stdlib-src\/theories\//,"Stdlib/").replace(/^.*\/libs-build\/src\//,"");
  let m; if((m=/^Stdlib\/([^/]+)\//.exec(p)))return "stdlib-"+m[1]; if(/^Stdlib\/[^/]+$/.test(p))return "stdlib";
  if((m=/^(Coquelicot|Equations)\//.exec(p)))return m[1].toLowerCase();
  if(/^micromega_plugin\//.test(p))return "micromega-plugin"; if(/^apps\/derive\//.test(p))return "elpi-derive"; if(/^(HB|theories|apps|elpi_elpi)\//.test(p))return "mathcomp-hb";
  m=/^mathcomp\/([^/]+)\//.exec(p); return m?(m[1]==="finite_group"?"mathcomp-fingroup":"mathcomp-"+m[1]):null; };
const deps={};
for(const line of fs.readFileSync("deps.txt","utf8").split("\n")){
  const i=line.indexOf(": "); if(i<0)continue;
  const from=key(line.slice(0,i).split(/\s+/)[0]); if(!from)continue;
  for(const t of line.slice(i+2).split(/\s+/)){ if(!/\.vos?$/.test(t))continue; const k=key(t); if(k&&k!==from)(deps[from]=deps[from]||new Set()).add(k); }
}
const packs=[];
const add=(name,dir,prefixes,extra,ext)=>{ const vo=vos(dir,ext||".vos"); if(!vo.length)return;
  packs.push(Object.assign({name,prefixes,requires:[...(deps[name]||[])].sort()},extra,{vo})); };
packs.push({name:"corelib", always:true, prefixes:["Corelib"], meta:"rocq-runtime.META", meta_vfs:"/static/lib/rocq-runtime/META", vo:vos("theories",".vo")});
// Stdlib: one pack per top-level directory (Stdlib.<Dir>); root-level files, if any, form the stdlib pack
if(fs.existsSync("user-contrib/Stdlib")){
  const ents=fs.readdirSync("user-contrib/Stdlib",{withFileTypes:true});
  const root=ents.filter(e=>e.isFile()&&e.name.endsWith(".vo")).map(e=>"user-contrib/Stdlib/"+e.name).sort();
  if(root.length) packs.push({name:"stdlib",prefixes:["Stdlib"],requires:[...(deps.stdlib||[])].sort(),vo:root});
  for(const e of ents) if(e.isDirectory()) add("stdlib-"+e.name,"user-contrib/Stdlib/"+e.name,["Stdlib."+e.name],{},".vo");
}
if(fs.existsSync("user-contrib/HB")){
  const hb=vos("user-contrib/elpi_elpi",".vos").concat(vos("user-contrib/elpi",".vos").filter(f=>!f.includes("/apps/derive/")),vos("user-contrib/HB",".vos"));
  packs.push({name:"mathcomp-hb", prefixes:["HB","elpi","elpi_elpi"], meta:"rocq-elpi.META", meta_vfs:"/static/lib/rocq-elpi/META", vo:hb});
  // elpi.apps.derive is only needed by the algebra tactics and weighs 20 MB: its own pack
  if(fs.existsSync("user-contrib/elpi/apps/derive")) packs.push({name:"elpi-derive", prefixes:["elpi.apps.derive"], requires:["mathcomp-hb","mathcomp-boot"], vo:vos("user-contrib/elpi/apps/derive",".vos")});
  add("micromega-plugin","user-contrib/micromega_plugin",["micromega_plugin"],{meta:"rocq-micromega-plugin.META",meta_vfs:"/static/lib/rocq-micromega-plugin/META"});
  const dirs=fs.existsSync("user-contrib/mathcomp")?fs.readdirSync("user-contrib/mathcomp").sort():[];
  for(const d of dirs) add(key("mathcomp/"+d+"/x"),"user-contrib/mathcomp/"+d,["mathcomp."+d].concat(d==="finite_group"?["mathcomp.fingroup"]:[]),{});
}
add("coquelicot","user-contrib/Coquelicot",["Coquelicot"],{});
add("equations","user-contrib/Equations",["Equations"],{meta:"rocq-equations.META",meta_vfs:"/static/lib/rocq-equations/META"});
// a pack whose requirement is not shipped cannot be loaded: drop it
for(let dropped=true;dropped;){ dropped=false; for(let i=packs.length-1;i>=0;i--){ const miss=(packs[i].requires||[]).filter(r=>!packs.some(p=>p.name===r)); if(miss.length){console.log("  drop "+packs[i].name+": needs unshipped "+miss.join(",")); packs.splice(i,1); dropped=true;} } }
// dependency order (base packs first) so the manifest reads top-down
const order=[], seen=new Set(); const visit=p=>{ if(seen.has(p))return; seen.add(p); for(const r of p.requires||[]) visit(packs.find(q=>q.name===r)); order.push(p); };
packs.forEach(visit); packs.length=0; packs.push(...order);
packs.forEach(p=>p.size=size(p.vo));
// user-facing metadata for the Libraries strip of the page: support packs are
// internal; every other pack gets an example import line (its all_* module if
// it has one, else its own module), taken from the files it ships.
const imports={"stdlib-ZArith":"From Stdlib Require Import ZArith.", coquelicot:"From Coquelicot Require Import Coquelicot.", equations:"From Equations Require Import Equations.",
  "mathcomp-analysis":"From mathcomp Require Import all_ssreflect all_algebra all_reals all_analysis."};
const labels={"stdlib-ZArith":"Stdlib", coquelicot:"Coquelicot", equations:"Equations"};
for(const p of packs){
  if(["mathcomp-hb","elpi-derive","micromega-plugin"].includes(p.name)){ p.internal=true; continue; }
  if(p.always) continue;
  if(imports[p.name]){ p.import=imports[p.name]; if(labels[p.name])p.label=labels[p.name]; continue; }
  const mods=p.vo.map(f=>path.basename(f).replace(/\.vos?$/,""));
  const all=mods.find(m=>/^all_/.test(m)), dir=p.name.replace(/^mathcomp-/,"");
  const own=mods.find(m=>m===dir);
  if(/^mathcomp-/.test(p.name)&&(all||own)) p.import="From mathcomp Require Import "+(all||own)+".";
}
// the strip shows only the entry points; the rest are reached through them
for(const p of packs) if(["stdlib-ZArith","mathcomp-ssreflect","mathcomp-algebra","mathcomp-analysis","coquelicot","equations"].includes(p.name)) p.featured=true;
fs.writeFileSync("packs.json", JSON.stringify({coqlib_vfs:"/static/coqlib", packs}));
const std=packs.filter(p=>/^stdlib/.test(p.name));
console.log("  Stdlib: "+std.length+" packs, "+std.reduce((a,p)=>a+p.vo.length,0)+" files, "+(std.reduce((a,p)=>a+p.size,0)/1048576).toFixed(1)+" MB");
packs.filter(p=>!/^stdlib/.test(p.name)).forEach(p=>console.log("  "+p.name+(p.always?"*":"")+": "+p.vo.length+" files, "+(p.size/1048576).toFixed(1)+" MB"));
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
  if [ -d "$CQ/user-contrib/Equations" ]; then   # before mathcomp: ssrnat's addn would block simpl
    echo 'From Equations Require Import Equations.'
    echo 'Equations probe_len {A} (l : list A) : nat := probe_len nil := 0; probe_len (cons _ l) := S (probe_len l).'
    echo 'Lemma probe_equations {A} (l1 l2 : list A) : probe_len (l1 ++ l2) = probe_len l1 + probe_len l2.'
    echo 'Proof. funelim (probe_len l1); simpl; simp probe_len; f_equal; auto. Qed.'
  fi
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
  if [ -d "$CQ/user-contrib/Coquelicot" ]; then
    echo 'From Coquelicot Require Import Coquelicot.'
    echo 'Lemma probe_coquelicot : is_lim_seq (fun n => INR n) p_infty. Proof. apply is_lim_seq_INR. Qed.'
  fi
} > "$PROBE/probe.v"
# -vok: check the probe fully, loading dependencies as .vos where shipped as such;
# -bytecode-compiler no: the engine's setting, and the one every .vo/.vos here
# was built with (the patched rocqc's VM disagrees with its Int64 uint63)
if "$ROCQ" compile -vok -bytecode-compiler no -coqlib "$CQ" -w -deprecated -w -notation-incompatible-prefix "$PROBE/probe.v" > "$PROBE/probe.log" 2>&1; then
  echo "  probe OK: the staged bundle is self-consistent ($(grep -oE 'Require Import [^.]+' "$PROBE/probe.v" | sed 's/Require Import //' | tr '\n' ' '))"
else
  echo "  PROBE FAILED: dist/coqlib is inconsistent (Corelib, Stdlib, mathcomp and the libraries must come from ONE native build):"
  grep -iE 'error|anomaly|inconsistent|cannot find' "$PROBE/probe.log" | head -5 | sed 's/^/    /'
  exit 1
fi
