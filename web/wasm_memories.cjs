// wasm_memories.cjs: the memories of a wasm module, and the single-memory
// rewrite the engines need for Safari (BACKEND.md 15.7).
//
// wasm_of_ocaml 6.4.1 links three linear memories into every module (the C
// runtime's, blake2's, and the one-page string scratch buffer it exports as
// caml_buffer). Safari has no multi-memory support and refuses the module.
// `--lower` merges them with binaryen's multi-memory-lowering pass and patches
// the JS glue, which reads the scratch buffer at offset 0 of the exported
// memory: after the merge that buffer is the LAST memory's region, at the end
// of the combined memory (the first memory can grow, which moves the region and
// detaches the ArrayBuffer, so the glue re-derives the view on every call).
//
//   node web/wasm_memories.cjs <module.wasm>                     print the memories
//   node web/wasm_memories.cjs --lower <module.wasm> <glue.js>   rewrite in place
//
// No dependencies: only the import (2), memory (5) and export (7) sections are
// parsed. require()d by test/judge_test.cjs as the single-memory guard.
'use strict';
const fs = require('fs'), cp = require('child_process'), path = require('path');

const PAGE = 65536;
// wasm_of_ocaml's own binaryen flags (its Binaryen.common_options) plus the ones
// the modules declare (wasm-opt --detect-features --print-features)
const FEATURES = ['--enable-gc', '--enable-multivalue', '--enable-exception-handling', '--enable-reference-types',
  '--enable-tail-call', '--enable-bulk-memory', '--enable-nontrapping-float-to-int', '--enable-strings',
  '--enable-multimemory', '--enable-mutable-globals', '--enable-sign-ext', '--enable-bulk-memory-opt'];

// { memories: [{min, max}], imported: [{module, name}], exports: [{name, idx, idxPos}] }
function memories(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x6d736100) throw new Error(file + ': not a wasm module');
  let p = 8;
  const u32 = () => { let r = 0, s = 0, b; do { b = buf[p++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return r; };
  const s33 = () => { let b; do { b = buf[p++]; } while (b & 0x80); };
  const str = () => { const n = u32(), s = buf.toString('utf8', p, p + n); p += n; return s; };
  const limits = () => { const f = u32(), min = u32(); return { min, max: (f & 1) ? u32() : null }; };
  const reftype = () => { const b = buf[p++]; if (b === 0x63 || b === 0x64) s33(); };
  const out = { memories: [], imported: [], exports: [] };
  while (p < buf.length) {
    const id = buf[p++], size = u32(), end = p + size;
    if (id === 2) {
      for (let n = u32(); n > 0; n--) {
        const module = str(), name = str(), kind = buf[p++];
        if (kind === 0) u32();
        else if (kind === 1) { reftype(); limits(); }
        else if (kind === 2) { limits(); out.imported.push({ module, name }); }
        else if (kind === 3) { reftype(); p++; }
        else if (kind === 4) { p++; u32(); }
        else throw new Error(file + ': unknown import kind ' + kind);
      }
    } else if (id === 5) {
      for (let n = u32(); n > 0; n--) out.memories.push(limits());
    } else if (id === 7) {
      for (let n = u32(); n > 0; n--) {
        const name = str(), kind = buf[p++], idxPos = p, idx = u32();
        if (kind === 2) out.exports.push({ name, idx, idxPos });
      }
    }
    p = end;
  }
  return out;
}

function lower(wasm, glue) {
  const m = memories(wasm);
  const total = m.imported.length + m.memories.length;
  if (total <= 1) { console.log(path.basename(wasm) + ': ' + total + ' memory, nothing to do'); return; }
  // what the pass and the glue patch assume
  if (m.imported.length) throw new Error(wasm + ': imported memories: ' + JSON.stringify(m.imported));
  const last = m.memories.length - 1, exp = m.exports;
  if (exp.length !== 1 || exp[0].name !== 'caml_buffer' || exp[0].idx !== last || last >= 128)
    throw new Error(wasm + ': expected caml_buffer to export the last memory, got ' + JSON.stringify(exp));
  const region = m.memories[last].min * PAGE;
  // 1. the pass exports the combined memory only under the FIRST memory's export:
  //    point the caml_buffer export at memory 0 (a one-byte index)
  const tmp = wasm + '.multi', buf = fs.readFileSync(wasm);
  buf[exp[0].idxPos] = 0;
  fs.writeFileSync(tmp, buf);
  // 2. merge the memories
  const r = cp.spawnSync('wasm-opt', [...FEATURES, '--multi-memory-lowering', tmp, '-o', wasm], { stdio: 'inherit' });
  fs.unlinkSync(tmp);
  if (r.status !== 0) throw new Error('wasm-opt failed: ' + (r.error ? r.error.message : 'exit ' + r.status));
  const after = memories(wasm);
  if (after.memories.length !== 1 || after.imported.length || after.exports.length !== 1 || after.exports[0].idx !== 0)
    throw new Error(wasm + ': after lowering: ' + JSON.stringify(after));
  // 3. the glue: the scratch buffer is the last `region` bytes of the exported
  //    memory, re-read on every use (a grow detaches the cached ArrayBuffer)
  const src0 = fs.readFileSync(glue, 'utf8');
  const mt = /(\w+)=(\w+)\?\.buffer,(\w+)=\1&&new\s+Uint8Array\(\1,0,\1\.length\)/.exec(src0);
  if (!mt) throw new Error(glue + ': buffer setup not found');
  const [whole, k, mem, ab] = mt;
  let src = src0.replace(whole, k + '=()=>{var b=' + mem + '.buffer;return new Uint8Array(b,b.byteLength-' + region + ')}');
  const readRe = new RegExp('new\\s+Uint8Array\\(' + k + ',0,', 'g');
  const reads = (src.match(readRe) || []).length;
  if (reads !== 2) throw new Error(glue + ': expected 2 read views, found ' + reads);
  src = src.replace(readRe, k + '().subarray(0,');
  const abRe = new RegExp('([^\\w$])' + ab + '(?![\\w$])', 'g');
  const writes = (src.match(abRe) || []).length;
  if (writes !== 1) throw new Error(glue + ': expected 1 write view, found ' + writes);
  src = src.replace(abRe, '$1' + k + '()');
  fs.writeFileSync(glue, src);
  console.log(path.basename(wasm) + ': ' + total + ' memories -> 1 (' + m.memories.map(x => x.min).join('+') + ' pages; caml_buffer = last '
    + region + ' bytes); glue: ' + reads + ' read view(s), ' + writes + ' write view(s) rewritten');
}

module.exports = { memories, lower };
if (require.main === module) {
  const a = process.argv.slice(2);
  if (a[0] === '--lower') lower(a[1], a[2]);
  else for (const f of a) { const m = memories(f); console.log(f + ': ' + m.memories.length + ' defined, ' + m.imported.length + ' imported, exports ' + JSON.stringify(m.exports.map(e => e.name + '->' + e.idx))); }
}
