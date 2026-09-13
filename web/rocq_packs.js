// rocq_packs.js — lazy per-pack import: scan sources for Require, resolve packs.
//
// A PACK is a downloadable bundle of .vo(s) files sharing a logical-name prefix
// (e.g. "mathcomp.algebra"). packs.json (the manifest) lists every pack with its
// prefixes, byte size, contained .vo, findlib META (if any) and pack dependencies.
// Before a check we SCAN the challenge + solution .v sources for Require / From X
// Require, map the imported logical names to packs by longest-prefix, close over
// pack `requires`, and fetch+mount ONLY those packs (cached across checks). A pack
// the sources never import is never downloaded.
//
// This module is the single source of truth for scan+resolve, loaded by BOTH the
// browser worker (rocq_worker.js) and the node test (test/judge_test.cjs), so both
// exercise the same lazy-import logic. It is pure (no fetch/fs): the caller does I/O.
(function (root, factory) {
  var api = factory();
  root.RocqPacks = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // Extract the logical library names a Rocq source imports. Handles:
  //   Require [Import|Export] A.B C.               -> ["A.B","C"]
  //   From X Require [Import|Export] Y Z.          -> ["X.Y","X.Z"]
  // Comments are stripped first. Conservative: over-matching only means a pack is
  // fetched that a check could have skipped, never a missing pack.
  function scanRequires(sources) {
    var names = {};
    (sources || []).forEach(function (src) {
      if (typeof src !== "string") return;
      // strip (* ... *) comments (non-nested is fine for import lines)
      var s = src.replace(/\(\*[\s\S]*?\*\)/g, " ");
      // A Require statement ends at a "." that is followed by whitespace or EOF
      // (qualified-name dots are always followed by an identifier char, so they
      // are not confused with the terminator). Capture the module list up to it.
      var re = /(?:From\s+([\w.]+)\s+)?Require\s+((?:Import|Export)\s+)?([\s\S]*?)\.(?=\s|$)/g;
      var m;
      while ((m = re.exec(s)) !== null) {
        var from = m[1];
        m[3].split(/\s+/).forEach(function (mod) {
          if (!mod) return;
          if (mod === "Import" || mod === "Export") return;      // stray keyword
          mod = mod.replace(/\.+$/, "");                          // defensive
          if (!/^[A-Za-z_][\w.]*$/.test(mod)) return;            // skip non-idents
          names[from ? from + "." + mod : mod] = true;
        });
      }
    });
    return Object.keys(names);
  }

  // Map imported logical names -> pack names by LONGEST matching prefix, then close
  // over each pack's `requires`. `alwaysOn` packs (the prelude) are implicit and not
  // returned here (the worker mounts them once at startup).
  function resolvePacks(manifest, logicalNames) {
    var packs = manifest.packs || [];
    var byName = {};
    packs.forEach(function (p) { byName[p.name] = p; });
    var need = {};
    function addPack(name) {
      if (need[name] || !byName[name]) return;
      need[name] = true;
      (byName[name].requires || []).forEach(addPack);
    }
    // module basename -> packs (from each pack's vo list), for From-suffix imports
    // like `From mathcomp Require Import all_ssreflect` (logical name arrives as
    // "mathcomp.all_ssreflect", not the real "mathcomp.ssreflect.all_ssreflect").
    var byModule = {};
    packs.forEach(function (p) {
      if (p.always) return;
      (p.vo || []).forEach(function (rel) {
        var base = rel.replace(/^.*\//, "").replace(/\.(vos?|vok)$/, "");
        (byModule[base] = byModule[base] || []).push(p.name);
      });
    });
    // a basename shipped by several packs (ssreflect: Stdlib.ssr and mathcomp.boot)
    // resolves to the one whose prefix shares the import's root, else the first
    function byBase(lname) {
      var cands = byModule[lname.replace(/^.*\./, "")] || [];
      var rootOf = lname.replace(/\..*$/, "") + ".";
      for (var i = 0; i < cands.length; i++) {
        var pre = byName[cands[i]].prefixes || [];
        for (var j = 0; j < pre.length; j++) if (pre[j] === rootOf.slice(0, -1) || pre[j].indexOf(rootOf) === 0) return cands[i];
      }
      return cands[0] || null;
    }
    (logicalNames || []).forEach(function (lname) {
      // (a) longest matching prefix wins (so "mathcomp.algebra" beats "mathcomp")
      var best = null, bestLen = -1;
      packs.forEach(function (p) {
        if (p.always) return;
        (p.prefixes || []).forEach(function (pre) {
          if ((lname === pre || lname.indexOf(pre + ".") === 0) && pre.length > bestLen) {
            best = p.name; bestLen = pre.length;
          }
        });
      });
      // (b) else resolve by the last component as a module basename
      if (!best) best = byBase(lname);
      if (best) addPack(best);
    });
    // return in manifest order (dependencies naturally precede dependents if the
    // manifest lists base packs first; the mounter is order-independent anyway).
    return packs.filter(function (p) { return need[p.name]; }).map(function (p) { return p.name; });
  }

  return { scanRequires: scanRequires, resolvePacks: resolvePacks };
});
