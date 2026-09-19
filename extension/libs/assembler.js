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

(() => {
  const { leb, toHex } = globalThis.cetusLib;

  class AsmError extends Error {
    constructor(message, line = null, offset = null) {
      super(message);
      Object.assign(this, { name: "AsmError", line, offset });
    }
  }

  const REF = { func: 0x70, extern: 0x6F, any: 0x6E, eq: 0x6D, i31: 0x6C, struct: 0x6B, array: 0x6A, exn: 0x69, none: 0x71, noextern: 0x72, nofunc: 0x73, noexn: 0x74 };
  const NULLREF = { none: "nullref", noextern: "nullexternref", nofunc: "nullfuncref", noexn: "nullexnref" };
  const inverse = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]));
  const VT = { i32: 0x7F, i64: 0x7E, f32: 0x7D, f64: 0x7C, v128: 0x7B, ...Object.fromEntries(Object.entries(REF).map(([k, v]) => [NULLREF[k] ?? k + "ref", v])) };
  const HT = { ...REF, funcref: 0x70, externref: 0x6F };
  const VTN = inverse(VT), HTN = inverse(REF);
  const OPEN = [0x02, 0x03, 0x04, 0x06, 0x1F], MID = [0x05, 0x07, 0x19], CLOSE = [0x0B, 0x18];
  const seq = (base, kind, names) => names.trim().split(/\s+/).flatMap((n, i) => n === "-" ? [] : [[n.split(":")[0], base + i, n.split(":")[1] ?? kind]]);
  const rmw = ["add", "sub", "and", "or", "xor", "xchg", "cmpxchg"]
    .flatMap(o => ["i32.atomic.rmw", "i64.atomic.rmw", "i32.atomic.rmw8", "i32.atomic.rmw16", "i64.atomic.rmw8", "i64.atomic.rmw16", "i64.atomic.rmw32"].map((p, i) => `${p}.${o}${i > 1 ? "_u" : ""}`));
  const icmp = "eq ne lt_s lt_u gt_s gt_u le_s le_u ge_s ge_u", fcmp = "eq ne lt gt le ge";

  const OPS = [
    ["unreachable", 0x00, ""], ["nop", 0x01, ""], ["block", 0x02, "bt"], ["loop", 0x03, "bt"], ["if", 0x04, "bt"], ["else", 0x05, ""],
    ["try", 0x06, "bt"], ["catch", 0x07, "u"], ["throw", 0x08, "u"], ["rethrow", 0x09, "u"], ["throw_ref", 0x0A, ""],
    ["end", 0x0B, ""], ["br", 0x0C, "u"], ["br_if", 0x0D, "u"], ["br_table", 0x0E, "brt"], ["return", 0x0F, ""], ["call", 0x10, "u"],
    ["call_indirect", 0x11, "uu"], ["return_call", 0x12, "u"], ["return_call_indirect", 0x13, "uu"], ["call_ref", 0x14, "u"], ["return_call_ref", 0x15, "u"],
    ["delegate", 0x18, "u"], ["catch_all", 0x19, ""], ["drop", 0x1A, ""], ["select", 0x1B, ""], ["select", 0x1C, "vt"], ["try_table", 0x1F, "tt"],
    ["local.get", 0x20, "u", "get_local"], ["local.set", 0x21, "u", "set_local"], ["local.tee", 0x22, "u", "tee_local"],
    ["global.get", 0x23, "u", "get_global"], ["global.set", 0x24, "u", "set_global"], ["table.get", 0x25, "u"], ["table.set", 0x26, "u"],
    ...seq(0x28, "m", "i32.load i64.load f32.load f64.load i32.load8_s i32.load8_u i32.load16_s i32.load16_u i64.load8_s i64.load8_u i64.load16_s i64.load16_u " +
      "i64.load32_s i64.load32_u i32.store i64.store f32.store f64.store i32.store8 i32.store16 i64.store8 i64.store16 i64.store32"),
    ["memory.size", 0x3F, "u", "current_memory"], ["memory.grow", 0x40, "u", "grow_memory"],
    ["i32.const", 0x41, "i32"], ["i64.const", 0x42, "i64"], ["f32.const", 0x43, "f32"], ["f64.const", 0x44, "f64"],
    ...["i32", "i64"].flatMap(t => ["eqz", ...icmp.split(" ")].map(o => `${t}.${o}`)),
    ...["f32", "f64"].flatMap(t => fcmp.split(" ").map(o => `${t}.${o}`)),
    ...["i32", "i64"].flatMap(t => "clz ctz popcnt add sub mul div_s div_u rem_s rem_u and or xor shl shr_s shr_u rotl rotr".split(" ").map(o => `${t}.${o}`)),
    ...["f32", "f64"].flatMap(t => "abs neg ceil floor trunc nearest sqrt add sub mul div min max copysign".split(" ").map(o => `${t}.${o}`)),
    ..."i32.wrap_i64 i32.trunc_f32_s i32.trunc_f32_u i32.trunc_f64_s i32.trunc_f64_u i64.extend_i32_s i64.extend_i32_u i64.trunc_f32_s i64.trunc_f32_u i64.trunc_f64_s i64.trunc_f64_u f32.convert_i32_s f32.convert_i32_u f32.convert_i64_s f32.convert_i64_u f32.demote_f64 f64.convert_i32_s f64.convert_i32_u f64.convert_i64_s f64.convert_i64_u f64.promote_f32 i32.reinterpret_f32 i64.reinterpret_f64 f32.reinterpret_i32 f64.reinterpret_i64 i32.extend8_s i32.extend16_s i64.extend8_s i64.extend16_s i64.extend32_s".split(" "),
    ...seq(0xD0, "", "ref.null:ht ref.is_null ref.func:u ref.eq ref.as_non_null br_on_null:u br_on_non_null:u"),
    ...seq(0xFB000, "u", `struct.new struct.new_default struct.get:uu struct.get_s:uu struct.get_u:uu struct.set:uu array.new array.new_default array.new_fixed:uu
      array.new_data:uu array.new_elem:uu array.get array.get_s array.get_u array.set array.len: array.fill array.copy:uu array.init_data:uu array.init_elem:uu
      ref.test:htr ref.test:htn ref.cast:htr ref.cast:htn br_on_cast:cast br_on_cast_fail:cast any.convert_extern: extern.convert_any: ref.i31: i31.get_s: i31.get_u:`),
    ...seq(0xFC000, "", "i32.trunc_sat_f32_s i32.trunc_sat_f32_u i32.trunc_sat_f64_s i32.trunc_sat_f64_u i64.trunc_sat_f32_s i64.trunc_sat_f32_u i64.trunc_sat_f64_s i64.trunc_sat_f64_u"),
    ...seq(0xFC008, "u", "memory.init:uu data.drop memory.copy:uu memory.fill table.init:uu elem.drop table.copy:uu table.grow table.size table.fill"),
    ...seq(0xFD000, "m", "v128.load v128.load8x8_s v128.load8x8_u v128.load16x4_s v128.load16x4_u v128.load32x2_s v128.load32x2_u v128.load8_splat v128.load16_splat v128.load32_splat v128.load64_splat v128.store"),
    ["v128.const", 0xFD00C, "v128"], ["i8x16.shuffle", 0xFD00D, "shuf"],
    ...seq(0xFD00E, "", "i8x16.swizzle i8x16.splat i16x8.splat i32x4.splat i64x2.splat f32x4.splat f64x2.splat"),
    ...seq(0xFD015, "l", ["i8x16.extract_lane_s i8x16.extract_lane_u i8x16.replace_lane i16x8.extract_lane_s i16x8.extract_lane_u i16x8.replace_lane",
      ...["i32x4", "i64x2", "f32x4", "f64x2"].map(t => `${t}.extract_lane ${t}.replace_lane`)].join(" ")),
    ...seq(0xFD023, "", [...["i8x16", "i16x8", "i32x4"].flatMap(t => icmp.split(" ").map(o => `${t}.${o}`)), ...["f32x4", "f64x2"].flatMap(t => fcmp.split(" ").map(o => `${t}.${o}`)),
      "v128.not v128.and v128.andnot v128.or v128.xor v128.bitselect v128.any_true"].join(" ")),
    ...seq(0xFD054, "ml", "v128.load8_lane v128.load16_lane v128.load32_lane v128.load64_lane v128.store8_lane v128.store16_lane v128.store32_lane v128.store64_lane v128.load32_zero:m v128.load64_zero:m"),
    ...seq(0xFD05E, "", `f32x4.demote_f64x2_zero f64x2.promote_low_f32x4 i8x16.abs i8x16.neg i8x16.popcnt i8x16.all_true i8x16.bitmask i8x16.narrow_i16x8_s i8x16.narrow_i16x8_u
      f32x4.ceil f32x4.floor f32x4.trunc f32x4.nearest i8x16.shl i8x16.shr_s i8x16.shr_u i8x16.add i8x16.add_sat_s i8x16.add_sat_u i8x16.sub i8x16.sub_sat_s i8x16.sub_sat_u
      f64x2.ceil f64x2.floor i8x16.min_s i8x16.min_u i8x16.max_s i8x16.max_u f64x2.trunc i8x16.avgr_u i16x8.extadd_pairwise_i8x16_s i16x8.extadd_pairwise_i8x16_u
      i32x4.extadd_pairwise_i16x8_s i32x4.extadd_pairwise_i16x8_u i16x8.abs i16x8.neg i16x8.q15mulr_sat_s i16x8.all_true i16x8.bitmask i16x8.narrow_i32x4_s i16x8.narrow_i32x4_u
      i16x8.extend_low_i8x16_s i16x8.extend_high_i8x16_s i16x8.extend_low_i8x16_u i16x8.extend_high_i8x16_u i16x8.shl i16x8.shr_s i16x8.shr_u i16x8.add i16x8.add_sat_s
      i16x8.add_sat_u i16x8.sub i16x8.sub_sat_s i16x8.sub_sat_u f64x2.nearest i16x8.mul i16x8.min_s i16x8.min_u i16x8.max_s i16x8.max_u - i16x8.avgr_u
      i16x8.extmul_low_i8x16_s i16x8.extmul_high_i8x16_s i16x8.extmul_low_i8x16_u i16x8.extmul_high_i8x16_u i32x4.abs i32x4.neg - i32x4.all_true i32x4.bitmask - -
      i32x4.extend_low_i16x8_s i32x4.extend_high_i16x8_s i32x4.extend_low_i16x8_u i32x4.extend_high_i16x8_u i32x4.shl i32x4.shr_s i32x4.shr_u i32x4.add - - i32x4.sub - - -
      i32x4.mul i32x4.min_s i32x4.min_u i32x4.max_s i32x4.max_u i32x4.dot_i16x8_s - i32x4.extmul_low_i16x8_s i32x4.extmul_high_i16x8_s i32x4.extmul_low_i16x8_u
      i32x4.extmul_high_i16x8_u i64x2.abs i64x2.neg - i64x2.all_true i64x2.bitmask - - i64x2.extend_low_i32x4_s i64x2.extend_high_i32x4_s i64x2.extend_low_i32x4_u
      i64x2.extend_high_i32x4_u i64x2.shl i64x2.shr_s i64x2.shr_u i64x2.add - - i64x2.sub - - - i64x2.mul i64x2.eq i64x2.ne i64x2.lt_s i64x2.gt_s i64x2.le_s i64x2.ge_s
      i64x2.extmul_low_i32x4_s i64x2.extmul_high_i32x4_s i64x2.extmul_low_i32x4_u i64x2.extmul_high_i32x4_u
      ${["f32x4", "f64x2"].map(t => "abs neg - sqrt add sub mul div min max pmin pmax".split(" ").map(o => o === "-" ? o : `${t}.${o}`).join(" ")).join(" ")}
      i32x4.trunc_sat_f32x4_s i32x4.trunc_sat_f32x4_u f32x4.convert_i32x4_s f32x4.convert_i32x4_u i32x4.trunc_sat_f64x2_s_zero i32x4.trunc_sat_f64x2_u_zero
      f64x2.convert_low_i32x4_s f64x2.convert_low_i32x4_u i8x16.relaxed_swizzle i32x4.relaxed_trunc_f32x4_s i32x4.relaxed_trunc_f32x4_u i32x4.relaxed_trunc_f64x2_s_zero
      i32x4.relaxed_trunc_f64x2_u_zero f32x4.relaxed_madd f32x4.relaxed_nmadd f64x2.relaxed_madd f64x2.relaxed_nmadd i8x16.relaxed_laneselect i16x8.relaxed_laneselect
      i32x4.relaxed_laneselect i64x2.relaxed_laneselect f32x4.relaxed_min f32x4.relaxed_max f64x2.relaxed_min f64x2.relaxed_max i16x8.relaxed_q15mulr_s
      i16x8.relaxed_dot_i8x16_i7x16_s i32x4.relaxed_dot_i8x16_i7x16_add_s`),
    ["memory.atomic.notify", 0xFE000, "m", "atomic.notify"], ["memory.atomic.wait32", 0xFE001, "m", "i32.atomic.wait"], ["memory.atomic.wait64", 0xFE002, "m", "i64.atomic.wait"],
    ["atomic.fence", 0xFE003, "z"],
    ...seq(0xFE010, "m", "i32.atomic.load i64.atomic.load i32.atomic.load8_u i32.atomic.load16_u i64.atomic.load8_u i64.atomic.load16_u i64.atomic.load32_u " +
      "i32.atomic.store i64.atomic.store i32.atomic.store8 i32.atomic.store16 i64.atomic.store8 i64.atomic.store16 i64.atomic.store32 " + rmw.join(" ")),
  ];
  const legacy = n => {
    const m = !n.includes("_sat") && /^(\w+)\.(\w+?)_([if](?:32|64))(?:_([su]))?$/.exec(n);
    return m ? `${m[1]}.${m[2]}${m[4] ? "_" + m[4] : ""}/${m[3]}` : undefined;
  };
  let next = 0x45;
  const TABLE = OPS.map(e => typeof e === "string" ? [e, next++, ""] : e).map(([n, c, k, a]) => [n, c, k, a ?? (c < 0x100 ? legacy(n) : undefined)]);
  const BY_CODE = new Map(TABLE.map(e => [e[1], e]));
  const BY_NAME = new Map();
  for (const e of TABLE) for (const n of [e[0], e[3]]) if (n) BY_NAME.set(n, [...BY_NAME.get(n) ?? [], e]);
  const opBytes = c => c > 0xFF ? [c >> 12, ...leb.u32(c & 0xFFF)] : [c];

  const int = (tok, lo, hi) => {
    const m = /^(-?)(0x[0-9a-f]+|\d+)$/i.exec(tok);
    const v = m && BigInt(m[2]) * (m[1] ? -1n : 1n);
    if (!m || v < lo || v > hi) throw new Error(`Invalid integer: ${tok}`);
    return v;
  };
  const u32 = tok => leb.u32(Number(int(tok, 0n, 0xFFFFFFFFn)));
  const lane = tok => [Number(int(tok, 0n, 255n))];
  const le = (v, n) => Array.from({ length: n }, (_, i) => Number(BigInt.asUintN(8 * n, v) >> BigInt(8 * i) & 0xFFn));
  const FLOAT = { f32: [4, "Float32", "Uint32", 23n], f64: [8, "Float64", "BigUint64", 52n] };
  const fmtFloat = (dv, t) => {
    const [, get, bitsGet, mant] = FLOAT[t], v = dv["get" + get](0, true);
    if (!Number.isNaN(v)) return Object.is(v, -0) ? "-0" : v === Infinity ? "inf" : v === -Infinity ? "-inf" : String(v);
    const bits = BigInt(dv["get" + bitsGet](0, true)), payload = bits & (1n << mant) - 1n;
    return (bits >> mant + (t === "f32" ? 8n : 11n) ? "-" : "") + "nan" + (payload === 1n << mant - 1n ? "" : ":0x" + payload.toString(16));
  };
  const floatBytes = (tok, t) => {
    const [size, set, bitsSet, mant] = FLOAT[t], dv = new DataView(new ArrayBuffer(size)), n = /^(-?)nan(?::0x([0-9a-f]+))?$/i.exec(tok);
    if (n) {
      const payload = n[2] ? BigInt("0x" + n[2]) : 1n << mant - 1n, exp = t === "f32" ? 0xFFn : 0x7FFn;
      if (!payload || payload >> mant) throw new Error(`Invalid NaN payload: ${tok}`);
      const bits = (n[1] ? 1n : 0n) << mant + (t === "f32" ? 8n : 11n) | exp << mant | payload;
      dv["set" + bitsSet](0, t === "f32" ? Number(bits) : bits, true);
    } else {
      const v = /^-?inf$/i.test(tok) ? (tok[0] === "-" ? -Infinity : Infinity) : /^[-+]?(\d|\.\d|Infinity)/.test(tok) ? Number(tok) : NaN;
      if (Number.isNaN(v)) throw new Error(`Invalid float: ${tok}`);
      dv["set" + set](0, v, true);
    }
    return [...new Uint8Array(dv.buffer)];
  };
  const valtype = (map, tok) => {
    if (!Object.hasOwn(map, tok)) throw new Error(`Invalid type: ${tok}`);
    return map[tok];
  };
  const refText = (nul, ht) => `(ref ${nul ? "null " : ""}${ht})`;
  const readHT = r => {
    if (Object.hasOwn(HTN, r.peek())) return HTN[r.byte()];
    const v = r.s64();
    if (v < 0n || v > 0xFFFFFFFFn) throw new Error("Invalid heap type");
    return String(v);
  };
  const readVT = r => {
    const b = r.byte();
    return b === 0x63 || b === 0x64 ? refText(b === 0x63, readHT(r)) : valtype(VTN, b);
  };
  const htBytes = tok => Object.hasOwn(HT, tok) || !/^(0x[0-9a-f]+|\d+)$/i.test(tok) ? [valtype(HT, tok)] : leb.s64(int(tok, 0n, 0xFFFFFFFFn));
  const refType = tok => {
    const m = /^\(ref (null )?([^ ]+)\)$/.exec(tok);
    if (m) return [!!m[1], htBytes(m[2])];
    if (!Object.hasOwn(HTN, valtype(VT, tok))) throw new Error(`Invalid reference type: ${tok}`);
    return [true, [VT[tok]]];
  };
  const vtBytes = tok => {
    if (tok[0] !== "(") return [valtype(VT, tok)];
    const [nul, ht] = refType(tok);
    return [nul ? 0x63 : 0x64, ...ht];
  };
  const refImm = nul => [r => [refText(nul, readHT(r))], t => {
    const [n, ht] = refType(t.next());
    if (n !== nul) throw new Error(`Expected ${refText(nul, "<heap type>")}`);
    return ht;
  }];
  const memarg = r => {
    const flags = r.u();
    if (flags >= 0x80) throw new Error("Invalid alignment");
    const mem = flags & 0x40 ? [`memory=${r.u()}`] : [];
    return [`align=${flags & 0x3F}`, `offset=${r.u64()}`, ...mem];
  };
  const memargBytes = t => {
    const kv = [t.next(), t.next()].map(tok => /^(align|offset)=(.*)$/.exec(tok) ?? [, tok]);
    if (kv[0][1] !== "align" || kv[1][1] !== "offset") throw new Error("Expected align=N offset=N");
    const mem = /^memory=(.*)$/.exec(t.peek() ?? ""), align = Number(int(kv[0][2], 0n, 63n));
    if (mem) t.next();
    return [...leb.u32(mem ? align | 0x40 : align), ...mem ? u32(mem[1]) : [], ...leb.u64(int(kv[1][2], 0n, 2n ** 64n - 1n))];
  };
  const SHAPE = { i8x16: [16, 1], i16x8: [8, 2], i32x4: [4, 4], i64x2: [2, 8], f32x4: [4, "f32"], f64x2: [2, "f64"] };
  const CATCH = ["catch", "catch_ref", "catch_all", "catch_all_ref"];

  const IMM = {
    "": [() => [], () => []],
    u: [r => [r.u()], t => u32(t.next())],
    uu: [r => [r.u(), r.u()], t => [...u32(t.next()), ...u32(t.next())]],
    bt: [r => {
      const b = r.peek();
      if (b === 0x40) return r.byte(), [];
      if (Object.hasOwn(VTN, b) || b === 0x63 || b === 0x64) return [readVT(r)];
      const v = r.s64();
      if (v < 0n || v > 0xFFFFFFFFn) throw new Error("Invalid block type");
      return [v];
    }, t => {
      const tok = t.opt();
      return tok === undefined ? [0x40] : Object.hasOwn(VT, tok) || tok[0] === "(" ? vtBytes(tok) : leb.s64(int(tok, 0n, 0xFFFFFFFFn));
    }],
    brt: [r => {
      const n = r.count();
      return [n, ...Array.from({ length: n + 1 }, r.u)];
    }, t => {
      const n = t.next(), out = u32(n);
      for (let i = 0; i <= Number(int(n, 0n, 0xFFFFFFFFn)); i++) out.push(...u32(t.next()));
      return out;
    }],
    tt: [r => [...IMM.bt[0](r), ...Array.from({ length: r.count() }, () => {
      const k = r.byte();
      if (k > 3) throw new Error("Invalid catch kind");
      return [CATCH[k], ...k < 2 ? [r.u()] : [], r.u()].join(" ");
    })], t => {
      const bt = CATCH.includes(t.peek()) ? [0x40] : IMM.bt[1](t), out = [];
      let n = 0;
      for (let tok; (tok = t.opt()) !== undefined; n++) {
        const k = CATCH.indexOf(tok);
        if (k < 0) throw new Error(`Expected a catch clause: ${tok}`);
        out.push(k, ...k < 2 ? u32(t.next()) : [], ...u32(t.next()));
      }
      return [...bt, ...leb.u32(n), ...out];
    }],
    m: [memarg, memargBytes],
    ml: [r => [...memarg(r), r.byte()], t => [...memargBytes(t), ...lane(t.next())]],
    l: [r => [r.byte()], t => lane(t.next())],
    z: [r => { if (r.byte()) throw new Error("Expected a zero byte"); return []; }, () => [0]],
    shuf: [r => Array.from({ length: 16 }, r.byte), t => Array.from({ length: 16 }, () => lane(t.next())).flat()],
    v128: [r => ["i32x4", ...Array.from({ length: 4 }, () => toHex(r.view(4).getUint32(0, true)))], t => {
      const s = t.next(), [n, w] = Object.hasOwn(SHAPE, s) ? SHAPE[s] : [];
      if (!n) throw new Error(`Invalid shape: ${s}`);
      return Array.from({ length: n }, () => typeof w === "string" ? floatBytes(t.next(), w) : le(int(t.next(), -(2n ** BigInt(8 * w - 1)), 2n ** BigInt(8 * w) - 1n), w)).flat();
    }],
    i32: [r => [r.s32()], t => leb.s32(Number(BigInt.asIntN(32, int(t.next(), -(2n ** 31n), 2n ** 32n - 1n))))],
    i64: [r => [r.s64()], t => leb.s64(BigInt.asIntN(64, int(t.next(), -(2n ** 63n), 2n ** 64n - 1n)))],
    f32: [r => [fmtFloat(r.view(4), "f32")], t => floatBytes(t.next(), "f32")],
    f64: [r => [fmtFloat(r.view(8), "f64")], t => floatBytes(t.next(), "f64")],
    ht: [r => [readHT(r)], t => htBytes(t.next())],
    htr: refImm(false),
    htn: refImm(true),
    cast: [r => {
      const f = r.byte();
      if (f > 3) throw new Error("Invalid cast flags");
      return [r.u(), refText(f & 1, readHT(r)), refText(f & 2, readHT(r))];
    }, t => {
      const l = u32(t.next()), [n1, h1] = refType(t.next()), [n2, h2] = refType(t.next());
      return [n1 | n2 << 1, ...l, ...h1, ...h2];
    }],
    vt: [r => Array.from({ length: r.count() }, () => readVT(r)), t => {
      const out = [];
      let n = 0;
      for (let tok; (tok = t.opt()) !== undefined; n++) out.push(...vtBytes(tok));
      return [...leb.u32(n), ...out];
    }],
  };

  const disassemble = (bytes, locals = bytes.locals ?? []) => {
    const u8 = Uint8Array.from(bytes), lines = locals.length ? [{ offset: -1, text: `local ${locals.join(" ")}` }] : [];
    let pos = 0, depth = 0;
    const call = (fn, ...a) => { const [v, p] = fn(u8, pos, ...a); pos = p; return v; };
    const byte = () => {
      if (pos >= u8.length) throw new Error("Unexpected end of input");
      return u8[pos++];
    };
    const r = {
      byte, peek: () => u8[pos], u: () => call(leb.readU32), u64: () => call(leb.readU64), s32: () => call(leb.readS32), s64: () => call(leb.readS64),
      count: () => { const n = r.u(); if (n > u8.length) throw new Error("Count too large"); return n; },
      view: n => new DataView(Uint8Array.from({ length: n }, byte).buffer),
    };
    while (pos < u8.length) {
      const offset = pos;
      try {
        const pre = byte(), sub = pre >= 0xFB && pre <= 0xFE ? r.u() : null;
        const e = BY_CODE.get(sub === null ? pre : sub < 0x1000 ? pre * 0x1000 + sub : -1);
        if (!e) throw new Error(`Unsupported opcode ${toHex(pre, 2)}${sub === null ? "" : " " + sub}`);
        const ops = IMM[e[2]][0](r);
        if (MID.includes(e[1]) || CLOSE.includes(e[1])) depth--;
        lines.push({ offset, text: "  ".repeat(Math.max(depth, 0)) + [e[0], ...ops].join(" ") });
        if (MID.includes(e[1]) || OPEN.includes(e[1])) depth++;
      } catch (err) {
        throw new AsmError(`${err.message} at offset ${toHex(offset, 0)}`, null, offset);
      }
    }
    return { text: lines.map(l => l.text).join("\n"), lines };
  };

  const localType = tok => {
    if (tok[0] !== "(") return valtype(VT, tok), tok;
    const [nul, ht] = refType(tok);
    return refText(nul, ht.length === 1 && Object.hasOwn(HTN, ht[0]) ? HTN[ht[0]] : String(leb.readS64(ht, 0)[0]));
  };

  const assemble = text => {
    const out = [], locals = [];
    let depth = 0, closed = false, last = 0;
    String(text).split(/\r?\n/).forEach((raw, i) => {
      const line = raw.replace(/;;.*/, "").trim();
      if (!line) return;
      last = i + 1;
      try {
        if (line.includes("  ")) throw new Error("Empty operand");
        const [name, ...toks] = line.match(/\([^()]*\)|[^ ]+/g);
        if (name === "local") {
          if (out.length || locals.length) throw new Error("local must be a single line before the first instruction");
          if (!toks.length) throw new Error("Missing operand");
          return locals.push(...toks.map(localType));
        }
        const list = BY_NAME.get(name);
        if (!list) throw new Error(`Unknown mnemonic: ${name}`);
        let k, e, imm, first;
        const t = {
          peek: () => toks[k],
          opt: () => toks[k++],
          next: () => { if (k >= toks.length) throw new Error("Missing operand"); return toks[k++]; },
        };
        for (const c of list) {
          try {
            k = 0;
            imm = IMM[c[2]][1](t);
            if (k < toks.length) throw new Error(`Unexpected token: ${toks[k]}`);
            e = c;
            break;
          } catch (err) { first ??= err; }
        }
        if (!e) throw first;
        const code = e[1];
        if (closed) throw new Error(code === 0x0B ? "Unbalanced end" : "Instruction after the final end");
        if (MID.includes(code) && !depth) throw new Error(`${name} outside a block`);
        if (code === 0x18 && !depth) throw new Error("Unbalanced delegate");
        out.push(...opBytes(code), ...imm);
        if (OPEN.includes(code)) depth++;
        if (code === 0x18) depth--;
        if (code === 0x0B) depth ? depth-- : closed = true;
      } catch (err) {
        throw err instanceof AsmError ? err : new AsmError(err.message, i + 1);
      }
    });
    if (!closed) throw new AsmError("Missing end", Math.max(last, 1));
    return Object.defineProperty(Uint8Array.from(out), "locals", { value: locals });
  };
  assemble.opcodes = TABLE;

  const LANE = { i8x16: "i32", i16x8: "i32", i32x4: "i32", i64x2: "i64", f32x4: "f32", f64x2: "f64" };
  const zero = t => /^[if](32|64)$/.test(t) ? `${t}.const 0` : t === "v128" ? "v128.const i32x4 0 0 0 0"
    : /^\(ref null [^ ]+\)$/.test(t) ? `ref.null ${t.slice(10, -1)}` : Object.hasOwn(HTN, VT[t]) ? `ref.null ${HTN[VT[t]]}` : null;
  const effect = (name, [a, b], env) => {
    const [, t, op = ""] = /^([^.]+)\.?(.*)$/.exec(name), sig = s => s && [s.params.length, s.results];
    const pops = n => [n, []], scalar = /^[if](32|64)$/.test(t), vec = Object.hasOwn(LANE, t) || t === "v128";
    if (name === "nop" || name === "atomic.fence" || /^(data|elem)\.drop$/.test(name)) return pops(0);
    if (name === "drop" || name === "local.set" || name === "global.set") return pops(1);
    if (name === "local.get" || name === "local.tee") return [+(name === "local.tee"), [env.locals?.[a]]];
    if (name === "global.get") return [0, [env.globals?.[a]]];
    if (name === "call") return sig(env.funcs?.[a]);
    if (name === "call_indirect" || name === "call_ref") return (s => s && [s[0] + 1, s[1]])(sig(env.types?.[a]));
    if (name === "select" && a) return [3, [a]];
    if (name === "ref.null") return [0, [`(ref null ${a})`]];
    if (name === "ref.is_null" || name === "ref.eq") return [name === "ref.eq" ? 2 : 1, ["i32"]];
    if (name === "memory.size" || name === "table.size") return [0, ["i32"]];
    if (name === "memory.grow" || name === "table.grow") return [name === "table.grow" ? 2 : 1, ["i32"]];
    if (/^(memory|table)\.(fill|copy|init)$/.test(name)) return pops(3);
    if (name === "table.set") return pops(2);
    if (name === "memory.atomic.notify") return [2, ["i32"]];
    if (/^memory\.atomic\.wait/.test(name)) return [3, ["i32"]];
    if (/^v128\.store\d+_lane$/.test(name)) return pops(2);
    if (/^v128\.load\d+_lane$/.test(name)) return [2, ["v128"]];
    if (/(^|\.)store/.test(op)) return pops(2);
    if (/(^|\.)load/.test(op)) return [1, [t]];
    if (/^atomic\.rmw/.test(op)) return [/cmpxchg/.test(op) ? 3 : 2, [t]];
    if (op === "const") return [0, [t]];
    if (scalar) return op === "eqz" ? [1, ["i32"]] : /^(eq|ne|[lg][te])(_[su])?$/.test(op) ? [2, ["i32"]]
      : /^(add|sub|mul|div|rem|and|or|xor|shl|shr|rot|min|max|copysign)/.test(op) ? [2, [t]] : [1, [t]];
    if (!vec) return null;
    if (/^(any_true|all_true|bitmask)$/.test(op)) return [1, ["i32"]];
    if (op === "splat") return [1, ["v128"]];
    if (/^extract_lane/.test(op)) return [1, [LANE[t]]];
    if (/^(bitselect|relaxed_madd|relaxed_nmadd|relaxed_laneselect|relaxed_dot_i8x16_i7x16_add_s)$/.test(op)) return [3, ["v128"]];
    if (/^(not|abs|neg|popcnt|ceil|floor|trunc|nearest|sqrt|extend|extadd|convert|demote|promote|relaxed_trunc)/.test(op)) return [1, ["v128"]];
    return [2, ["v128"]];
  };
  const nop = (line, env = {}) => {
    const code = String(line).replace(/;;.*/, ""), pad = /^\s*/.exec(code)[0], [name, ...toks] = code.trim().match(/\([^()]*\)|[^ ]+/g) ?? [];
    const e = BY_NAME.get(name)?.[0], fx = e && effect(e[0], toks, env), push = fx?.[1]?.map(zero);
    if (!fx || !push || push.some(x => !x)) return null;
    const out = [...Array(fx[0]).fill("drop"), ...push];
    return (out.length ? out : ["nop"]).map(x => pad + x).join("\n");
  };

  Object.assign(globalThis.cetusLib ??= {}, { assemble, disassemble, AsmError, nop });
})();
