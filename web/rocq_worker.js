// rocq_worker.js — the Web Worker that hosts the OCaml Rocq engine.
//
// It loads ONE wasm engine (the wasm_of_ocaml build of web_check.ml), which
// installs `RocqComparator` on the worker global, then serves checks.
//
// PHASE 2 — lazy per-pack import. The prelude/stdlib/mathcomp libraries are
// published as separate downloadable PACKS (see coqlib/packs.json). Only the
// `always` packs (the Corelib prelude) are mounted at startup. Before each check
// the worker SCANS the challenge + solution sources for Require / From X Require,
// resolves which packs are needed by logical-name prefix (rocq_packs.js), and
// FETCHES + MOUNTS only those (byte-exact; cached across checks so each pack is
// downloaded once). A pack the sources never import is never downloaded.
//
// Every asset (.vo/.vos, META) is fetched as an ArrayBuffer and converted to the
// byte-exact string mount() consumes via rocq_bytes.js — NEVER TextDecoder, whose
// browser "latin1" is windows-1252 and corrupts .vo bytes 0x80-0x9F (the Prelude.vo
// "Bytes.create" anomaly). The node test feeds bytes through the SAME conversion.

self.window = self; // web_check installs on the global; make `window` an alias

// ---- pick the engine variant: jspi where the browser has JSPI, else cps ------
// Both need WebAssembly GC, tail calls and exception handling; the main thread
// (rocq_comparator.js) checks that before spawning this worker.
function jspiAvailable() {
  try { return typeof WebAssembly !== "undefined" && typeof WebAssembly.Suspending === "function"; }
  catch (e) { return false; }
}
// ?engine=cps|jspi on the worker URL (rocq_comparator.js forwards it from the
// page URL, and sends ?engine=cps itself after the jspi engine failed to start)
// forces one variant: used by test/browser_smoke.cjs to exercise the cps engine
// on a JSPI browser, and handy for trying it by hand.
var FORCED_ENGINE = (function () {
  try { return (new URL(self.location.href).searchParams.get("engine") || "").toLowerCase(); } catch (e) { return ""; }
})();
var ENGINE_DIR = (FORCED_ENGINE === "cps" || FORCED_ENGINE === "jspi")
  ? "engine-" + FORCED_ENGINE
  : (jspiAvailable() ? "engine-jspi" : "engine-cps");

// Every fatal names the engine, so the main thread can fall back from jspi to cps.
function fatal(err) {
  self.postMessage({ type: 'fatal', engine: ENGINE_DIR, error: (err && err.message) || String(err) });
}

// The engine glue instantiates its module in an async function nobody awaits,
// so a failure there (a CompileError, a LinkError, an out-of-memory RangeError)
// is an unhandled rejection or an error event in this worker and nothing else.
// Until the engine is installed, record it: awaitEngine turns it into the
// fatal, with the browser's own text, instead of waiting for its deadline.
var engine = null;
var startupError = null;
self.addEventListener('unhandledrejection', function (ev) { if (!engine) startupError = ev.reason || 'unhandled rejection'; });
self.addEventListener('error', function (ev) { if (!engine) { startupError = ev.error || ev.message || 'error'; ev.preventDefault(); } });

// rocq_bytes.js: the ONE byte-exact conversion mount() consumes (shared with the
// node test). rocq_packs.js: the shared scan+resolve for lazy packs. rocq_zarith.js
// installs globalThis.__rocqz before the engine glue instantiates.
try {
  importScripts('rocq_bytes.js', 'rocq_packs.js', 'rocq_zarith.js', ENGINE_DIR + '/rocq_engine.js');
} catch (e) {
  fatal(new Error('failed to load the engine (' + ENGINE_DIR + '): ' + (e && e.message || e)));
  throw e;
}

function awaitEngine(timeoutMs) {
  return new Promise(function (resolve, reject) {
    var t0 = Date.now();
    (function poll() {
      if (self.RocqComparator && typeof self.RocqComparator.check === 'function') return resolve(self.RocqComparator);
      if (startupError) return reject(new Error('the engine (' + ENGINE_DIR + ') failed to start: ' + ((startupError && startupError.message) || String(startupError))));
      if (Date.now() - t0 > timeoutMs) return reject(new Error('the engine (' + ENGINE_DIR + ') did not start within ' + Math.round(timeoutMs / 1000) + ' s'));
      setTimeout(poll, 20);
    })();
  });
}

// Fetch one binary asset as the byte-exact string mount() consumes (no TextDecoder).
async function fetchBinaryString(url) {
  var resp = await fetch(url);
  if (!resp.ok) throw new Error('fetch ' + url + ' -> ' + resp.status);
  var buf = await resp.arrayBuffer();
  return RocqBytes.bytesToBinaryString(new Uint8Array(buf));
}

// ---- pack manifest + lazy mounting ------------------------------------------
var manifest = null;          // packs.json (the lazy-import manifest)
var mountedPacks = {};        // pack name -> true (cache: each pack mounted once)

