// runtime_shims.js — js_of_ocaml runtime shims for the browser Rocq build.
//
// Bundled by dune's (js_of_ocaml (javascript_files ...)) stanza. Provides the
// primitives that a natively-built rocq-runtime references but jsoo's runtime
// does not supply. Only primitives actually CALLED need real behaviour; jsoo
// emits Failure-raising dummies for the rest (VM opcodes, process spawn, ...),
// which are never hit because the browser build runs with vm:false and no
// subprocesses. See BACKEND.md.

// ---- threads: single-threaded no-ops (threads.posix is linked) ----
//Provides: caml_thread_initialize
function caml_thread_initialize(u){ return 0; }
//Provides: caml_thread_id
function caml_thread_id(u){ return 0; }
//Provides: caml_thread_self
function caml_thread_self(u){ return 0; }
//Provides: caml_thread_cleanup
function caml_thread_cleanup(u){ return 0; }
//Provides: caml_thread_new
function caml_thread_new(f){ return 0; }
//Provides: caml_thread_yield
function caml_thread_yield(u){ return 0; }
//Provides: caml_thread_join
function caml_thread_join(t){ return 0; }
//Provides: caml_thread_uncaught_exception
function caml_thread_uncaught_exception(e){ return 0; }
//Provides: caml_mutex_new
function caml_mutex_new(u){ return 0; }
//Provides: caml_mutex_lock
function caml_mutex_lock(m){ return 0; }
//Provides: caml_mutex_unlock
function caml_mutex_unlock(m){ return 0; }

// ---- getpid: a fixed pid ----
//Provides: caml_unix_getpid
function caml_unix_getpid(u){ return 42; }

// ---- Float64 primitives ------------------------------------------------
// kernel/float64_31.ml declares these as C externals and RUNS an IEEE-754
// self-test at module-init time, so they must exist and behave. jsoo's float
// is a real JS double (IEEE-754), so these are the native ops.
//Provides: rocq_fadd_byte
function rocq_fadd_byte(a,b){ return a + b; }
//Provides: rocq_fsub_byte
function rocq_fsub_byte(a,b){ return a - b; }
//Provides: rocq_fmul_byte
function rocq_fmul_byte(a,b){ return a * b; }
//Provides: rocq_fdiv_byte
function rocq_fdiv_byte(a,b){ return a / b; }
//Provides: rocq_fsqrt_byte
function rocq_fsqrt_byte(a){ return Math.sqrt(a); }

// nextafter(x, +Infinity) / nextafter(x, -Infinity) via IEEE bit twiddling.
//Provides: rocq_next_up_byte
function rocq_next_up_byte(x){
  if (x !== x) return x;            // NaN
  if (x === Infinity) return x;
  var buf = new DataView(new ArrayBuffer(8));
  if (x === 0) return 5e-324;       // smallest positive denormal
  buf.setFloat64(0, x);
  var hi = buf.getUint32(0), lo = buf.getUint32(4);
  if (x > 0) { if (lo === 0xFFFFFFFF){ lo = 0; hi = (hi+1)>>>0; } else lo = (lo+1)>>>0; }
  else       { if (lo === 0)         { lo = 0xFFFFFFFF; hi = (hi-1)>>>0; } else lo = (lo-1)>>>0; }
  buf.setUint32(0, hi); buf.setUint32(4, lo);
  return buf.getFloat64(0);
}
//Provides: rocq_next_down_byte
//Requires: rocq_next_up_byte
function rocq_next_down_byte(x){ return -rocq_next_up_byte(-x); }

// ---- VM: with vm:false the bytecode VM is never invoked; init is a no-op ----
//Provides: init_rocq_vm
function init_rocq_vm(u){ return 0; }

// vmvalues.ml runs `let accumulate = rocq_accumulate ()` at module-init; the
// result (a tcode) is only consumed while EXECUTING the bytecode VM, which is
// disabled (vm:false). A benign dummy lets the module load. Every other VM
// primitive is left as jsoo's Failure-raising dummy on purpose: if the VM were
// ever actually invoked it would fail loudly rather than return a wrong answer.
//Provides: rocq_accumulate
function rocq_accumulate(u){ return 0; }

// More tcode-plumbing primitives evaluated while the VM modules initialise
// (e.g. `Array.init len mkAccuCode` in vmvalues.ml). The tcode values they
// produce are only ever dereferenced by rocq_interprete_byte, which is left as
// a throwing dummy, so these benign values are safe with vm:false.
//Provides: rocq_makeaccu
function rocq_makeaccu(i){ return 0; }
//Provides: rocq_offset_tcode
function rocq_offset_tcode(tc,i){ return tc; }
//Provides: rocq_set_bytecode_field
function rocq_set_bytecode_field(o,i,tc){ return 0; }
//Provides: rocq_pushpop
function rocq_pushpop(i){ return 0; }

// nativevalues.ml runs `let mk_accu = let curry2_1 = get_curry2_1 () in ...`
// at init; the pointer is only used by NATIVE-compiled code, which is disabled
// (Global.set_native_compiler false). A dummy is safe.
//Provides: rocq_curry2_1_addr
function rocq_curry2_1_addr(u){ return 0; }
