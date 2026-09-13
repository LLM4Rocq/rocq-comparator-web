// rocq_bytes.js — the ONE byte-exact conversion the engine's mount() consumes.
//
// mount(path, content) writes `content` into the OCaml VFS via Js.to_bytestring,
// which reads each JS char code as one raw byte (0-255). A binary asset (.vo,
// META) must therefore reach mount() as a string whose char code i EQUALS byte i
// of the file — any other representation corrupts the file.
//
// THE BUG THIS FIXES (real-browser Prelude.vo "Bytes.create" anomaly):
//   The obvious `new TextDecoder('latin1').decode(bytes)` is NOT byte-exact in a
//   browser. Per the WHATWG Encoding Standard the label "latin1" (and
//   "iso-8859-1") is an alias for **windows-1252**, whose decoder remaps bytes
//   0x80-0x9F to other code points (e.g. 0x85 -> U+2026 '…'). So a .vo byte in
//   that range comes back as the WRONG char code; a size field then reads as a
//   huge/negative length and the kernel raises Invalid_argument("Bytes.create")
//   while parsing Prelude.vo. (Node's TextDecoder happens to decode that range
//   byte-for-byte, which is exactly why the bug hid from the node test while
//   breaking every real browser.)
//
// THE FIX: never use TextDecoder for binary. String.fromCharCode is defined
// identically in every JS engine — code point === argument for 0-255 — so
// building the string from the byte values is byte-exact everywhere. This file
// is the single source of truth, loaded by BOTH the browser Worker
// (rocq_worker.js) and the node test harness (test/judge_test.cjs), so the two
// exercise the SAME conversion and no corruption class can hide between them.
(function (root, factory) {
  var api = factory();
  root.RocqBytes = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  // Uint8Array -> binary string (char code i === byte i, for all bytes 0-255).
  // Chunked so String.fromCharCode.apply does not overflow the argument stack on
  // multi-MB assets, and byte-exact regardless of the host JS engine.
  function bytesToBinaryString(bytes) {
    var CHUNK = 0x8000, out = "", n = bytes.length, i;
    for (i = 0; i < n; i += CHUNK) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, n)));
    }
    return out;
  }

  return { bytesToBinaryString: bytesToBinaryString };
});