// Mount one pack: its findlib META (if any) then every .vo/.vos, byte-exact. A
// served .vos file is mounted at a .vo VFS path — the file IS opaque-stripped
// (vos-format, the trust), but wasm_of_ocaml's Unix.stat does not cover the
// in-memory VFS that the loadpath's .vos branch stats, so we present it as a .vo
// (select_vo_file then loads it with no stat). Corelib .vo are mounted as-is.
async function mountPack(pack, onFile) {
  if (mountedPacks[pack.name]) return 0;
  var base = 'coqlib/';
  if (pack.meta) {
    try { engine.mount(pack.meta_vfs, await fetchBinaryString(base + pack.meta)); } catch (e) {}
  }
  var vo = pack.vo || [];
  var vfs = manifest.coqlib_vfs || '/static/coqlib';
  await Promise.all(vo.map(async function (rel) {
    var content = await fetchBinaryString(base + rel);
    var vfsPath = vfs + '/' + rel.replace(/\.vos$/, '.vo');
    engine.mount(vfsPath, content);
    if (onFile) onFile(content.length);
  }));
  mountedPacks[pack.name] = true;
  return vo.length;
}

// Predeclare every pack's DIRECTORIES (a 0-byte .keep per dir) so Rocq's recursive
// coqlib loadpath — built ONCE at the first check's Driver.init — binds every
// pack's logical name up front. The .vo themselves (the downloads) stay lazy:
// select_vo_file re-checks file existence per Require, so a .vo mounted later into
// an already-bound dir resolves. Markers are generated from packs.json, no fetch.
function predeclareDirs() {
  if (!manifest || !manifest.packs) return;
  var vfs = manifest.coqlib_vfs || '/static/coqlib';
  var dirs = {};
  manifest.packs.forEach(function (p) {
    (p.vo || []).forEach(function (rel) {
      var vfsPath = vfs + '/' + rel.replace(/\.vos$/, '.vo');
      var d = vfsPath.slice(0, vfsPath.lastIndexOf('/'));
      dirs[d] = true;
    });
  });
  Object.keys(dirs).forEach(function (d) { try { engine.mount(d + '/.keep', ''); } catch (e) {} });
}

function packByName(name) {
  return (manifest.packs || []).filter(function (p) { return p.name === name; })[0];
}

// Ensure the packs needed by these sources are mounted (fetch+mount the missing
// ones; cached). Returns the list of pack names newly fetched. [progress], if
// given, receives {stage:'download', pack, packsDone, packsTotal, bytes,
// bytesTotal} as files arrive (bytesTotal from the manifest's pack sizes).
async function ensurePacks(sources, progress) {
  if (!manifest || !manifest.packs) return [];
  var names = RocqPacks.resolvePacks(manifest, RocqPacks.scanRequires(sources));
  var todo = names.map(packByName).filter(function (p) { return p && !mountedPacks[p.name]; });
  var bytesTotal = todo.reduce(function (a, p) { return a + (p.size || 0); }, 0);
  var bytes = 0;
  var report = function (i, name) {
    if (progress) progress({ stage: 'download', pack: name, packsDone: i, packsTotal: todo.length, bytes: bytes, bytesTotal: bytesTotal });
  };
  for (var i = 0; i < todo.length; i++) {
    report(i, todo[i].name);
    await mountPack(todo[i], function (n) { bytes += n; report(i, todo[i].name); });
  }
  if (todo.length) report(todo.length, null);
  return todo.map(function (p) { return p.name; });
}

// Load packs.json and mount the always-on packs (the Corelib prelude). Returns
// the number of objects mounted.
async function mountBase() {
  var r = await fetch('coqlib/packs.json');
  if (!r.ok) throw new Error('coqlib/packs.json -> ' + r.status + ' (no library bundle staged; run make real)');
  manifest = await r.json();
  predeclareDirs();
  var n = 0;
  var always = (manifest.packs || []).filter(function (p) { return p.always; });
  for (var i = 0; i < always.length; i++) n += await mountPack(always[i]);
  return n;
}

(async function () {
  try {
    // The stages the page can show while it waits: the module is fetched and
    // compiled (a phone takes a minute or more), then the Corelib is mounted.
    self.postMessage({ type: 'loading', stage: 'engine', engine: ENGINE_DIR });
    engine = await awaitEngine(300000);
    await engine.ready;
    self.postMessage({ type: 'loading', stage: 'prelude', engine: ENGINE_DIR });
    var mounted = 0;
    try { mounted = await mountBase(); } catch (e) { mounted = 0; /* -noinit fallback */ }
    self.postMessage({ type: 'ready', version: engine.version, prelude: mounted > 0, vo: mounted, engine: ENGINE_DIR });
  } catch (e) {
    fatal(e);
    return;
  }
  self.onmessage = async function (ev) {
    var msg = ev.data || {};
    if (msg.type !== 'check') return;
    try {
      // lazy import: fetch+mount the packs this request's sources need, then check.
      try {
        var req = JSON.parse(msg.request);
        var files = req && req.files ? Object.keys(req.files).map(function (k) { return req.files[k]; }) : [];
        var fetched = await ensurePacks(files, function (ev) { ev.type = 'progress'; ev.id = msg.id; self.postMessage(ev); });
        if (fetched.length) self.postMessage({ type: 'packs', id: msg.id, fetched: fetched });
      } catch (e) { /* malformed request: let the engine return config_error */ }
      // the check itself runs to completion inside the engine; no finer progress exists
      self.postMessage({ type: 'progress', id: msg.id, stage: 'check' });
      var result = await engine.check(msg.request);
      self.postMessage({ type: 'result', id: msg.id, ok: true, result: result });
    } catch (err) {
      self.postMessage({ type: 'result', id: msg.id, ok: false, error: (err && err.message) || String(err) });
    }
  };
})();
