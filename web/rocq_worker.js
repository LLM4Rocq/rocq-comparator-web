// rocq_worker.js — the Web Worker that hosts the OCaml Rocq engine.
//
// It loads ONE wasm engine (the wasm_of_ocaml build of web_check.ml), which
// installs `RocqComparator` on the worker global. Before serving checks it
// fetches and mounts the prelude/stdlib .vo bundle (coqlib/) into the engine's
// in-memory VFS via `RocqComparator.mount`, so checks run WITH the Corelib
// prelude (nat, notations, tactics) instead of -noinit. If the bundle is
// absent the worker still comes up and runs prelude-free (-noinit) checks.
//
// Running the engine in a worker keeps the UI responsive and, crucially, lets
// the main thread enforce a HARD wall-clock cap by terminate()-ing this worker.

self.window = self; // web_check installs on the global; make `window` an alias

// ---- pick the engine variant: cps (universal) or jspi (upgrade) -------------
//
// Two wasm engines ship, each a full glue .js + its own .assets/*.wasm:
//   * engine-cps/  — wasm_of_ocaml --effects=cps. Runs on ALL browsers
//                    (Safari, Firefox, older Chrome/Edge) and any Node. Larger
//                    .wasm. This is the UNIVERSAL default.
//   * engine-jspi/ — wasm_of_ocaml --effects=jspi. Uses the JS Promise
//                    Integration proposal (WebAssembly.Suspending/.promising);
//                    smaller/faster .wasm, but ONLY runs where JSPI is
//                    available: Node 24+, Chrome/Edge >= 137.
//
// Feature-detect JSPI and load the jspi engine when it is available, else cps.
// Each browser fetches exactly ONE engine (glue + one .wasm) — never both.
function jspiAvailable() {
  // WebAssembly.Suspending is the JSPI entry point the jspi glue calls; its
  // presence is the capability signal (Node 24+, Chrome/Edge >= 137).
  try { return typeof WebAssembly !== "undefined" && typeof WebAssembly.Suspending === "function"; }
  catch (e) { return false; }
}
var ENGINE_DIR = jspiAvailable() ? "engine-jspi" : "engine-cps";

// rocq_bytes.js is the ONE byte-exact conversion mount() consumes (shared with
// the node test). rocq_zarith.js installs globalThis.__rocqz (the JS BigInt
// backend the wasm engine imports for zarith) and MUST load before the engine
// glue instantiates. The engine glue (engine-<variant>/rocq_engine.js) is the
// wasm_of_ocaml build: it fetches its own engine-<variant>/rocq_engine.assets/
// *.wasm (relative to this worker's URL) and, once instantiated, installs
// `RocqComparator`.
try {
  importScripts('rocq_bytes.js', 'rocq_zarith.js', ENGINE_DIR + '/rocq_engine.js');
} catch (e) {
  self.postMessage({ type: 'fatal', error: 'failed to load the engine (' + ENGINE_DIR + '): ' + (e && e.message || e) });
  throw e;
}

// The wasm engine installs RocqComparator ASYNCHRONOUSLY (after wasm
// instantiation) — so wait for it.
var engine = null;
function awaitEngine(timeoutMs) {
  return new Promise(function (resolve, reject) {
    var t0 = Date.now();
    (function poll() {
      if (self.RocqComparator && typeof self.RocqComparator.check === 'function') return resolve(self.RocqComparator);
      if (Date.now() - t0 > timeoutMs) return reject(new Error('engine did not install RocqComparator (wasm instantiation failed?)'));
      setTimeout(poll, 20);
    })();
  });
}

// Fetch one binary asset (.vo / META) as the byte-exact string mount() consumes.
// fetch() -> ArrayBuffer -> Uint8Array -> RocqBytes.bytesToBinaryString: NO
// TextDecoder (whose 'latin1' is WHATWG windows-1252 in browsers and corrupts
// bytes 0x80-0x9F, which broke Prelude.vo — see rocq_bytes.js). The engine's
// .wasm is fetched byte-safely by the glue itself (instantiateStreaming), so
// only these VFS assets need the explicit byte conversion here.
async function fetchBinaryString(url) {
  var resp = await fetch(url);
  if (!resp.ok) throw new Error('fetch ' + url + ' -> ' + resp.status);
  var buf = await resp.arrayBuffer();
  return RocqBytes.bytesToBinaryString(new Uint8Array(buf));
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
    engine = await awaitEngine(60000);
    await engine.ready;
    var mounted = 0;
    try { mounted = await mountBundle(); } catch (e) { mounted = 0; /* -noinit fallback */ }
    self.postMessage({ type: 'ready', version: engine.version, prelude: mounted > 0, vo: mounted, engine: ENGINE_DIR });
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
