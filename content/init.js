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
  const L = globalThis.cetusLib ??= {};
  const W = WebAssembly, O = { Module: W.Module, Instance: W.Instance, compile: W.compile, instantiate: W.instantiate };
  const VT = { 0x7f: "i32", 0x7e: "i64", 0x7d: "f32", 0x7c: "f64", 0x7b: "v128" };
  const HT = { 0x74: "noexn", 0x73: "nofunc", 0x72: "noextern", 0x71: "none", 0x70: "func", 0x6f: "extern", 0x6e: "any", 0x6d: "eq", 0x6c: "i31", 0x6b: "struct", 0x6a: "array", 0x69: "exn" };
  const REF = { none: "nullref", nofunc: "nullfuncref", noextern: "nullexternref", noexn: "nullexnref" };
  const LOAD_SIZES = [4, 8, 4, 8, 1, 1, 2, 2, 1, 1, 2, 2, 4, 4], STORES = [[4, 0x7f], [8, 0x7e], [4, 0x7d], [8, 0x7c], [1, 0x7f], [2, 0x7f], [1, 0x7e], [2, 0x7e], [4, 0x7e]];
  const SIMD_LOADS = { 0: 16, 1: 8, 2: 8, 3: 8, 4: 8, 5: 8, 6: 8, 7: 1, 8: 2, 9: 4, 10: 8, 92: 4, 93: 8 };
  const ATOMIC_SIZES = [4, 8, 1, 2, 1, 2, 4], I = 0x7f, J = 0x7e;
  const AT = [[0x7b], [I], [J], [I, I], [J, J], [I, J]];
  const STEP_OPS = new Set([0x02, 0x03, 0x04, 0x05, 0x0c, 0x0d, 0x0e, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15]);
  const f64c = v => [0x44, ...new Uint8Array(Float64Array.of(v).buffer)];
  const rd = (u8, p) => { let v = 0, s = 0, b; do { b = u8[p++]; v += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return [v, p]; };
  const msg = e => String(e?.message ?? e);
  const find = (hay, pat, from) => {
    for (let i = hay.indexOf(pat[0], from); i >= 0; i = hay.indexOf(pat[0], i + 1)) {
      let j = 1;
      while (j < pat.length && hay[i + j] === pat[j]) j++;
      if (j === pat.length) return i;
    }
    return -1;
  };

  const valtype = (u8, p) => {
    const b = u8[p++];
    if (b !== 0x63 && b !== 0x64) return [VT[b] ?? (HT[b] ? REF[HT[b]] ?? `${HT[b]}ref` : "ref"), p];
    const [h, q] = HT[u8[p]] ? [HT[u8[p]], p + 1] : rd(u8, p);
    return [`(ref ${b === 0x63 ? "null " : ""}${h})`, q];
  };
  L.valtype = valtype;
  const CODES = new Map([...Object.entries(VT), ...Object.entries(HT).map(([k, h]) => [k, REF[h] ?? `${h}ref`])]
    .map(([k, n]) => [n, [+k]]));
  const HEAPS = new Map(Object.entries(HT).map(([k, h]) => [h, [+k]]));
  const vtBytes = t => {
    const m = /^\(ref (null )?(\w+)\)$/.exec(t);
    const h = m && (HEAPS.get(m[2]) ?? (/^\d+$/.test(m[2]) ? L.leb.s32(+m[2]) : null));
    const b = m ? h && [m[1] ? 0x63 : 0x64, ...h] : CODES.get(t);
    if (!b) throw new Error(`Invalid local type: ${t}`);
    return b;
  };
  const decls = ts => (Array.isArray(ts) ? ts : [])
    .reduce((g, t) => (g.at(-1)?.[1] === t ? g.at(-1)[0]++ : g.push([1, t]), g), [])
    .map(([c, t]) => [...L.leb.u32(c), ...vtBytes(t)]);

  const scan = u8 => {
    const m = { funcImports: 0, globals: [], exports: new Set(), mems: [], types: [], funcs: [],
      fn: {}, gl: {}, tables: {}, elems: [], refs: [], dataRanges: [], names: { functions: {}, globals: {} } };
    let p = 8;
    const num = () => { const [v, n] = rd(u8, p); p = n; return v; };
    const name = () => { const n = num(); return new TextDecoder().decode(u8.subarray(p, p += n)); };
    const limits = () => { const f = u8[p++]; num(); if (f & 1) num(); return f & 4 ? { i64: true } : {}; };
    const gc = k => ((k < 2 || k > 5 && k < 9) && num(), k === 8 && num());
    const expr = () => { for (let op; (op = u8[p++]) !== 0x0b;) op === 0x43 ? p += 4 : op === 0x44 ? p += 8 : op === 0xfd ? (num(), p += 16) : op === 0xfb ? gc(num()) : [0x41, 0x42, 0x23, 0xd2, 0xd0].includes(op) && num(); };
    const vt = () => { const [t, q] = valtype(u8, p); p = q; return t; };
    const konst = (op, where) => {
      const c = u8[p], v = c !== op ? null : op === 0x41 ? L.leb.readS32(u8, p + 1)[0] >>> 0
        : op === 0x42 ? Number(L.leb.readS64(u8, p + 1)[0]) : rd(u8, p + 1)[0];
      const [key, ins] = c === 0x23 ? ["global", "global.get"] : ["func", "ref.func"];
      if (where && (c === 0x23 || c === 0xd2)) m.refs.push({ [key]: rd(u8, p + 1)[0], where, op: ins });
      expr();
      return v;
    };
    while (p < u8.length) {
      const id = u8[p++], size = num(), end = p + size;
      if (id === 0 && name() === "name") while (p < end) {
        const sub = u8[p++], e = num() + p, map = { 1: m.names.functions, 7: m.names.globals }[sub];
        if (map) for (let n = num(); n--;) { const i = num(); map[i] = name(); }
        p = e;
      }
      else if (id === 1) for (let n = num(); n--;) for (let k = u8[p] === 0x4e ? (p++, num()) : 1; k--;) {
        let form = u8[p++];
        if (form === 0x50 || form === 0x4f) {
          for (let s = num(); s--;) num();
          form = u8[p++];
        }
        const list = () => Array.from({ length: num() }, vt);
        if (form === 0x60) m.types.push({ params: list(), results: list() });
        else {
          m.types.push(null);
          for (let f = form === 0x5f ? num() : 1; f--; p++) vt();
        }
      }
      else if (id === 2) for (let n = num(); n--;) {
        const module = name(), field = name(), kind = u8[p++];
        if (kind === 0) { m.funcs.push(num()); m.funcImports++; }
        else if (kind === 1) { vt(); limits(); }
        else if (kind === 2) m.mems.push({ index: m.mems.length, import: { module, field }, exports: [], ...limits() });
        else if (kind === 3) m.globals.push({ type: vt(), mutable: !!(u8[p++] & 1), import: { module, field } });
        else { p++; num(); }
      }
      else if (id === 3) for (let n = num(); n--;) m.funcs.push(num());
      else if (id === 5) for (let n = num(); n--;) m.mems.push({ index: m.mems.length, exports: [], ...limits() });
      else if (id === 6) for (let n = num(); n--;) { m.globals.push({ type: vt(), mutable: !!(u8[p++] & 1) }); konst(-1, `global ${m.globals.length - 1} =`); }
      else if (id === 7) for (let n = num(); n--;) {
        const f = name(), kind = u8[p++], index = num();
        m.exports.add(f);
        const map = [m.fn, m.tables, null, m.gl][kind];
        if (map) map[index] ??= f;
        if (kind === 2) m.mems[index]?.exports.push(f);
      }
      else if (id === 8) m.refs.push({ func: num(), where: "start" });
      else if (id === 9) for (let n = num(), s = 0; n--; s++) {
        const f = num(), table = (f & 3) === 2 ? num() : 0, offset = f & 1 ? null : konst(0x41, `elem ${s} offset`);
        if (f & 3) vt();
        for (let k = 0, c = num(); k < c; k++) {
          const func = f & 4 ? konst(0xd2) : num();
          if (offset != null && func != null) m.elems.push({ table, slot: offset + k, func });
          const kind = f & 1 ? f & 2 ? "declare" : "passive" : `table ${table} slot ${offset == null ? "?" : offset + k}`;
          if (func != null) m.refs.push({ func, where: `elem ${s} ${kind}` });
        }
      }
      else if (id === 11) for (let n = num(), s = 0; n--; s++) {
        const f = num(), mi = f === 2 ? num() : 0;
        const start = f === 1 ? null : konst(u8[p] === 0x42 ? 0x42 : 0x41, `data ${s} offset`), len = num();
        if (start != null) m.dataRanges.push([start, start + len, mi]);
        p += len;
      }
      p = end;
    }
    return m;
  };
  L.scan = scan;
  const cat = parts => {
    const o = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
    parts.reduce((i, x) => (o.set(x, i), i + x.length), 0);
    return o;
  };
  const splice = (u8, list, warnings) => {
    const body = p => Uint8Array.from(Object.values(p.bytes ?? []));
    const want = new Map(list.map(p => [Number(p.index), [body(p), decls(p.locals)]]));
    const imp = want.size ? scan(u8).funcImports : 0;
    let out = u8;
    for (let p = 8; want.size && p < u8.length;) {
      const [len, q] = rd(u8, p + 1), end = q + len;
      if (u8[p] !== 10) { p = end; continue; }
      let [n, r] = rd(u8, q);
      const parts = [L.leb.u32(n)];
      for (let k = imp; n--; k++) {
        const [size, s] = rd(u8, r), [body, add = []] = want.get(k) ?? [], [locals, g] = rd(u8, s);
        let t = g;
        for (let i = locals; i--;) t = valtype(u8, rd(u8, t)[1])[1];
        const decl = add.length ? cat([L.leb.u32(locals + add.length), u8.subarray(g, t), ...add]) : u8.subarray(s, t);
        parts.push(...body ? [L.leb.u32(decl.length + body.length), decl, body] : [u8.subarray(r, s + size)]);
        want.delete(k);
        r = s + size;
      }
      const sec = cat(parts);
      out = cat([u8.subarray(0, p), [10], L.leb.u32(sec.length), sec, u8.subarray(end)]);
      break;
    }
    for (const k of want.keys()) warnings.push(`Patch for function ${k} skipped: no such function`);
    return out;
  };
  const memories = (m, unique) => m.mems.map(({ index, import: im, exports: [name], i64 }) => ({ ...im ? { index, kind: "import", ...im }
    : name != null ? { index, kind: "export", name }
    : { index, kind: "internal", ...unique && { name: unique(index ? `__cetus_memory${index}` : "__cetus_memory") } }, ...i64 && { i64 } }));

  L.instrument = (bytes, { patches = [], processors = [], precise = false, trace = [], globalWatch = [],
    coverage = false, breakpoints = [], stepTrace = [], warnings = [] } = {}) => {
    const input = splice(bytes, patches.filter(p => p?.space === "original"), warnings);
    const m = scan(bytes), w = new WailParser(), leb = L.leb, adj = i => +i < m.funcImports ? +i : +i + 2;
    if (!m.mems.length) throw new Error("Module has no memory");
    const T = k => m.mems[k]?.i64 ? J : I, A = T(0), xt = t => t === J ? [] : [0xad], ext = xt(A), narrow = A === J ? [] : [0xa7];
    const names = new Set(m.exports), unique = n => { let s = n; for (let i = 1; names.has(s); i++) s = `${n}_${i}`; names.add(s); return s; };
    const type = (params, returnType) => w.addTypeEntry({ form: "func", params, returnType });
    const [iRead, iWrite] = ["read", "write"].map(fieldStr => w.addImportEntry({ moduleStr: "__cetus", fieldStr, kind: "func", type: type(["i32", "i32", "f64"]) }));
    const fn = t => w.addFunctionEntry({ type: t });
    const fRead = fn(type([A, I, I, I], [A])), fWrite = fn(type([])), fLoad = fn(type([A, I], [J])), fWatch = fn(type([I, A, I, I])), fArm = fn(type([I, I]));
    const glob = (t, v = 0) => w.addGlobalEntry({ globalType: { contentType: t, mutability: true }, initExpr: [t === "i64" ? 0x42 : 0x41, v & 0x7f, 0x0b] });
    const idx = v => v.varUint32(), anyWrite = glob("i32"), anyRead = idx(glob("i32")), anySite = idx(glob("i32"));
    const slots = [0, 1, 2, 3].map(s => ({ s, a: idx(glob(A === J ? "i64" : "i32")), n: idx(glob("i32")), f: idx(glob("i32")), v: idx(glob("i64")) }));
    const armed = [0, 1, 2, 3].map(() => idx(glob("i32", -1))), f64z = [0x44, 0, 0, 0, 0, 0, 0, 0, 0];
    const over = (a, n, size, e) => [0x20, e, 0x23, a, ...ext, 0x23, n, 0xad, 0x7c, 0x54,
      0x23, a, ...ext, 0x20, e, ...size, 0x7c, 0x54, 0x71];
    const slotHits = (imp, bit, size, e = 4) => slots.flatMap(({ s, a, n, f }) => [...over(a, n, size, e),
      0x23, f, 0x41, bit, 0x76, 0x71, 0x04, 0x40, 0x41, s, 0x20, e, 0xa7, ...f64z, 0x10, idx(imp), 0x0b]);
    const siteHits = (imp, addr, site = 3) => [0x23, anySite, 0x04, 0x40, ...armed.flatMap(g =>
      [0x20, site, 0x23, g, 0x46, 0x04, 0x40, 0x41, 0x7f, ...addr, 0x20, site, 0xb7, 0x10, idx(imp), 0x0b]), 0x0b];
    const when = (m, bit, code) => [0x20, m, 0x41, bit, 0x71, 0x04, 0x40, ...code, 0x0b];
    const inMem = (addr, e, size, code) => [...addr, 0x22, e, ...size, 0x7c,
      0x3f, 0, ...ext, 0x42, 16, 0x86, 0x58, 0x04, 0x40, ...code, 0x0b];
    const slotsOf = (bit, e, size) => [0x23, bit === 1 ? idx(anyWrite) : anyRead, 0x04, 0x40,
      ...slotHits(bit === 1 ? iWrite : iRead, 3 - bit, size, e), 0x0b];
    const ats = new Map(AT.map(t => {
      const ops = [A, ...t], n = ops.length, size = [0x20, n, 0xad], e = n + 4, f = fn(type([...ops, I, I, I, I], ops));
      const hits = [...when(n + 1, 1, slotsOf(1, e, size)), ...when(n + 1, 2, slotsOf(2, e, size)), ...siteHits(iRead, [0x20, e, 0xa7], n + 3)];
      w.addCodeEntry(f, { locals: ["i64"], code: [...inMem([0x20, 0, ...ext, 0x20, n + 2, 0xad, 0x7c], e, size, hits),
        ...ops.flatMap((_, i) => [0x20, i]), 0x0b] });
      return [String(ops), f];
    }));
    const ts = [...new Set([I, ...m.mems.map((_, k) => T(k))])], shapes = ts.flatMap(d => ts.flatMap(s => ts.map(n => [d, s, n])));
    const ranges = new Map(shapes.map(sh => {
      const f = fn(type([...sh, I, I], sh)), len = [0x20, 2, ...xt(sh[2])];
      const part = bit => when(3, bit, inMem([0x20, bit - 1, ...xt(sh[bit - 1])], 5, len, [...slotsOf(bit, 5, len), ...siteHits(iRead, [0x20, 5, 0xa7], 4)]));
      w.addCodeEntry(f, { locals: ["i64"], code: [...part(1), ...part(2), 0x20, 0, 0x20, 1, 0x20, 2, 0x0b] });
      return [String(sh), f];
    }));

    const eff = [0x20, 0, ...ext, 0x20, 2, 0xad, 0x7c];
    w.addCodeEntry(fRead, { locals: ["i64"], code: [0x23, anyRead, 0x04, 0x40, ...eff, 0x21, 4, ...slotHits(iRead, 1, [0x20, 1, 0xad]), 0x0b,
      ...siteHits(iRead, [...eff, 0xa7]), 0x20, 0, 0x0b] });
    w.addCodeEntry(fWrite, { locals: ["i64"], code: [...slots.flatMap(({ s, a, n, f, v }) => [0x23, f, 0x41, 1, 0x71, 0x04, 0x40,
      0x23, a, 0x23, n, 0x10, idx(fLoad), 0x22, 0, 0x23, v, 0x52, 0x04, 0x40, 0x20, 0, 0x24, v, 0x41, s, 0x23, a, ...A === J ? [0xa7] : [], ...f64z, 0x10, idx(iWrite), 0x0b, 0x0b]), 0x0b] });
    w.addCodeEntry(fLoad, { locals: [], code: [...[[8, 0x29], [4, 0x35], [2, 0x33]].flatMap(([n, op]) => [0x20, 1, 0x41, n, 0x46, 0x04, 0x7e, 0x20, 0, op, 0, 0, 0x05]),
      0x20, 0, 0x31, 0, 0, 0x0b, 0x0b, 0x0b, 0x0b] });
    w.addCodeEntry(fWatch, { locals: [], code: [...slots.flatMap(({ s, a, n, f, v }) => [0x20, 0, 0x41, s, 0x46, 0x04, 0x40, 0x20, 1, 0x24, a, 0x20, 2, 0x24, n,
      0x20, 3, 0x24, f, 0x20, 3, 0x04, 0x40, 0x20, 1, 0x20, 2, 0x10, idx(fLoad), 0x24, v, 0x0b, 0x0b]),
      0x23, slots[0].f, ...slots.slice(1).flatMap(({ f }) => [0x23, f, 0x72]), 0x22, 0, 0x41, 5, 0x71, 0x24, idx(anyWrite), 0x20, 0, 0x41, 2, 0x71, 0x24, anyRead, 0x0b] });
    w.addCodeEntry(fArm, { locals: [], code: [...armed.flatMap((g, k) => [0x20, 0, 0x41, k, 0x46, 0x04, 0x40, 0x20, 1, 0x24, g, 0x0b]),
      0x23, armed[0], ...armed.slice(1).flatMap(g => [0x23, g, 0x71]), 0x41, 0x7f, 0x47, 0x24, anySite, 0x0b] });
    const stores = new Map(precise ? [...STORES.map(([size, t], i) => [0x36 + i, size, t, [0x36 + i, 0, 0]]), [0xfd, 16, 0x7b, [0xfd, 0x0b, 0, 0]]].map(([op, size, t, code]) => {
      const f = fn(type([A, t, I, I])), wraps = A === J ? [0x20, 0, 0x54] : [0x42, 32, 0x88, 0xa7];
      w.addCodeEntry(f, { locals: ["i64"], code: [...eff, 0x22, 4, ...wraps, 0x04, 0x40, 0x00, 0x0b,
        0x23, idx(anyWrite), 0x04, 0x40, ...slotHits(iWrite, 2, [0x42, size]), 0x0b, ...siteHits(iWrite, [0x20, 4, 0xa7]), 0x20, 4, ...narrow, 0x20, 1, ...code, 0x0b] });
      return [op, f];
    }) : []);

    w.addExportEntry(fWatch, { fieldStr: unique("__cetus_watch"), kind: "func" });
    w.addExportEntry(fArm, { fieldStr: unique("__cetus_arm"), kind: "func" });
    const mems = memories(m, unique), { index: _, ...memory } = mems[0];
    for (const x of mems) if (x.kind === "internal") w.addExportEntry(x.index, { fieldStr: x.name, kind: "memory" });
    const globals = m.globals.map(({ type: t, mutable }, index) => ({ index, type: t, mutable }));
    for (const g of globals) w.addExportEntry(g.index, { fieldStr: g.name = unique(`__cetus_g${g.index}`), kind: "global" });

    const cov = coverage ? m.funcs.slice(m.funcImports).map((_, k) => {
      const g = glob("i32"), field = unique(`__cetus_cov${k + m.funcImports + 2}`);
      w.addExportEntry(g, { fieldStr: field, kind: "global" });
      return { func: k + m.funcImports + 2, g, field };
    }) : [];
    const fexports = m.funcs.slice(m.funcImports).map((_, k) => {
      const field = unique(`__cetus_f${k + m.funcImports + 2}`);
      w.addExportEntry(w.getFunctionIndex(k + m.funcImports), { fieldStr: field, kind: "func" });
      return { func: k + m.funcImports + 2, field };
    });
    const bump = g => [0x23, ...leb.u32(g), 0x41, 1, 0x6a, 0x24, ...leb.u32(g)];
    const unbump = b => {
      const [g, q] = b[0] === 0x23 ? rd(b, 1) : [-1, 0];
      const hit = g >= m.globals.length && b[q] === 0x41 && b[q + 1] === 1 && b[q + 2] === 0x6a && b[q + 3] === 0x24;
      return hit && rd(b, q + 4)[0] === g ? b.slice(rd(b, q + 4)[1]) : b;
    };
    const legacy = patches.filter(p => p?.space !== "original");
    const sites = [], pend = [], traced = new Set(trace.map(Number));
    const patched = new Map(legacy.map(({ index, bytes: b }) => [Number(index), b]));
    const memarg = (b, p) => { let [align, q] = rd(b, p); if (align & 0x40) q = rd(b, q)[1]; return rd(b, q)[0] | 0; };
    const other = (b, p) => {
      const [align, q] = rd(b, p), [k, r] = align & 0x40 ? rd(b, q) : [0, q];
      return k > 0 || rd(b, r)[0] >= 2 ** 32;
    };
    const mark = (off, helper, op) => {
      const pre = [0x41, ...leb.s32(off), 0x41, ...leb.s32(sites.length)];
      pend.push({ id: sites.length, pat: [...pre, 0x10, ...leb.u32(helper.value)], at: pre.length });
      sites.push({ func: null, offset: null, ...op && { op } });
      return pend.at(-1).pat;
    };
    const after = () => [0x23, ...leb.u32(anyWrite.value), 0x04, 0x40, 0x10, ...leb.u32(fWrite.value), 0x0b];
    const store = (b, op, p) => other(b, p) ? b
      : precise ? [...mark(memarg(b, p), stores.get(op), op), ...after()] : [...b, ...after()];
    const at = (ops, size, m, b, p) => [0x41, size, 0x41, m, ...mark(memarg(b, p), ats.get(String(ops))), ...b];
    const put = (ops, size, read, b, p) => other(b, p) ? b : precise ? at(ops, size, read ? 3 : 1, b, p)
      : read ? [...at(ops, size, 2, b, p), ...after()] : [...b, ...after()];
    for (let op = 0x28; op <= 0x35; op++) w.addInstructionParser(op, b => other(b, 1) ? b : [0x41, LOAD_SIZES[b[0] - 0x28], ...mark(memarg(b, 1), fRead), ...b]);
    for (let op = 0x36; op <= 0x3e; op++) w.addInstructionParser(op, b => store(b, b[0], 1));
    w.addInstructionParser(0xfd, b => {
      const [sub, p] = rd(b, 1);
      if (sub >= 0x54 && sub <= 0x5b) return sub > 0x57 ? put([A, 0x7b], 1 << (sub - 0x54) % 4, false, b, p)
        : other(b, p) ? b : at([A, 0x7b], 1 << (sub - 0x54) % 4, 2, b, p);
      return sub in SIMD_LOADS && !other(b, p) ? [0x41, SIMD_LOADS[sub], ...mark(memarg(b, p), fRead), ...b] : sub === 0x0b ? store(b, 0xfd, p) : b;
    });
    w.addInstructionParser(0xfe, b => {
      const [sub, p] = rd(b, 1), k = (sub - 0x10) % 7, t = [0, 2, 3].includes(k) ? I : J;
      if (sub === 1 || sub === 2) return other(b, p) ? b : at([A, sub === 1 ? I : J, J], sub * 4, 2, b, p);
      if (sub < 0x10 || sub > 0x4e || other(b, p)) return b;
      if (sub < 0x17) return [0x41, ATOMIC_SIZES[k], ...mark(memarg(b, p), fRead), ...b];
      return put(sub < 0x48 ? [A, t] : [A, t, t], ATOMIC_SIZES[k], sub > 0x1d, b, p);
    });
    w.addInstructionParser(0xfc, b => {
      const [sub, p] = rd(b, 1);
      if (![8, 10, 11].includes(sub)) return b;
      const [x, q] = rd(b, p), y = sub === 11 ? null : rd(b, q)[0], dst = sub === 8 ? y : x;
      const k = (precise && !dst) | (sub === 10 && !y) << 1, n = sub === 10 && T(x) === J && T(y) === J ? J : I;
      const sh = sub === 11 ? [T(x), I, T(x)] : sub === 8 ? [T(y), I, I] : [T(x), T(y), n];
      return [...k ? mark(k, ranges.get(String(sh))) : [], ...b, ...!precise && !dst ? after() : []];
    });
    const types = m.funcs.map(t => m.types[t] ?? null);
    types.splice(m.funcImports, 0, ...Array(2).fill({ params: ["i32", "i32", "f64"], results: [] }));
    const conv = { i32: [0xb7], i64: [0xb9], f32: [0xbb], f64: [] };
    const watched = [...new Set(globalWatch.map(Number))].filter(g => conv[m.globals[g]?.type] && m.globals[g].mutable);
    const gw = new Map(watched.map(g => {
      const f = fn(type([])), get = [0x23, ...leb.u32(g), ...conv[m.globals[g].type]];
      w.addCodeEntry(f, { locals: [], code: [0x41, 0x7c, 0x41, ...leb.s32(g), ...get, 0x10, idx(iWrite), 0x0b] });
      return [g, f];
    }));
    const bpIn = (Array.isArray(breakpoints) ? breakpoints : [])
      .filter(b => Number.isInteger(b?.func) && Number.isInteger(b.offset) && b.offset >= 0);
    const bpKey = ({ func, offset, break: k, locals: lo, condition: c }) =>
      [`${func}:${offset}`, { func, offset, ...k === true && { break: true }, ...lo === true && { locals: true },
        ...typeof c === "string" && c.trim() && { condition: c } }];
    const bps = [...new Map(bpIn.map(bpKey)).values()];
    const bpf = bps.map((_, k) => {
      const f = fn(type([]));
      w.addCodeEntry(f, { locals: [], code: [0x41, 0x7b, 0x41, ...leb.s32(k), ...f64z, 0x10, idx(iWrite), 0x0b] });
      return f;
    });
    const bodyLocals = () => {
      const out = new Map();
      for (let p = 8; p < input.length;) {
        const [len, q] = rd(input, p + 1), end = q + len;
        if (input[p] !== 10) { p = end; continue; }
        let [n, r] = rd(input, q);
        for (let k = m.funcImports + 2; n--; k++) {
          const [size, s] = rd(input, r), ts = [];
          let [g, t] = rd(input, s);
          while (g--) { const [c, u] = rd(input, t), [ty, v] = valtype(input, u); ts.push(...Array(c).fill(ty)); t = v; }
          out.set(k, ts);
          r = s + size;
        }
        break;
      }
      return out;
    };
    const lmap = bps.some(b => b.locals) ? bodyLocals() : null;
    const bpPre = k => bps[k].locals
      ? [...types[bps[k].func]?.params ?? [], ...lmap.get(bps[k].func) ?? []].flatMap((t, j) => conv[t]
        ? [0x41, 0x7a, 0x41, ...leb.s32(j), 0x20, ...leb.u32(j), ...conv[t], 0x10, ...leb.u32(iWrite.value)] : [])
      : [];
    const cap = n => Math.min(Math.max(Number.isInteger(n) ? n : 1000, 1), 10000);
    const spIn = [...new Map((Array.isArray(stepTrace) ? stepTrace : []).filter(s => Number.isInteger(s?.func))
      .map(s => [s.func, { func: s.func, max: cap(s.max) }])).values()];
    const sps = spIn.filter(s => s.func >= m.funcImports + 2 && s.func < m.funcs.length + 2
      || warnings.push(`Step trace skipped: no function ${s.func}`) && false);
    const spf = new Map(sps.map(({ func }) => {
      const f = fn(type([I]));
      w.addCodeEntry(f, { locals: [], code: [0x41, 0x79, 0x20, 0, ...f64c(func), 0x10, idx(iWrite), 0x0b] });
      return [func, f];
    }));
    const byFn = new Map(), used = new Set();
    bps.forEach((b, k) => byFn.set(b.func, (byFn.get(b.func) ?? new Map()).set(b.offset, k)));
    if (byFn.size || spf.size) {
      const rf = w._readFunction, ri = w._readInstruction;
      let cur = null, sp = null;
      w._readFunction = function (r, i) {
        [cur, sp] = [byFn.get(i), spf.get(i)];
        try { return rf.call(this, r, i); } finally { cur = sp = null; }
      };
      w._readInstruction = function (r) {
        const k = cur?.get(r.inPos), at = sp && r.inPos && STEP_OPS.has(r.inBuffer[r.inPos]) ? r.inPos : -1;
        if (k == null && at < 0) return ri.call(this, r);
        r.commitBytes();
        if (at >= 0) r.copyBuffer([0x41, ...leb.s32(at), 0x10, ...leb.u32(sp.value)]);
        if (k != null) (used.add(k), r.copyBuffer([...bpPre(k), 0x10, ...leb.u32(bpf[k].value)]));
        return ri.call(this, r);
      };
    }
    const gset = b => (f => f ? [...b, 0x10, ...leb.u32(f.value)] : b)(gw.get(rd(b, 1)[0]));
    if (gw.size) w.addInstructionParser(0x24, gset);
    const entry = index => [0x41, 0x7e, 0x41, ...leb.s32(index), ...f64z, 0x10, ...leb.u32(iRead.value),
      ...(types[index]?.params ?? []).flatMap((t, i) => conv[t] ? [0x41, 0x7d, 0x41, ...leb.s32(i), 0x20, ...leb.u32(i), ...conv[t], 0x10, ...leb.u32(iRead.value)] : [])];
    w.addCodeElementParser(null, ({ bytes: body, index }) => {
      const patch = patched.get(index), c = cov[index - m.funcImports - 2], sp = spf.get(index);
      if (patch) bps.forEach((b, k) => b.func === index && used.delete(k));
      if (patch && sp) warnings.push(`Step trace skipped: function ${index} has a patch`);
      const pre = [...c ? bump(c.g.value) : [], ...traced.has(index) ? entry(index) : [],
        ...sp && !patch ? [0x41, 0, 0x10, ...leb.u32(sp.value)] : []];
      const src = patch ? unbump(Uint8Array.from(patch)) : body, out = new Uint8Array(pre.length + src.length);
      let q = 0;
      out.set(pre);
      out.set(src, pre.length);
      for (const s of pend.splice(0)) {
        const i = patch ? -1 : find(out, s.pat, q);
        if (i >= 0) [sites[s.id], q] = [{ ...sites[s.id], func: index, offset: i + s.at }, i + s.pat.length];
      }
      return patch || pre.length ? out : false;
    });
    for (const src of processors) try { new Function("processor", src)(w); } catch (e) { warnings.push(msg(e)); }

    w.load(input);
    w.parse();
    const out = w.write(), starts = [];
    for (let p = 8; p < out.length;) {
      const [len, q] = rd(out, p + 1);
      if (out[p] === 10) for (let [n, r] = rd(out, q); n--;) {
        const [size, s] = rd(out, r);
        let [locals, t] = rd(out, s);
        while (locals--) t = valtype(out, rd(out, t)[1])[1];
        starts.push(t);
        r = s + size;
      }
      p = q + len;
    }
    for (const s of sites) if (s.func != null) s.offset += starts[s.func - m.funcImports - 2];
    bps.forEach((b, k) => used.has(k) || b.func < m.funcImports + 2 || b.func >= m.funcs.length + 2
      || warnings.push(`Breakpoint skipped: function ${b.func} has no instruction at offset ${b.offset}`));
    const functions = {};
    for (const [i, n] of [...Object.entries(m.names.functions), ...Object.entries(m.fn)]) functions[adj(i)] ??= n;
    const helpers = [fRead, fWrite, fLoad, fWatch, ...stores.values(), ...gw.values(), ...ats.values(), ...ranges.values(),
      ...bpf, ...spf.values()].map(f => f.value);
    const K = 0x41, G = m.globals.length, drop = () => [], call = f => [0x10, f.value], extra = g => g >= G;
    const seqs = [
      [[[K], [K], [K], call(fRead)], drop],
      [[[0x23, anyWrite.value], [0x04, 0x40], call(fWrite), [0x0b]], drop],
      ...[...stores].map(([op, f]) => [[[K], [K], call(f)], ([off]) =>
        [...op === 0xfd ? [0xfd, 0x0b] : [op], 0, ...leb.u32(off >>> 0)]]),
      ...[...gw.values(), ...bpf].map(f => [[call(f)], drop]),
      ...[...spf.values()].map(f => [[[K], call(f)], drop]),
      ...[...ats.values()].map(f => [[[K], [K], [K], [K], call(f)], drop]),
      ...[...ranges.values()].map(f => [[[K], [K], call(f)], drop]),
      [[[K, -2], [K], [0x44], call(iRead)], drop],
      ...[[0xb7], [0xb9], [0xbb], []].map(c => [[[K, -3], [K], [0x20], ...c.map(o => [o]), call(iRead)], drop]),
      ...[[0xb7], [0xb9], [0xbb], []].map(c => [[[K, -6], [K], [0x20], ...c.map(o => [o]), call(iWrite)], drop]),
      [[[0x23, extra], [K, 1], [0x6a], [0x24, extra]], v => v[0] === v[3] ? [] : null]];
    return { bytes: out, helpers, globals, memory, memories: mems, sites, types,
      names: { functions, globals: { ...m.gl, ...m.names.globals } }, dataRanges: m.dataRanges,
      original: bytes, patched: input, canon: { imports: m.funcImports, funcs: m.funcs.length, globals: G, seqs },
      options: { precise, trace: [...traced], globalWatch: [...gw.keys()], coverage: !!coverage, breakpoints: bps, stepTrace: sps },
      bpHelpers: bpf.map(f => f.value),
      cov: cov.map(({ func, field }) => ({ func, field })), fexports, warnings,
      tableSlots: m.elems.filter(e => m.tables[e.table] != null).map(e => ({ table: m.tables[e.table], slot: e.slot, func: adj(e.func) })) };
  };

  const DEFAULT = { patches: [], processor: [], preinstantiate: [], options: {} };
  let config = null, gotConfig;
  const configured = new Promise(r => gotConfig = r);
  addEventListener("cetusMsgOut", e => {
    if (config || typeof e.detail !== "string") return;
    try {
      const { type, body } = L.decode(e.detail);
      if (type === "config") gotConfig(config = { patches: body?.patches ?? [], processor: body?.callbacks?.processor ?? [], preinstantiate: body?.callbacks?.preinstantiate ?? [],
        options: body?.instrumentOptions ?? {} });
    } catch {}
  });
  const getConfig = () => config ?? Promise.race([configured, new Promise(r => (L.sT ?? setTimeout)(r, 1000, DEFAULT))]);

  const metas = new WeakMap();
  L.original = mod => (m => m?.patched ?? m?.original ?? null)(metas.get(mod)?.meta);
  const then = (v, f) => typeof v?.then === "function" ? v.then(f) : f(v);
  const attempt = (f, onError) => { try { const r = f(); return typeof r?.then === "function" ? r.catch(onError) : r; } catch (e) { return onError(e); } };
  const view = b => ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b);

  const build = (bytes, cfg, make) => {
    let src = null, meta = null, error = null, patched = null;
    const warnings = [], orig = cfg.patches.filter(p => p?.space === "original");
    try { src = view(bytes).slice(); meta = L.instrument(src, { patches: cfg.patches, processors: cfg.processor, warnings,
      precise: !!cfg.options.precise, trace: Array.isArray(cfg.options.trace) ? cfg.options.trace : [],
      globalWatch: Array.isArray(cfg.options.globalWatch) ? cfg.options.globalWatch : [],
      coverage: !!cfg.options.coverage,
      breakpoints: Array.isArray(cfg.options.breakpoints) ? cfg.options.breakpoints : [],
      stepTrace: Array.isArray(cfg.options.stepTrace) ? cfg.options.stepTrace : [] });
    } catch (e) { error = msg(e); }
    const tag = (mod, meta, error, b) => (metas.set(mod, { src, meta, error, warnings, bytes: b }), mod);
    const pristine = () => then(make(bytes), mod => tag(mod, null, error, src));
    const fallback = e => {
      error ??= msg(e);
      try { patched = src && orig.length ? splice(src, orig, []) : null; } catch (x) { error += `; ${msg(x)}`; }
      return patched && patched !== src ? attempt(() => then(make(patched), mod => tag(mod, null, error, patched)),
        x => (error += `; patched module failed: ${msg(x)}`, pristine())) : pristine();
    };
    return meta ? attempt(() => then(make(meta.bytes), mod => tag(mod, meta, null, meta.bytes)), fallback) : fallback();
  };

  const hit = (kind, src) => (op, a, b) => { try { L.watchHit(op, kind, a, b, undefined, undefined, src); } catch {} };
  const memoriesOf = (mod, instance, imports, d) => {
    const ms = d?.meta?.memories ?? (() => { try { return d?.src && memories(scan(d.src)); } catch {} })(), get = (m, f) => imports?.[m]?.[f];
    const at = x => x.kind === "import" ? get(x.module, x.field) : x.name != null ? instance.exports[x.name] : null;
    const im = O.Module.imports(mod).filter(e => e.kind === "memory").map(e => get(e.module, e.name));
    const ex = O.Module.exports(mod).filter(e => e.kind === "memory").map(e => instance.exports[e.name])
      .filter((m, i, l) => !im.includes(m) && l.indexOf(m) === i);
    const byIndex = ms?.map(x => ({ index: x.index, memory: at(x), ...x.i64 && { i64: true } })), out = byIndex?.some(x => !x.index && x.memory?.buffer) || d?.meta ? byIndex
      : [...im, ...ex].map((memory, index) => ({ index, memory }));
    return out.filter((x, i) => x.memory?.buffer && out.findIndex(y => y.memory === x.memory) === i);
  };

  const instantiate = (mod, imports, cfg, make) => {
    const d = metas.get(mod), warnings = [...d?.warnings ?? []];
    for (const src of cfg.preinstantiate) try { new Function("module", "importObject", src)(d?.src, imports); } catch (e) { warnings.push(msg(e)); }
    const wired = d ? !!d.meta : O.Module.imports(mod).some(i => i.module === "__cetus");
    const src = {}, linked = wired ? Object.create(imports ?? null, { __cetus: { value: { read: hit("read", src), write: hit("write", src) }, enumerable: true } }) : imports;
    return then(make(mod, linked), instance => {
      const memories = memoriesOf(mod, instance, imports, d);
      const base = { instance, module: mod, imports, memory: memories[0]?.memory ?? null, memories, bytes: d?.bytes ?? null, original: d?.src ?? null, hit: src };
      try {
        L.register({ ...base, instrumented: wired, error: d ? d.error : wired ? null : "Module was not compiled in this page", meta: d?.meta ?? null, warnings });
      } catch (e) {
        try { L.register({ ...base, instrumented: false, error: `Registration failed: ${msg(e)}`, meta: null, warnings }); } catch {}
      }
      return instance;
    });
  };

  const fetched = async source => {
    const res = await source;
    if (!res?.ok) throw new TypeError(`WebAssembly response failed with status ${res?.status}`);
    return res.arrayBuffer();
  };
  const compileAsync = async bytes => build(bytes, await getConfig(), O.compile);
  const instantiateAsync = async (source, imports) => {
    const cfg = await getConfig();
    if (source instanceof O.Module) return instantiate(source, imports, cfg, O.instantiate);
    const mod = await build(source, cfg, O.compile);
    return { module: mod, instance: await instantiate(mod, imports, cfg, O.instantiate) };
  };

  W.compile = compileAsync;
  W.compileStreaming = async source => compileAsync(await fetched(source));
  W.instantiate = instantiateAsync;
  W.instantiateStreaming = async (source, imports) => instantiateAsync(await fetched(source), imports);
  W.Module = new Proxy(O.Module, { construct: (t, [bytes], nt) => build(bytes, config ?? DEFAULT, b => Reflect.construct(t, [b], nt)) });
  W.Instance = new Proxy(O.Instance, { construct: (t, [mod, imports], nt) => instantiate(mod, imports, config ?? DEFAULT, (m, i) => Reflect.construct(t, [m, i], nt)) });
})();
