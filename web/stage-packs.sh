#!/usr/bin/env bash
# stage-packs.sh — assemble dist/coqlib as LAZY PACKS + packs.json (the manifest).
#
# Additive: expects dist/coqlib to already hold the Corelib prelude (theories/)
# and the Stdlib subset (user-contrib/Stdlib/) staged by build-real.sh; this adds
# the elpi/HB + mathcomp .vos and writes packs.json describing every pack.
#
# packs.json (the lazy-import manifest):
#   { "coqlib_vfs":"/static/coqlib",
#     "packs":[ {"name","always"?,"prefixes":[..],"requires":[..],
#                "meta"?,"meta_vfs"?,"size","vo":[relpaths...]}, ... ] }
# The worker (rocq_worker.js) scans the challenge+solution for Require / From X
# Require, maps imported logical-name PREFIXES -> packs (longest match, then module
# basename), closes over `requires`, and fetches+mounts ONLY those (byte-exact,
# cached). `always` packs (Corelib) mount at startup. A served .vos mounts at a .vo
# VFS path (its content IS opaque-stripped vos-format; the .vo name sidesteps the
# .vos loadpath branch's Unix.stat, absent for the wasm VFS).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$HERE/.rocq-build}"; SW="${SWITCH:-/Users/gbaudart/Project/llm4rocq/rocq-comparator}/_opam"
ST="$WORK/mc-build"; CQ="$HERE/dist/coqlib"
[ -d "$CQ/theories" ] || { echo "dist/coqlib/theories missing — run build-real.sh (or make site) first"; exit 1; }

# (mathcomp/elpi/HB .vos are copied into dist by web/build-mathcomp.sh; this
# script only builds packs.json from whatever is present under dist/coqlib.)

# ---- write packs.json ----
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
