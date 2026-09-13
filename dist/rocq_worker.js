// rocq_worker.js — the Web Worker that hosts the OCaml Rocq engine.
//
// It loads rocq_engine.js (the js_of_ocaml build of web_check.ml), which
// installs `RocqComparator` on the worker global. Before serving checks it
// fetches and mounts the prelude/stdlib .vo bundle (coqlib/) into the engine's
// in-memory VFS via `RocqComparator.mount`, so checks run WITH the Corelib
// prelude (nat, notations, tactics) instead of -noinit. If the bundle is
// absent the worker still comes up and runs prelude-free (-noinit) checks.
//
// Running the engine in a worker keeps the UI responsive and, crucially, lets
// the main thread enforce a HARD wall-clock cap by terminate()-ing this worker.

self.window = self; // web_check installs on the global; make `window` an alias

try {
  importScripts('rocq_engine.js');
} catch (e) {
  self.postMessage({ type: 'fatal', error: 'failed to load rocq_engine.js: ' + (e && e.message || e) });
  throw e;
}

var engine = self.RocqComparator;

// Fetch one file as a binary string (each byte -> char code 0-255). TextDecoder
// 'latin1' maps bytes 1:1 to code points, which the engine's Js.to_bytestring
// reads back as the exact bytes — required for the binary .vo to survive intact.
async function fetchBinaryString(url) {
  var resp = await fetch(url);
  if (!resp.ok) throw new Error('fetch ' + url + ' -> ' + resp.status);
  var buf = await resp.arrayBuffer();
  return new TextDecoder('latin1').decode(new Uint8Array(buf));
}

// Mount the coqlib bundle (Corelib prelude + stdlib .vo + a stripped findlib
// META) described by coqlib/manifest.json. Returns the number of .vo mounted;
// 0 (or throwing) means "no bundle" and the engine falls back to -noinit.
async function mountBundle() {
  var manifest;
  try {
    var mresp = await fetch('coqlib/manifest.json');
    if (!mresp.ok) return 0;              // no bundle shipped: -noinit fallback
    manifest = await mresp.json();
  } catch (e) { return 0; }
  var coqlibVfs = manifest.coqlib_vfs || '/coqlib';
  // The stripped META lets Rocq's findlib resolve the statically-linked plugins
  // the prelude Declare-ML-Modules without Dynlink (see web/dune, web_check.ml).
  if (manifest.meta) {
    try { engine.mount(manifest.meta_vfs || '/static/lib/rocq-runtime/META',
                       await fetchBinaryString('coqlib/' + manifest.meta)); } catch (e) {}
  }
  // Fetch + mount every .vo in parallel (bounded by the browser's connection
  // pool). Each mount is a synchronous VFS write in the engine.
  var vo = manifest.vo || [];
  await Promise.all(vo.map(async function (rel) {
    var content = await fetchBinaryString('coqlib/' + rel);
    engine.mount(coqlibVfs + '/' + rel, content);
  }));
  return vo.length;
}

(async function () {
  try {
    if (!engine || typeof engine.check !== 'function') throw new Error('engine did not install RocqComparator');
    await engine.ready;
    var mounted = 0;
    try { mounted = await mountBundle(); } catch (e) { mounted = 0; /* -noinit fallback */ }
    self.postMessage({ type: 'ready', version: engine.version, prelude: mounted > 0, vo: mounted });
  } catch (e) {
    self.postMessage({ type: 'fatal', error: (e && e.message) || String(e) });
    return;
  }
  self.onmessage = async function (ev) {
    var msg = ev.data || {};
    if (msg.type !== 'check') return;
    try {
      var result = await engine.check(msg.request);   // resolved verdict JSON
      self.postMessage({ type: 'result', id: msg.id, ok: true, result: result });
    } catch (err) {
      // out-of-band failure (malformed request, wasm trap, ...) — see contract
      self.postMessage({ type: 'result', id: msg.id, ok: false, error: (err && err.message) || String(err) });
    }
  };
})();
