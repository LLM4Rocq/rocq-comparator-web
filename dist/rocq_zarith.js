// rocq_zarith.js — JS BigInt backend for the wasm zarith primitives.
//
// wasm_of_ocaml resolves OCaml `external` C primitives from the WASM runtime
// only (a JS //Provides fragment becomes a throwing dummy — verified). So the
// ~30 zarith `ml_z_*` stubs the rocq-runtime references are supplied as
// WebAssembly (web/rocq_shims.wat). Those wasm stubs delegate the actual
// arbitrary-precision arithmetic to the JS helpers below: the wasm module
// imports them from the "js" import module, which wasm_of_ocaml binds to
// globalThis. So THIS file must install rocqz_* on globalThis BEFORE the engine
// wasm instantiates (the worker/test loads it first). JS BigInt gives EXACT
// arbitrary precision, so this is a correct zarith, not an approximation.
//
// Z.t at the wasm boundary: a "small" value is an OCaml int (wasm i31); a
// "big" value is a JS BigInt wrapped as an OCaml value (runtime `wrap`). The
// wasm stubs (rocq_shims.wat) convert i31<->BigInt and normalise results back
// to i31 when they fit OCaml's (here 31-bit) int, exactly like zarith_stubs_js.
(function (g) {
  "use strict";
  // OCaml int is 31-bit under wasm_of_ocaml: [-2^30, 2^30-1].
  var MIN = -1073741824n, MAX = 1073741823n;

  g.rocqz_of_int   = function (n) { return BigInt(n); };
  g.rocqz_is_small = function (b) { return (b >= MIN && b <= MAX) ? 1 : 0; };
  g.rocqz_to_int_  = function (b) { return Number(b); };

  g.rocqz_neg = function (a) { return -a; };
  g.rocqz_abs = function (a) { return a < 0n ? -a : a; };
  g.rocqz_succ = function (a) { return a + 1n; };
  g.rocqz_pred = function (a) { return a - 1n; };
  g.rocqz_lognot = function (a) { return ~a; };

  g.rocqz_add = function (a, b) { return a + b; };
  g.rocqz_sub = function (a, b) { return a - b; };
  g.rocqz_mul = function (a, b) { return a * b; };
  g.rocqz_div = function (a, b) { return a / b; };            // trunc toward 0 (C div / zarith c_div)
  g.rocqz_rem = function (a, b) { return a % b; };            // sign of dividend (zarith c_rem)
  g.rocqz_divexact = function (a, b) { return a / b; };
  g.rocqz_logand = function (a, b) { return a & b; };
  g.rocqz_logor  = function (a, b) { return a | b; };
  g.rocqz_logxor = function (a, b) { return a ^ b; };

  // ceil division (zarith cdiv): round quotient toward +inf
  g.rocqz_cdiv = function (a, b) {
    var q = a / b, r = a % b;
    if (r !== 0n && ((a > 0n) === (b > 0n))) q += 1n;
    return q;
  };
  // floor division (zarith fdiv): round quotient toward -inf
  g.rocqz_fdiv = function (a, b) {
    var q = a / b, r = a % b;
    if (r !== 0n && ((a > 0n) !== (b > 0n))) q -= 1n;
    return q;
  };

  g.rocqz_gcd = function (a, b) {
    a = a < 0n ? -a : a; b = b < 0n ? -b : b;
    while (b) { var t = a % b; a = b; b = t; }
    return a;                                                  // non-negative (zarith gcd)
  };

  g.rocqz_shift_left  = function (a, n) { return a << BigInt(n); };
  g.rocqz_shift_right = function (a, n) { return a >> BigInt(n); };   // arithmetic floor shift (zarith c_shift_right)
  g.rocqz_pow = function (a, n) {
    if (n < 0) throw new Error("Z.pow: negative exponent");
    return a ** BigInt(n);
  };
  g.rocqz_testbit = function (a, n) { return ((a >> BigInt(n)) & 1n) === 1n ? 1 : 0; };

  g.rocqz_sign    = function (a) { return a < 0n ? -1 : (a > 0n ? 1 : 0); };
  g.rocqz_compare = function (a, b) { return a < b ? -1 : (a > b ? 1 : 0); };
  g.rocqz_equal   = function (a, b) { return a === b ? 1 : 0; };

  // int64 <-> BigInt: the wasm i64 boundary already hands us / takes a BigInt.
  g.rocqz_of_i64 = function (b) { return b; };
  g.rocqz_to_i64 = function (b) { return BigInt.asIntN(64, b); };
  g.rocqz_overflow_msg = function () { return "Z.Overflow"; };

  // parse: base 0 = autodetect (0x/0o/0b prefix, else decimal); 2..16 explicit.
  // Mirrors zarith Z.of_substring_base (sign, '_' separators, prefix).
  g.rocqz_of_substring_base = function (base, s, pos, len) {
    var str = String(s).substr(pos, len).replace(/_/g, "");
    var i = 0, neg = false;
    if (str[i] === "+" ) i++;
    else if (str[i] === "-") { neg = true; i++; }
    str = str.slice(i);
    var b = base;
    if (base === 0) {
      if (/^0[xX]/.test(str)) { b = 16; str = str.slice(2); }
      else if (/^0[oO]/.test(str)) { b = 8; str = str.slice(2); }
      else if (/^0[bB]/.test(str)) { b = 2; str = str.slice(2); }
      else b = 10;
    } else if (base === 16 && /^0[xX]/.test(str)) str = str.slice(2);
    else if (base === 8 && /^0[oO]/.test(str)) str = str.slice(2);
    else if (base === 2 && /^0[bB]/.test(str)) str = str.slice(2);
    var acc = 0n, B = BigInt(b);
    for (var k = 0; k < str.length; k++) {
      var d = parseInt(str[k], b);
      if (isNaN(d)) throw new Error("Z.of_substring_base: bad digit");
      acc = acc * B + BigInt(d);
    }
    return neg ? -acc : acc;
  };

  // Z.format: printf-style. Supports flags [-+ 0#], width, and d/i/u/x/X/o/b.
  g.rocqz_format = function (fmt, b) {
    fmt = String(fmt);
    var m = /^%([-+ 0#]*)(\d+)?([diuxXob])$/.exec(fmt);
    if (!m) { // fallback: plain decimal
      return b.toString();
    }
    var flags = m[1] || "", width = m[2] ? parseInt(m[2], 10) : 0, conv = m[3];
    var neg = b < 0n, mag = neg ? -b : b, body, prefix = "";
    switch (conv) {
      case "d": case "i": case "u": body = mag.toString(10); break;
      case "x": body = mag.toString(16); if (flags.indexOf("#") >= 0 && mag !== 0n) prefix = "0x"; break;
      case "X": body = mag.toString(16).toUpperCase(); if (flags.indexOf("#") >= 0 && mag !== 0n) prefix = "0X"; break;
      case "o": body = mag.toString(8); if (flags.indexOf("#") >= 0) prefix = "0"; break;
      case "b": body = mag.toString(2); break;
      default:  body = mag.toString(10);
    }
    var sign = neg ? "-" : (flags.indexOf("+") >= 0 ? "+" : (flags.indexOf(" ") >= 0 ? " " : ""));
    var s = sign + prefix + body;
    if (s.length < width) {
      var pad = width - s.length;
      if (flags.indexOf("-") >= 0) s = s + " ".repeat(pad);
      else if (flags.indexOf("0") >= 0) s = sign + prefix + "0".repeat(pad) + body;
      else s = " ".repeat(pad) + s;
    }
    return s;
  };
  g.__rocqz = {};
  for (var _k in g) if (_k.indexOf("rocqz_") === 0) g.__rocqz[_k] = g[_k];
})(typeof globalThis !== "undefined" ? globalThis : this);
