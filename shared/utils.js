/**
Copyright 2020 Jack Baker

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

(function utils() {
  const TYPES = ["i8", "u8", "i16", "u16", "i32", "u32", "i64", "u64", "f32", "f64", "ascii", "utf16", "utf8", "aob", "binary",
    "i16be", "u16be", "i32be", "u32be", "i64be", "u64be", "f32be", "f64be"];
  const DV = { __proto__: null, i8: "Int8", u8: "Uint8", i16: "Int16", u16: "Uint16", i32: "Int32", u32: "Uint32", i64: "BigInt64", u64: "BigUint64", f32: "Float32", f64: "Float64" };
  const CT = new Map(), base = t => TYPES.includes(t) && t.endsWith("be") ? t.slice(0, -2) : t, le = t => base(t) === t;
  const sizeOf = t => CT.get(t)?.size ?? DV[base(t)].match(/\d+/)[0] / 8;
  const isFloat = t => base(t) === "f32" || base(t) === "f64";
  const isBig = t => base(t) === "i64" || base(t) === "u64";
  const isNum = t => !!DV[base(t)] || CT.has(t);
  const isType = t => TYPES.includes(t) || CT.has(t);
  const toBig = v => typeof v === "bigint" ? v : BigInt(Math.trunc(Number(v)) || 0);
  const fn = (arg, src, expr = true) => {
    try { return new Function(arg, expr ? `return (${src}\n)` : src); } catch (e) { if (expr) return fn(arg, src, false); throw e; }
  };
  const codec = c => c.f ??= [fn("bytes", c.decode), fn("value", c.encode)];
  const cread = (dv, addr, c) => {
    try { return Number(codec(c)[0](new Uint8Array(dv.buffer, dv.byteOffset + addr, c.size).slice())); } catch { return null; }
  };
  const cbytes = (c, v) => {
    const b = Array.from(codec(c)[1](Number(v)) ?? []);
    const ok = b.length === c.size && b.every(x => Number.isInteger(x) && x >= 0 && x < 256);
    if (!ok) throw new RangeError(`Custom type ${c.name}: encode must return ${c.size} bytes`);
    return b;
  };
  const customTypes = (list, compile) => {
    const pick = ({ name, size, decode, encode }) => ({ name, size, decode, encode });
    if (list === undefined) return [...CT.values()].map(pick);
    if (!Array.isArray(list)) throw new TypeError("Invalid custom types");
    const RES = [...TYPES, "all", "group", "raw", "ptr"], m = new Map();
    for (const { name, size, decode, encode } of list.map(c => c ?? {})) {
      const bad = typeof name !== "string" || !/^[A-Za-z_]\w{0,31}$/.test(name) || m.has(name) || RES.includes(name);
      if (bad) throw new RangeError(`Invalid custom type name: ${name}`);
      if (!Number.isInteger(size) || size < 1 || size > 16) throw new RangeError(`Invalid size for custom type ${name}`);
      if (typeof decode !== "string" || typeof encode !== "string") throw new TypeError(`Custom type ${name} needs decode and encode`);
      const c = { name, size, decode, encode };
      if (compile) try { codec(c); } catch (e) { throw new SyntaxError(`Custom type ${name}: ${e.message}`); }
      m.set(name, c);
    }
    CT.clear();
    m.forEach((c, k) => CT.set(k, c));
    return customTypes();
  };
  const DEC = { ascii: "latin1", utf16: "utf-16le", utf8: "utf-8" };
  const read = (dv, addr, t, n) => CT.has(t) ? cread(dv, addr, CT.get(t))
    : DEC[t] ? new TextDecoder(DEC[t]).decode(new Uint8Array(dv.buffer, dv.byteOffset + addr, n).slice())
    : dv["get" + DV[base(t)]](addr, le(t));
  const write = (dv, addr, t, v) => CT.has(t) ? new Uint8Array(dv.buffer, dv.byteOffset + addr, sizeOf(t)).set(cbytes(CT.get(t), v))
    : dv["set" + DV[base(t)]](addr, isBig(t) ? toBig(v) : Number(v), le(t));

  const parseValue = (text, t) => {
    const s = String(text).trim();
    if (!isNum(t)) throw new RangeError(`Not a numeric type: ${t}`);
    const hex = /^[+-]?0x[0-9a-f]+$/i.test(s), neg = s[0] === "-", abs = s.replace(/^[+-]/, "");
    if (isFloat(t) || CT.has(t)) {
      const v = hex ? (neg ? -1 : 1) * Number(abs) : Number(s);
      if (s === "" || Number.isNaN(v)) throw new RangeError(`Invalid number: ${text}`);
      return base(t) === "f32" ? Math.fround(v) : v;
    }
    if (!hex && !/^[+-]?\d+$/.test(s)) throw new RangeError(`Invalid integer: ${text}`);
    let v = BigInt(abs) * (neg ? -1n : 1n);
    const bits = BigInt(sizeOf(t) * 8), signed = t[0] === "i";
    if (hex && !neg && signed && v < 1n << bits) v = BigInt.asIntN(Number(bits), v);
    const min = signed ? -(1n << bits - 1n) : 0n, max = (signed ? 1n << bits - 1n : 1n << bits) - 1n;
    if (v < min || v > max) throw new RangeError(`Value out of range for ${t}: ${text}`);
    return isBig(t) ? v : Number(v);
  };

  const formatValue = (v, t, hex = false) => {
    try {
      if (DEC[t] && ArrayBuffer.isView(v)) return read(new DataView(v.buffer, v.byteOffset, v.byteLength), 0, t, v.byteLength);
      if (!hex || !DV[base(t)] || isFloat(t)) return String(v);
      return toHex(BigInt.asUintN(sizeOf(t) * 8, BigInt(v)), sizeOf(t) * 2);
    } catch {
      return String(v);
    }
  };

  const parseAob = text => {
    const toks = String(text).trim().split(/\s+/).filter(Boolean);
    if (!toks.length) throw new RangeError("Empty byte pattern");
    const bytes = new Uint8Array(toks.length), mask = new Uint8Array(toks.length);
    toks.forEach((tok, i) => {
      if (!/^[0-9a-f?]{2}$/i.test(tok)) throw new RangeError(`Invalid byte: ${tok}`);
      bytes[i] = parseInt(tok.replace(/\?/g, "0"), 16);
      mask[i] = (tok[0] === "?" ? 0 : 0xF0) | (tok[1] === "?" ? 0 : 0x0F);
    });
    return { bytes, mask };
  };

  const parseBits = text => {
    const s = String(text).replace(/\s+/g, "");
    if (!s || s.length % 8) throw new RangeError("Bit pattern length must be a multiple of 8");
    const bytes = new Uint8Array(s.length / 8), mask = new Uint8Array(s.length / 8);
    [...s].forEach((c, i) => {
      if (!"01?".includes(c)) throw new RangeError(`Invalid bit: ${c}`);
      if (c !== "?") mask[i >> 3] |= 128 >> i % 8;
      if (c === "1") bytes[i >> 3] |= 128 >> i % 8;
    });
    return { bytes, mask };
  };

  const toBytes = (v, t) => {
    if (t === "aob") return parseAob(v).bytes;
    if (t === "binary") return parseBits(v).bytes;
    if (t === "ascii") return Uint8Array.from(String(v), c => c.charCodeAt(0) & 0xFF);
    if (t === "utf8") return new TextEncoder().encode(String(v));
    if (t === "utf16") {
      const s = String(v), out = new Uint8Array(s.length * 2), dv = new DataView(out.buffer);
      for (let i = 0; i < s.length; i++) dv.setUint16(i * 2, s.charCodeAt(i), true);
      return out;
    }
    const out = new Uint8Array(sizeOf(t));
    write(new DataView(out.buffer), 0, t, typeof v === "string" ? parseValue(v, t) : v);
    return out;
  };

  const ALIAS = { 1: "i8", 2: "i16", 4: "i32", 8: "i64", f: "f32", d: "f64" };
  const loose = (s, t) => {
    try {
      return parseValue(s, t);
    } catch {
      const v = BigInt.asIntN(sizeOf(t) * 8, BigInt(parseValue(s, "u" + t.slice(1))));
      return isBig(t) ? v : Number(v);
    }
  };
  const parseGroup = text => {
    let at = 0;
    const out = String(text).trim().split(/\s+/).filter(Boolean).map(tok => {
      const m = /^([^:@]+):(.+?)(?:@(0x[0-9a-f]+|\d+))?$/i.exec(tok), k = m?.[1].toLowerCase(), t = ALIAS[k] ?? k, s = m?.[2];
      if (!m || !TYPES.includes(t)) throw new RangeError(`Invalid group element: ${tok}`);
      if (s === "*" && !isNum(t)) throw new RangeError(`Wildcard needs a numeric type: ${tok}`);
      if (t === "aob" && s.length % 2) throw new RangeError(`Invalid byte: ${s}`);
      const value = s === "*" ? null : !isNum(t) ? t === "aob" ? s.match(/../g).join(" ") : s : ALIAS[k] && !isFloat(t) ? loose(s, t) : parseValue(s, t);
      const e = { offset: m[3] ? Number(m[3]) : at, type: t, value, size: isNum(t) ? sizeOf(t) : toBytes(value, t).length };
      if (isFloat(t)) e.tolerance = 5 / 10 ** ((/\.(\d*)/.exec(s)?.[1].length ?? 0) + 1);
      at = e.offset + e.size;
      return e;
    });
    if (!out.length) throw new RangeError("Empty group");
    return out;
  };

  const toHex = (n, width = 8) => "0x" + n.toString(16).toUpperCase().padStart(width, "0");

  const CELL = { u8: "u8", hex32: "u32" };
  const shortF32 = v => {
    for (let p = 1; p < 9; p++) if (Math.fround(+v.toPrecision(p)) === v) return String(+v.toPrecision(p));
    return String(v);
  };
  const memCells = (bytes, disp) => {
    const t = CELL[disp] ?? disp, n = sizeOf(t), dv = new DataView(Uint8Array.from(bytes).buffer), out = [];
    for (let k = 0; k + n <= bytes.length; k += n) {
      const v = read(dv, k, t);
      out.push({ offset: k, type: t, size: n, text: CELL[disp] ? toHex(v, n * 2).slice(2) : t === "f32" ? shortF32(v) : String(v) });
    }
    return out;
  };

  const uleb = v => {
    const o = [];
    do {
      const b = Number(v & 0x7Fn);
      v >>= 7n;
      o.push(v ? b | 0x80 : b);
    } while (v);
    return o;
  };
  const sleb = v => {
    for (const o = [];;) {
      const b = Number(v & 0x7Fn);
      v >>= 7n;
      if (v === 0n && !(b & 0x40) || v === -1n && b & 0x40) return o.push(b), o;
      o.push(b | 0x80);
    }
  };
  const check = (v, bits, signed) => {
    const big = BigInt(v);
    if ((signed ? BigInt.asIntN(bits, big) : BigInt.asUintN(bits, big)) !== big) throw new RangeError(`LEB128 value out of range: ${v}`);
    return big;
  };
  const rleb = (u8, pos, bits, signed) => {
    let r = 0n, shift = 0n, b, n = 0;
    do {
      if (pos >= u8.length) throw new RangeError("Unexpected end of LEB128");
      if (n++ === Math.ceil(bits / 7)) throw new RangeError("LEB128 too long");
      b = u8[pos++];
      r |= BigInt(b & 0x7F) << shift;
      shift += 7n;
    } while (b & 0x80);
    if (signed && b & 0x40) r -= 1n << shift;
    return [check(r, bits, signed), pos];
  };
  const leb = {
    u32: n => uleb(check(n, 32, false)),
    s32: n => sleb(check(n, 32, true)),
    u64: n => uleb(check(n, 64, false)),
    s64: n => sleb(check(n, 64, true)),
    readU32: (u8, pos) => { const [v, p] = rleb(u8, pos, 32, false); return [Number(v), p]; },
    readS32: (u8, pos) => { const [v, p] = rleb(u8, pos, 32, true); return [Number(v), p]; },
    readU64: (u8, pos) => rleb(u8, pos, 64, false),
    readS64: (u8, pos) => rleb(u8, pos, 64, true),
  };

  const encode = obj => JSON.stringify(obj, (k, v) =>
    typeof v === "bigint" ? { $big: v.toString() } : ArrayBuffer.isView(v) && !(v instanceof DataView) ? Array.from(v) : v);
  const decode = str => JSON.parse(str, (k, v) =>
    v && typeof v === "object" && typeof v.$big === "string" && Object.keys(v).length === 1 ? BigInt(v.$big) : v);

  const siteKey = url => {
    try {
      const u = new URL(url);
      return u.host + u.pathname;
    } catch {
      return String(url);
    }
  };

  Object.assign(globalThis.cetusLib ??= {}, { TYPES, sizeOf, isFloat, isBig, isNum, isType, customTypes, read, write, parseValue, formatValue, toBytes, parseAob, parseBits, parseGroup, toHex, memCells, leb, encode, decode, siteKey, src: `(${utils})();` });
})();
