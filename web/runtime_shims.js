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

// ---- exit: never the not-implemented anomaly (BROWSER Milestone 0) ---------
// OVERRIDES jsoo's own caml_sys_exit. jsoo's version tries globalThis.quit /
// process.exit / std.exit and, when none exist (a browser Web Worker has no
// `process`), falls through to
//   caml_invalid_argument("Function 'exit' not implemented")
// which Rocq re-wraps as
//   Anomaly "Uncaught exception Invalid_argument(Function exit not implemented)"
// — the exact double error the user hit in the browser.
//
// The only `exit` call on our path is boot/env.ml:validate_env: at init it
// checks that <coqlib>/Init/Prelude.vo and the plugins dir exist and calls
// `exit 1` (fail_lib / fail_core) when they don't. In node, jsoo's node FS
// device sees the real _opam on disk so the check passes; in a browser Web
// Worker the in-memory VFS has no such file, so the check fails and Rocq exits.
// With `-noinit` the prelude is never actually loaded, so the right behaviour
// is to let init CONTINUE past that sanity check rather than abort: we record
// the requested code and RETURN (exit : int -> 'a, so a returned value is
// coerced to whatever the caller expected; validate_env just goes on to return
// its env). This turns the crash into a working -noinit check. If a future
// caller genuinely needs termination it would have to be handled explicitly;
// on the browser worker path nothing does.
//Provides: caml_sys_exit
function caml_sys_exit(code){
  try { globalThis.__rocq_last_exit_code = code; } catch (e) {}
  return 0;
}

// ---- caml_unix_* the native rocq-runtime references but the browser lacks ---
// These sit ONLY on paths the browser build never takes: the interval-timer
// path (Control.timeout is replaced by a run-to-completion hook in web_check,
// so getitimer/setitimer are never armed) and the subprocess / signal /
// sandbox paths (rocqchk = None, no fork/exec). jsoo would otherwise emit its
// own `globalThis.<name> !== undefined ? ... : caml_failwith("<name> not
// implemented")` fallback; we provide explicit, deterministic shims instead so
// the behaviour does not drift with the toolchain.
//
// getitimer/setitimer return a zero `interval_timer_status`. That OCaml record
// { it_interval : float; it_value : float } is an all-float record, so jsoo
// represents it as a flat float array tagged 254: [254, it_interval, it_value]
// (confirmed at the setitimer call site in the emitted engine). A zero timer is
// the correct "no timer armed" answer.
//Provides: caml_unix_getitimer
function caml_unix_getitimer(which){ return [254, 0, 0]; }
//Provides: caml_unix_setitimer
function caml_unix_setitimer(which, newstatus){ return [254, 0, 0]; }

// The rest are on subprocess / signal paths that never run in the browser. A
// plain catchable OCaml Failure (via caml_failwith) is safe: if one were ever
// reached it is caught as noncritical (CErrors.noncritical) and surfaced as a
// normal verdict, never the not-implemented anomaly.
//Provides: caml_unix_pipe
//Requires: caml_failwith
function caml_unix_pipe(cloexec, u){ caml_failwith("caml_unix_pipe not implemented (browser)"); }
//Provides: caml_unix_dup
//Requires: caml_failwith
function caml_unix_dup(cloexec, fd){ caml_failwith("caml_unix_dup not implemented (browser)"); }
//Provides: caml_unix_kill
//Requires: caml_failwith
function caml_unix_kill(pid, sig){ caml_failwith("caml_unix_kill not implemented (browser)"); }
//Provides: caml_unix_waitpid
//Requires: caml_failwith
function caml_unix_waitpid(flags, pid){ caml_failwith("caml_unix_waitpid not implemented (browser)"); }
//Provides: caml_unix_spawn
//Requires: caml_failwith
function caml_unix_spawn(cmd, args, optenv, usepath, redirs){ caml_failwith("caml_unix_spawn not implemented (browser)"); }
//Provides: caml_unix_sigprocmask
//Requires: caml_failwith
function caml_unix_sigprocmask(how, mask){ caml_failwith("caml_unix_sigprocmask not implemented (browser)"); }
//Provides: caml_unix_sleep
//Requires: caml_failwith
function caml_unix_sleep(seconds){ caml_failwith("caml_unix_sleep not implemented (browser)"); }

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
