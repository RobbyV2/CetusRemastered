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
  const kit = L => {
    const REL = ["eq", "ne", "lt", "lte", "gt", "gte"], DIFF = ["changed", "unchanged", "increased", "decreased"], MORE = ["incBy", "decBy", "incPct", "decPct"];
    const NUM = L.TYPES.slice(0, 10), isText = t => ["ascii", "utf16", "utf8", "aob", "binary"].includes(t), ubig = t => L.isBig(t) && t[0] === "u";
    const grow = (a, n) => {
      if (!ArrayBuffer.isView(a) || n < a.length) return a;
      const b = new a.constructor(a.length * 2);
      b.set(a);
      return b;
    };
    const clamp = (v, d, len) => (x => Math.max(0, Math.min(len, Number.isNaN(x) ? d : x)))(Number(v ?? d));
    const range = (p, len, lo = clamp(p.lower, 0, len)) => [lo, Math.max(lo, clamp(p.upper, len, len))];
    const hex = (b, m = 0xFF) => [b >> 4, b & 15].map((x, i) => m & (i ? 0x0F : 0xF0) ? x.toString(16).toUpperCase() : "?").join("");
    const bits = (b, m = 0xFF) => [...b.toString(2).padStart(8, "0")].map((c, j) => m & 128 >> j ? c : "?").join("");
    const show = (u8, t, mask) => t === "aob" || t === "binary" ? Array.from(u8, (b, i) => (t === "aob" ? hex : bits)(b, mask?.[i])).join(" ") : L.formatValue(u8, t);
    const CAP = 64 * 2 ** 20, bytes = x => [x.snap, x.addrs, x.prev, x.firsts, x.types, x.vals, x.blk, x.fblk].reduce((n, a) => n + (a ? a.byteLength ?? a.length * 8 : 0), 0);
    const lc = b => b > 0x40 && b < 0x5B ? b | 0x20 : b;
    const pattern = (v, t, fold) => {
      const p = v?.bytes ? v : typeof v !== "string" ? { bytes: Uint8Array.from(v) } : t === "aob" ? L.parseAob(v) : t === "binary" ? L.parseBits(v) : { bytes: L.toBytes(v, t) };
      if (!fold || !["ascii", "utf16", "utf8"].includes(t)) return p;
      const f = p.bytes.map((b, i) => lc(b) >= 0x61 && lc(b) <= 0x7A && (t !== "utf16" || !(i & 1) && !p.bytes[i + 1]));
      return { bytes: p.bytes.map((b, i) => f[i] ? lc(b) : b), fold: f };
    };
    const matches = (u8, a, { bytes, mask, fold }) => {
      for (let i = 0; i < bytes.length; i++) if (fold?.[i] ? lc(u8[a + i]) !== bytes[i] : (u8[a + i] ^ bytes[i]) & (mask ? mask[i] : 0xFF)) return false;
      return true;
    };
    const group = v => (els => ({ text: String(v).trim(), els, size: Math.max(...els.map(e => e.offset + e.size)) }))(L.parseGroup(v));
    const gtest = ({ els }, p, u8, dv) => {
      const fs = els.filter(e => e.value != null).map(e => L.isNum(e.type)
        ? (f => a => f(L.read(dv, a + e.offset, e.type)))(tester(e.type, { compare: "eq", value: e.value, tolerance: p.tolerance || e.tolerance, rounding: p.rounding, decimals: p.decimals }))
        : (q => a => matches(u8, a + e.offset, q))(pattern(e.value, e.type)));
      return a => fs.every(f => f(a));
    };
    const gshow = (els, b) => {
      const dv = new DataView(b.buffer, b.byteOffset, b.length);
      let at = 0;
      return els.map(e => {
        const v = L.isNum(e.type) ? L.formatValue(L.read(dv, e.offset, e.type), e.type) : show(b.subarray(e.offset, e.offset + e.size), e.type), o = e.offset === at ? "" : `@${e.offset}`;
        at = e.offset + e.size;
        return `${e.type}:${e.type === "aob" || e.type === "binary" ? v.replace(/ /g, "") : v}${o}`;
      }).join(" ");
    };

    const tester = (t, p) => {
      const f = L.isFloat(t), num = v => v == null ? undefined : typeof v === "string" ? L.parseValue(v, t) : L.isBig(t) ? BigInt(v) : Number(v);
      const x = num(p.value), y = num(p.value2), tol = p.tolerance ?? 0, k = 10 ** (p.decimals ?? 0), T = v => Math.trunc(Number((v * k).toPrecision(12)));
      const [lo, hi] = x <= y ? [x, y] : [y, x], pct = (c, b) => Math.abs(Number(c) - Number(b)) >= Math.abs(Number(b)) * Number(x) / 100;
      const eq = !f ? (c, v) => c === v : p.rounding === "truncated" ? (c, v) => T(c) === T(v) : tol > 0 ? (c, v) => Math.abs(c - v) <= tol : t === "f32" ? (c, v) => c === Math.fround(v) : (c, v) => c === v;
      const fn = { eq: (c, b) => eq(c, x ?? b), ne: (c, b) => c === c && !eq(c, x ?? b), lt: (c, b) => c < (x ?? b), lte: (c, b) => c <= (x ?? b), gt: (c, b) => c > (x ?? b), gte: (c, b) => c >= (x ?? b),
        between: c => c >= lo && c <= hi, changed: (c, b) => !Object.is(c, b), unchanged: Object.is, increased: (c, b) => c > b, decreased: (c, b) => c < b,
        incBy: (c, b) => eq(c, b + x), decBy: (c, b) => eq(c, b - x), incPct: (c, b) => c > b && pct(c, b), decPct: (c, b) => c < b && pct(c, b) }[p.compare];
      return p.not ? (c, b) => c === c && !fn(c, b) : fn;
    };

    class Scan {
      constructor(getBuffer) {
        this.getBuffer = getBuffer;
        this.count = 0;
        this.type = null;
        this.history = [];
        this.saved = new Map();
      }

      check(p, first) {
        const t = this.type, grp = t === "group", text = isText(t) || grp, op = p.compare;
        if (t !== "all" && !grp && !L.isType(t)) throw new RangeError(`Unknown type: ${t}`);
        if (!(grp && !first ? ["eq", "changed", "unchanged"] : text ? ["eq"] : first ? [...REL, "between", ...t === "all" ? [] : ["unknown"]] : [...REL, ...DIFF, "between", ...MORE]).includes(op)) throw new RangeError(`Invalid comparison for ${t}: ${op}`);
        if (grp && op === "eq" && !first && p.value == null) throw new RangeError("Missing search value");
        if (text && p.value != null && (!grp || op === "eq")) this.pat = grp ? group(p.value) : pattern(p.value, t, p.caseSensitive === false);
        if (!first && p.base?.startsWith?.("saved:") && !this.saved.has(p.base.slice(6))) throw new RangeError(`Unknown saved scan: ${p.base.slice(6)}`);
        if (!first && p.base?.startsWith?.("saved:") && !!this.saved.get(p.base.slice(6)).blk !== grp) throw new RangeError("Saved scan type differs");
        if (text ? !this.pat : p.value == null && (first && REL.includes(op) || op === "between" || MORE.includes(op)) || op === "between" && p.value2 == null) throw new RangeError("Missing search value");
      }

      first(p) {
        Object.assign(this, { type: p.type, pat: null, snap: null, addrs: null, prev: null, firsts: null, types: null, blk: null, fblk: null, count: 0, history: [] });
        try {
          this.check(p, true);
        } catch (e) {
          this.type = null;
          throw e;
        }
        const t = this.type, len = this.getBuffer().byteLength, [lo, hi] = range(p, len), start = s => Math.ceil(lo / s) * s;
        const step = u => !p.aligned || isText(u) ? 1 : u !== "group" ? L.sizeOf(u) : (e => e.offset || !L.isNum(e.type) ? 1 : e.size)(this.pat.els[0]);
        if (p.compare === "unknown") {
          const n = L.sizeOf(t), s = step(t);
          Object.assign(this, { snap: new Uint8Array(this.getBuffer(), lo, hi - lo).slice(), lo, start: start(s), step: s, end: hi });
          this.count = start(s) + n <= hi ? Math.floor((hi - n - start(s)) / s) + 1 : 0;
          return { count: this.count };
        }
        return this.collect(fn => (t === "all" ? NUM : [t]).forEach(u => { for (let a = start(step(u)); a < hi; a += step(u)) fn(a, undefined, undefined, u); }), p, lo, hi);
      }

      next(p) {
        if (!this.type) return this.first(p);
        if (p.type && p.type !== this.type) throw new RangeError("Type differs from the current scan");
        const saved = this.save();
        try {
          this.check(p, false);
          this.collect(fn => this.each(fn), p, ...range(p, this.getBuffer().byteLength));
        } catch (e) {
          Object.assign(this, saved);
          throw e;
        }
        this.push(saved);
        return { count: this.count };
      }

      save() {
        const { getBuffer, history, saved, ...s } = this;
        return s;
      }

      push(s) {
        this.history.push(s);
        this.trim();
      }

      trim() {
        const h = this.history, used = [...this.saved.values()].reduce((n, x) => n + bytes(x), 0);
        while (h.length > 5 || h.length && h.reduce((n, x) => n + bytes(x), used) > CAP) h.shift();
      }

      saveAs(name) {
        const t = this.type, u8 = new Uint8Array(this.getBuffer()), dv = new DataView(u8.buffer), m = this.saved;
        if (!t) throw new Error("No scan to save");
        let x = { snap: this.snap && u8.slice(this.lo, this.end), lo: this.lo, addrs: !this.snap && this.addrs, types: this.types };
        if (this.blk) {
          const n = this.pat.size;
          x.blk = new Uint8Array(this.count * n);
          this.addrs.forEach((a, i) => x.blk.set(u8.subarray(a, a + n), i * n));
        } else if (!this.snap && this.prev) {
          x.vals = t === "all" ? [] : new (L.isBig(t) ? BigInt64Array : Float64Array)(this.count);
          this.addrs.forEach((a, i) => x.vals[i] = (v => t === "all" || typeof v !== "bigint" ? v ?? NaN : BigInt.asIntN(64, v))(L.read(dv, a, this.types ? NUM[this.types[i]] : t)));
        }
        if (bytes(x) > CAP) throw new RangeError("Saved scan exceeds 64 MiB");
        m.delete(name);
        m.set(name, x);
        while (m.size > 3 || [...m.values()].reduce((n, y) => n + bytes(y), 0) > CAP) m.delete(m.keys().next().value);
        this.trim();
        return [...m.keys()];
      }

      lookup(name) {
        const x = this.saved.get(name), t = this.type, cv = v => ubig(t) ? BigInt.asUintN(64, v) : v !== v && !L.TYPES.includes(t) ? null : v;
        if (x.snap) {
          const dv = new DataView(x.snap.buffer);
          return (a, u) => a >= x.lo && a - x.lo + L.sizeOf(u) <= x.snap.length ? L.read(dv, a - x.lo, u) : undefined;
        }
        return (a, u) => {
          const k = x.types ? NUM.indexOf(u) : 0, key = i => (x.types ? x.types[i] : 0) - k || x.addrs[i] - a;
          let lo = 0, hi = x.addrs.length;
          while (lo < hi) (m => key(m) < 0 ? lo = m + 1 : hi = m)(lo + hi >> 1);
          const n = x.blk && x.blk.length / x.addrs.length;
          return lo < x.addrs.length && !key(lo) ? x.blk ? x.blk.subarray(lo * n, lo * n + n) : x.vals ? cv(x.vals[lo]) : null : undefined;
        };
      }

      undo() {
        if (!this.history.length) throw new Error("Nothing to undo");
        Object.assign(this, this.history.pop());
        return { count: this.count, depth: this.history.length };
      }

      each(fn, from = 0) {
        const t = this.type, cv = x => ubig(t) ? BigInt.asUintN(64, x) : x;
        if (this.snap) {
          const dv = new DataView(this.snap.buffer), n = L.sizeOf(t);
          for (let a = this.start + from * this.step; a + n <= this.end; a += this.step) {
            const v = L.read(dv, a - this.lo, t);
            if (fn(a, v, v, t)) return;
          }
        } else for (let i = from, n = this.blk?.length / this.count; i < this.count; i++) {
          const text = !this.prev, old = this.blk ? this.blk.subarray(i * n, i * n + n) : text ? show(this.pat.bytes, t, this.pat.mask) : cv(this.prev[i]);
          if (fn(this.addrs[i], old, this.blk ? this.fblk.subarray(i * n, i * n + n) : text ? old : cv(this.firsts[i]), this.types ? NUM[this.types[i]] : t)) return;
        }
      }

      collect(each, p, lo, hi) {
        const t = this.type, grp = t === "group", text = isText(t) || grp, all = t === "all", u8 = new Uint8Array(this.getBuffer()), dv = new DataView(u8.buffer), end = Math.min(hi, u8.length);
        const mk = () => text ? null : all ? [] : new (L.isBig(t) ? BigInt64Array : Float64Array)(1024), tests = {}, n = grp && this.pat.size, hit = grp && p.compare === "eq" && gtest(this.pat, p, u8, dv);
        let addrs = new Uint32Array(1024), prev = mk(), firsts = mk(), types = all ? new Uint8Array(1024) : null, blk = grp && new Uint8Array(n * 64), fblk = blk && blk.slice(), k = 0, err;
        if (!text) for (const u of all ? NUM : [t]) try { tests[u] = tester(u, p); } catch (e) { err = e; }
        if (err && !Object.keys(tests).length) throw err;
        const look = (this.snap || this.addrs) && p.base?.startsWith?.("saved:") ? this.lookup(p.base.slice(6)) : null;
        each((a, old, fst, u) => {
          if (a < lo || a + (grp ? n : text ? this.pat.bytes.length : L.sizeOf(u)) > end) return;
          const b = look ? look(a, u) : p.base === "first" ? fst : old;
          if (b === undefined && look) return;
          if (grp) {
            const cur = u8.subarray(a, a + n);
            if ((hit ? hit(a) : (b?.length === n && b.every((x, i) => x === cur[i])) === (p.compare === "unchanged")) === !!p.not) return;
            [blk, fblk] = [grow(blk, (k + 1) * n - 1), grow(fblk, (k + 1) * n - 1)];
            blk.set(cur, k * n);
            fblk.set(fst?.length === n ? fst : cur, k * n);
          } else if (text) {
            if (matches(u8, a, this.pat) === !!p.not) return;
          } else {
            const c = L.read(dv, a, u), s = v => all ? v : typeof v === "bigint" ? BigInt.asIntN(64, v) : v;
            if (c === null || b === null || !tests[u]?.(c, b)) return;
            [prev, firsts, types] = [grow(prev, k), grow(firsts, k), types && grow(types, k)];
            [prev[k], firsts[k]] = [s(c), s(fst ?? c)];
            if (all) types[k] = NUM.indexOf(u);
          }
          addrs = grow(addrs, k);
          addrs[k++] = a;
        });
        Object.assign(this, { addrs: addrs.slice(0, k), prev: prev?.slice(0, k), firsts: firsts?.slice(0, k), types: types?.slice(0, k), blk: grp ? blk.slice(0, k * n) : null, fblk: grp ? fblk.slice(0, k * n) : null, snap: null, count: k });
        return { count: k };
      }

      rows(limit = 100, offset = 0) {
        const out = [], t = this.type;
        if (!t || limit < 1) return out;
        const u8 = new Uint8Array(this.getBuffer()), dv = new DataView(u8.buffer);
        const grp = t === "group", els = grp && this.pat.els.map(({ offset, type, size }) => ({ offset, type, size }));
        this.each((address, previous, _, u) => {
          const n = grp ? this.pat.size : isText(t) ? this.pat.bytes.length : L.sizeOf(u), cur = u8.subarray(address, address + n);
          const value = address + n > u8.length ? null : grp ? gshow(this.pat.els, cur) : isText(t) ? show(cur, t) : L.read(dv, address, u);
          return out.push({ address, value, previous: grp ? gshow(this.pat.els, previous) : previous, ...t === "all" && { type: u }, ...grp && { group: this.pat.text, elements: els } }) >= limit;
        }, offset);
        return out;
      }
    }

    const utf8At = (u8, i, hi) => {
      const b = u8[i], n = b < 0x80 ? 1 : b >= 0xC2 && b < 0xE0 ? 2 : b >= 0xE0 && b < 0xF0 ? 3 : b >= 0xF0 && b < 0xF5 ? 4 : 0;
      let c = n > 1 ? b & 0x7F >> n : b;
      if (!n || i + n > hi) return [0, 0];
      for (let k = 1; k < n; k++) {
        if ((u8[i + k] & 0xC0) !== 0x80) return [0, 0];
        c = c << 6 | u8[i + k] & 0x3F;
      }
      return c < [0, 0, 0x80, 0x800, 0x10000][n] || c > 0x10FFFF || c >= 0xD800 && c < 0xE000 ? [0, 0] : [c, n];
    };
    const findStrings = (u8, { encoding, minLength = 4, lower, upper, limit = 100, offset = 0 }) => {
      const u = encoding === "utf8", w = encoding === "utf16" ? 2 : 1, [lo, hi] = range({ lower, upper }, u8.length), rows = [], run = [0, 0], st = [0, 0], end = [0, 0];
      let count = 0;
      const flush = p => {
        if (run[p] >= Math.max(1, minLength) && count++ >= offset && rows.length < limit) rows.push({ address: st[p], text: show(u8.subarray(st[p], end[p]), encoding) });
        run[p] = 0;
      };
      for (let i = lo; i + w <= hi;) {
        const p = w === 2 ? i & 1 : 0, [c, n] = u ? utf8At(u8, i, hi) : [w === 2 ? u8[i] | u8[i + 1] << 8 : u8[i], w];
        const ok = n && (c >= 0x20 && c <= 0x7E || u && c >= 0xA0);
        if (ok) (run[p]++ || (st[p] = i), end[p] = i + n);
        else flush(p);
        i += u && ok ? n : 1;
      }
      [0, 1].sort((a, b) => st[a] - st[b]).forEach(flush);
      return { count, rows };
    };
    const cands = (u8, wide) => {
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.length), len = u8.length, n = wide ? 8 : 4;
      const get = a => wide && dv.getUint32(a + 4, true) ? 0 : dv.getUint32(a, true);
      let k = 0, j = 0;
      for (let a = 0; a + n <= len; a += 4) (v => v && v < len)(get(a)) && k++;
      const key = new BigUint64Array(k), w = new Uint32Array(key.buffer);
      for (let a = 0; a + n <= len && j < k; a += 4) {
        const v = get(a);
        if (v && v < len) w[2 * j] = a, w[2 * j++ + 1] = v;
      }
      return key.subarray(0, j).sort();
    };
    const pointers = (u8, target, { maxDepth, maxOffset, ranges, globals, wide }) => {
      const key = cands(u8, wide), k = key.length, w = new Uint32Array(key.buffer, 0, 2 * k);
      const out = [], seen = new Set([target]), sum = p => p.offsets.reduce((s, o) => s + o, 0);
      let level = [[target, []]];
      for (let d = 0; d < maxDepth && level.length && out.length < 1e5; d++) {
        const next = [];
        for (const [t, offs] of level) {
          for (const g of globals) if (g.value > 0 && g.value <= t && t - g.value <= maxOffset) out.push({ base: { kind: "global", name: g.name }, offsets: [t - g.value, ...offs] });
          let lo = 0, hi = k;
          while (lo < hi) (m => w[2 * m + 1] < t - maxOffset ? lo = m + 1 : hi = m)(lo + hi >> 1);
          for (let i = lo; i < k && w[2 * i + 1] <= t; i++) {
            const a = w[2 * i], offsets = [t - w[2 * i + 1], ...offs];
            if (ranges.some(([s, e]) => a >= s && a + (wide ? 8 : 4) <= e)) out.push({ base: { kind: "static", address: a }, offsets });
            if (!seen.has(a) && next.length < 1e4) next.push([a, offsets]) && seen.add(a);
          }
        }
        level = next;
      }
      return out.sort((a, b) => a.offsets.length - b.offsets.length || sum(a) - sum(b)).slice(0, 1e5);
    };
    return { Scan, findStrings, show, range, cands, pointers, tester, group, gshow, pattern, matches };
  };
  const { Scan, findStrings, show, range, cands, pointers, tester, group, gshow, pattern, matches } = kit(L);

  const NUM = L.TYPES.slice(0, 10), { setTimeout: sT, clearTimeout: cT, setInterval: sI, clearInterval: cI, requestAnimationFrame: raf, cancelAnimationFrame: caf, Worker: OW } = globalThis, OM = WebAssembly.Module, OI = WebAssembly.Instance, SC = ["i32", "i64", "f32", "f64"];
  const instances = [], workers = [], freezes = new Map(), slots = [null, null, null, null], flags = [0, 0, 0, 0];
  const hits = new Map(), globalHits = new Map(), bpHits = new Map(), bpBreaks = new Map(), hitFns = new Set();
  const bpConds = new Map(), conds = new Map(), cbad = new Set(), counts = new Map(), lbuf = [];
  const armed = new Map(), calls = new Map(), steps = new Map(), timers = {}, olds = [], pend = new Map(), waits = new Map();
  const ARR = { i8: Int8Array, u8: Uint8Array, i16: Int16Array, u16: Uint16Array, i32: Int32Array, u32: Uint32Array, i64: BigInt64Array, u64: BigUint64Array };
  const tok = L.worker ?? Math.random().toString(36).slice(2), me = L.wid ?? Math.random().toString(36).slice(2), bc = typeof BroadcastChannel === "function" && typeof addEventListener === "function" ? new BroadcastChannel("cetus-remastered") : null;
  const undos = [], MODES = ["exact", "noDecrease", "noIncrease", "step"], snaps = new Map(), SNAP = 256 * 2 ** 20;
  let nextId = 1, syncs = 0, rids = 0, owner = null, scan = null, speed = 1, clock = null, rafHooked = false, freezeTimer = null, selected = null, tracing = null, workerSrc = L.workerSrc ?? null, cfg = null, blobOk = false, probed = false;
  let hotkeys = [], suspended = false, lastSpeed = 2, before = 1, cfgBody = null, ptrs = [], wsl = [];
  const tq = new Map(), frames = new Map(), pn = globalThis.performance?.now.bind(performance) ?? Date.now;
  let tn = 0;
  const scripts = new Map(), codes = new Map(), ticks = new Set(), skeys = new Set(), hooks = new Map(), wraps = new WeakMap(), jsFrozen = new Map(), ERR = {};
  let looping = false, cfgScripts = false, keysSet = false, jsCands = null, cover = null, panel = null;
  const msg = e => String(e?.message ?? e);
  const fail = (m, E = RangeError) => { throw new E(m); };
  const emit = (type, body) => dispatchEvent(new CustomEvent("cetusMsgIn", { detail: L.encode({ type, body }) }));
  const size = i => i.memory?.buffer.byteLength ?? 0;
  const isShared = b => Object.prototype.toString.call(b) === "[object SharedArrayBuffer]";
  const save = (b, file) => {
    const url = URL.createObjectURL(new Blob([b]));
    Object.assign(document.createElement("a"), { href: url, download: file }).click();
    sT(() => URL.revokeObjectURL(url), 1000);
  };
  const memInfo = ({ index, memory: m, i64 }) => ({ index, bytes: m.buffer.byteLength, shared: isShared(m.buffer), ...i64 && { i64 } });
  const wpub = ({ from, acked, lid, cfgDone, ...w }) => w;
  const pub = i => ({ id: i.id, memoryBytes: size(i), instrumented: i.instrumented, error: i.error, warnings: i.warnings ?? [],
    url: i.url, hash: i.hash, worker: false, shared: isShared(i.memory?.buffer), memory: i.mi, memories: i.mems.map(memInfo),
    memory64: !!i.m64 });
  const active = () => instances.find(i => i.id === selected) ?? instances.reduce((a, b) => !a || size(b) > size(a) ? b : a, null);
  const sel = () => L.worker ? null : workers.find(w => w.id === selected)
    ?? (instances.length ? null : workers.reduce((a, b) => !a || b.memoryBytes >= a.memoryBytes ? b : a, null));
  const fname = f => active()?.meta?.names.functions[f] ?? null;
  const need = () => {
    const a = active() ?? fail("No WebAssembly instance in this frame", Error);
    a.memory || fail("Instance has no memory", Error);
    if (a !== owner) {
      if (!L.worker && instances.includes(owner)) for (let k = 0; k < 4; k++) try { owner.exports[owner.aname]?.(k, -1); } catch {}
      [owner, scan, ptrs] = [a, session(a), []];
      armed.clear();
    }
    return a;
  };
  const later = (type, body) => timers[type] ??= sT(() => { timers[type] = null; emit(type, body()); }, 250);
  const put = (buf, address, t, v) => {
    const n = L.sizeOf(t);
    isShared(buf) && ARR[t] && address % n === 0 ? Atomics.store(new ARR[t](buf), address / n, v) : L.write(new DataView(buf), address, t, v);
  };
  const int = (v, what, lo = 0, hi = 2 ** 32 + 1) => Number.isInteger(v) && v >= lo && v < hi ? v : fail(`Invalid ${what}`, TypeError);
  const opt = v => v == null ? undefined : int(v, "range");
  const str = v => typeof v === "string" ? v : fail("Value must be a string", TypeError);
  const type = t => L.isType(t) ? t : fail(`Invalid type: ${t}`);
  const inWorker = (d, buf) => new Promise((res, rej) => {
    let w, url;
    try {
      url = URL.createObjectURL(new Blob([`${L.src}\nconst K = (${kit})(cetusLib);\nonmessage = ({ data: d }) => {
        try { d.ct && cetusLib.customTypes(d.ct); postMessage({ state: d.args ? K.pointers(new Uint8Array(d.buf), ...d.args) : (s => (s[d.op](d.p), s.save()))(Object.assign(new K.Scan(() => d.buf), d.state, { saved: d.saved })) }); } catch (e) { postMessage({ error: String(e.message) }); }
      };`], { type: "text/javascript" }));
      w = new OW(url);
    } catch { return res(null); }
    const end = v => (w.terminate(), URL.revokeObjectURL(url), v);
    w.onerror = e => (e.preventDefault(), res(end(null)));
    w.onmessage = ({ data: d }) => d.error ? rej(new RangeError(end(d.error))) : res(end(d.state));
    w.postMessage({ ...d, buf }, isShared(buf) ? [] : [buf]);
  });
  const mo = (a, k = a.mi) => a.mems.find(x => x.index === k)?.memory ?? fail(`Unknown memory: ${k}`);
  const session = a => (m => new Scan(() => m.buffer))(mo(a));
  const mem = m => new Uint8Array(m.buffer);
  const at = (m, v, n = 1) => (int(v, "address"), v + n <= m.buffer.byteLength ? v : fail("Address out of range"));
  const watchFn = a => (f => f && ((k, ad, ...r) => f(k, a.m64 ? BigInt(ad) : ad, ...r)))(a.exports[a.wname]);
  const wide = (a, m) => !!a.mems.find(x => x.memory === m)?.i64;
  const uval = (a, [address, n]) => {
    try { return (dv => dv[n === 8 ? "getBigUint64" : `getUint${n * 8}`](address, true))(new DataView(a.memory.buffer)); } catch { return null; }
  };
  const wslots = () => L.worker ? wsl : slots.map((s, k) => s && [s.address, s.size, flags[k]]);
  const rearm = (a, lo, n, m = a.memory) => m === a.memory && wslots().forEach((s, k) => {
    if (!s || s[2] === 2 || !L.worker && slots[k].i !== a || s[0] >= lo + n || lo >= s[0] + s[1]) return;
    watchFn(a)?.(k, s[0], s[1], s[2]);
    olds[k] = uval(a, s);
  });
  const reold = k => slots[k] && active()?.memory && (olds[k] = uval(active(), [slots[k].address, slots[k].size]));
  const accessList = () => [...armed.values()].map(({ func, offset, map }) => ({ func, offset, addresses: [...map].map(([address, count]) => ({ address, count })) }));
  const send = m => (bc?.postMessage(m), wports.forEach(p => p.postMessage({ [KEY]: m })));
  const sync = () => send({ tok, t: "sync", n: ++syncs, slots: slots.map((s, i) => s && [s.address, s.size, flags[i], !!s.break, s.condition ?? null]),
    sites: [...armed.keys()], bps: [...bpBreaks], bpc: [...bpConds], sp: speed, su: suspended, ct: L.customTypes() });
  const fwd = (w, type, body) => new Promise((res, rej) => {
    const rid = ++rids, t = sT(() => waits.delete(rid) && rej(new Error("Worker did not respond")), 60000);
    waits.set(rid, Object.assign(d => (cT(t), d.ok ? res(d.body) : rej(new Error(d.error))), { to: w.from }));
    send({ tok, t: "req", to: w.from, lid: w.lid, rid, type, body });
  });
  const drop = from => {
    const n = workers.length;
    for (let k; (k = workers.findIndex(w => w.from === from)) >= 0;) workers.splice(k, 1)[0].id === selected && (selected = null);
    if (workers.length < n && !L.worker) emit("instances", {});
    waits.forEach((f, rid) => f.to === from && (waits.delete(rid), f({ ok: false, error: "Worker is gone" })));
  };
  const bye = from => from && (L.worker ? bc?.postMessage({ tok, t: "bye", from }) : drop(from));
  const locks = globalThis.navigator?.locks, lockName = from => `cetus-${tok}-${from}`;
  const live = L.worker && locks && new Promise(g => { try { locks.request(lockName(me), () => (g(true), new Promise(() => {}))).catch(() => g(false)); } catch { g(false); } });
  if (L.worker && typeof close === "function") { const c = close; globalThis.close = () => (bye(me), c()); }
  const apply = (i, ws, sites) => {
    ws.forEach((s, k) => watchFn(i)?.(k, ...s?.slice(0, 3) ?? [0, 0, 0]));
    for (let k = 0; k < 4; k++) i.exports[i.aname]?.(k, sites[k] ?? -1);
  };

  const snapList = () => [...snaps].map(([name, s]) => ({ name, instance: s.a.id, memory: s.mi, bytes: s.mem.length, globals: s.gs.length }));
  const numGlobals = i => { try { return globalsOf(i).filter(g => g.mutable && SC.includes(g.type) && g.acc?.set); } catch { return []; } };
  const freezeList = (x = active()) => [...freezes.values()].filter(f => f.a === x).map(({ g, a, ...f }) => f);
  const pubSlots = () => slots.filter(Boolean).map(({ i, ...s }) => s);
  const nextValue = (f, c) => f.mode === "noDecrease" ? c > f.value ? c : f.value : f.mode === "noIncrease" ? c < f.value ? c : f.value : f.mode === "step" ? c + f.step : f.value;
  const applyFreezes = () => {
    if (suspended) return;
    for (const f of freezes.values()) try {
      const a = f.a;
      if (!instances.includes(a)) continue;
      if (f.g) {
        f.g.value = nextValue(f, f.g.value);
        if (f.mode) f.value = f.g.value;
      } else {
        const m = a.mems.find(x => x.index === (f.memory ?? 0))?.memory, buf = m?.buffer, dv = m && new DataView(buf);
        const ad = !m ? null : f.pointer ? resolve(a, f.pointer, m) : f.address;
        if (ad == null || ad + L.sizeOf(f.type) > buf.byteLength) continue;
        const c = L.read(dv, ad, f.type);
        if (c !== null || f.mode !== "step") put(buf, ad, f.type, nextValue(f, c));
        if (f.mode) f.value = L.read(dv, ad, f.type) ?? f.value;
        rearm(a, ad, L.sizeOf(f.type), m);
      }
    } catch {}
  };
  const freezeTick = () => {
    if (freezes.size && !freezeTimer) freezeTimer = sI(applyFreezes, 50);
    else if (!freezes.size && freezeTimer) freezeTimer = cI(freezeTimer);
  };
  const unwatch = i => {
    const o = slots[i]?.i;
    slots[i] = olds[i] = null;
    counts.delete(`w${i}`);
    if (instances.includes(o)) try { watchFn(o)(i, 0, 0, 0); } catch {}
    for (const [k, h] of hits) if (h.slot === i) hits.delete(k);
    sync();
  };
  const pushUndo = u => undos.push(u) > 50 && undos.shift();
  const store = (a, address, t, v, undo = true, m = mo(a)) => {
    const b = t === "raw" ? v : L.toBytes(v, t);
    at(m, address, b.length);
    if (undo) pushUndo({ kind: "write", a, m, address, bytes: mem(m).slice(address, address + b.length) });
    L.isNum(t) ? put(m.buffer, address, t, v) : mem(m).set(b, address);
    rearm(a, address, b.length, m);
    return {};
  };
  const virt = t => clock ? clock.v + (t - clock.r) * speed : t;
  const audio = new WeakMap(), warp = (proto, key, map) => {
    const d = proto && Object.getOwnPropertyDescriptor(proto, key);
    if (d?.get) Object.defineProperty(proto, key, { ...d, get() { const t = d.get.call(this); return typeof t === "number" ? map(t, this) : t; } });
  };
  const hookRaf = () => {
    if (rafHooked || !raf) return;
    rafHooked = true;
    globalThis.requestAnimationFrame = cb => {
      const id = raf(t => {
        try { applyFreezes(); } catch {}
        speed ? cb(virt(t)) : frames.set(id, cb);
      });
      return id;
    };
    if (caf) globalThis.cancelAnimationFrame = id => (frames.delete(id), caf(id));
  };
  const run = (f, x) => typeof f === "function" ? f(...x) : sT(f, 0);
  const vnow = () => clock ? virt(clock.now()) : pn();
  const arm = (id, e) => {
    const w = speed && Math.max(0, e.due - vnow()) / speed;
    e.far = w > 2 ** 31 - 1;
    e.h = speed ? sT(ring, Math.min(w, 2 ** 31 - 1), id) : null;
  };
  const ring = id => {
    const e = tq.get(id), late = e && vnow() - e.due;
    if (!e || e.far) return e && arm(id, e);
    if (!e.iv) tq.delete(id);
    else e.due += e.d ? e.d * (1 + Math.floor(Math.max(0, late) / e.d)) : Math.max(0, late), arm(id, e);
    run(e.f, e.x);
  };
  const timer = iv => (f, d, ...x) => {
    const id = ++tn, e = { f, x, iv, d: Math.max(0, Number(d) || 0) };
    tq.set(id, Object.assign(e, { due: vnow() + e.d }));
    arm(id, e);
    return id;
  };
  if (sT) {
    [globalThis.setTimeout, globalThis.setInterval] = [timer(false), timer(true)];
    const clear = id => (e => e && (tq.delete(+id), e.h != null && cT(e.h)))(tq.get(+id));
    globalThis.clearTimeout = globalThis.clearInterval = clear;
  }
  const replay = () => {
    for (const id of frames.keys()) raf(t => (cb => cb && speed && (frames.delete(id), cb(virt(t))))(frames.get(id)));
  };
  const setSpeed = m => {
    if (!clock && m === 1) return;
    const left = [...tq].map(([id, e]) => (e.h != null && cT(e.h), [id, e, e.due - vnow()]));
    if (!clock) {
      const p = performance, now = p.now.bind(p), off = Date.now() - now(), OD = Date;
      const dn = () => Math.floor(off + virt(now()));
      clock = { now, v: 0, r: 0 };
      p.now = () => virt(now());
      OD.now = dn;
      globalThis.Date = new Proxy(OD, {
        construct: (t, a, nt) => Reflect.construct(t, a.length ? a : [dn()], nt),
        apply: () => String(new OD(dn())),
      });
      OD.prototype.constructor = globalThis.Date;
      warp(globalThis.Event?.prototype, "timeStamp", virt);
      warp(globalThis.AnimationTimeline?.prototype, "currentTime", virt);
      warp(globalThis.BaseAudioContext?.prototype, "currentTime", (t, ctx) => {
        const c = audio.get(ctx) ?? audio.set(ctx, { r: t, v: t, m: speed }).get(ctx);
        if (c.m !== speed) Object.assign(c, { v: c.v + (t - c.r) * c.m, r: t, m: speed });
        return c.v + (t - c.r) * speed;
      });
      hookRaf();
    }
    const r = clock.now(), v = virt(r), was = speed;
    Object.assign(clock, { v, r });
    if (!m && was) before = was;
    speed = m;
    left.forEach(([id, e, l]) => (e.due = v + l, arm(id, e)));
    if (m && !was) replay();
    if (!L.worker) sync();
  };

  const section = (b, id) => {
    for (let p = 8; p < b.length;) {
      const [len, q] = L.leb.readU32(b, p + 1);
      if (b[p] === id) return q;
      p = q + len;
    }
    return -1;
  };
  const code = a => a.bytes ?? fail("Module bytes are unavailable", Error);
  const imports = a => a.module ? WebAssembly.Module.imports(a.module).filter(d => d.kind === "function") : [];
  const bodies = (a, orig) => a[orig === "p" ? "pbodies" : orig ? "obodies" : "bodies"] ??= (() => {
    const b = orig === "p" ? a.meta.patched
      : orig ? a.original ?? fail("Module bytes are unavailable", Error) : code(a);
    const rd = p => L.leb.readU32(b, p), p = section(b, 10), out = [];
    let k = imports(a).length;
    if (p >= 0) for (let [n, r] = rd(p); n--;) {
      const [l, s] = rd(r);
      let [locals, t] = rd(s);
      while (locals--) t = L.valtype(b, rd(t)[1])[1];
      out.push({ index: k++, loc: s, start: t, end: r = s + l, b });
    }
    return out;
  })();
  const functionBody = (a, index, orig) => {
    const f = bodies(a, orig).find(x => x.index === int(index, "function index")) ?? fail(index < imports(a).length ? "Function is imported" : "Function index out of range");
    const raw = f.b.subarray(f.start, f.end), out = orig && a.meta ? [] : Array.from(raw);
    const lo = orig && a.meta ? (a.oscan ??= L.scan(f.b)).funcImports : Infinity;
    for (let p = 0, q; lo < Infinity && p < raw.length; p = q) {
      const v = CALLS.includes(raw[p]) ? imm(raw, p) : -1;
      q = insnEnd(raw, p);
      out.push(...v >= lo ? [raw[p], ...L.leb.u32(v + 2)] : raw.subarray(p, q));
    }
    const locals = decls(f), o = !orig && a.original && bodies(a, true).find(x => x.index === f.index);
    const added = o ? flat(locals).slice(flat(decls(o)).length) : orig ? [] : null;
    const live = !orig && a.meta, bh = new Set(live ? a.meta.bpHelpers ?? [] : []), bpCalls = [];
    for (let p = 0; bh.size && p < raw.length; p = insnEnd(raw, p)) {
      if (raw[p] === 0x10 && bh.has(imm(raw, p))) bpCalls.push(p);
    }
    const map = live ? omap(a, f) : null;
    const sites = live ? a.meta.sites.flatMap(s => s.func === f.index ? [[s.offset - f.start, s.op ?? null]] : [])
      : [];
    return { index, bytes: out, bodyOffset: f.start, env: env(a, f, orig), locals, added, map, bpCalls, sites };
  };
  const decls = f => {
    let [n, p] = L.leb.readU32(f.b, f.loc);
    const g = [];
    for (let c, t; n--; g.push([c, t])) ([c, p] = L.leb.readU32(f.b, p), [t, p] = L.valtype(f.b, p));
    return g;
  };
  const flat = g => g.flatMap(([c, t]) => Array(c).fill(t));
  const CALLS = [0x10, 0x12, 0xd2], IMM = [...CALLS, 0x20, 0x21, 0x22, 0x23, 0x24];
  const imm = (b, p) => b[p] === 0x41 ? L.leb.readS32(b, p + 1)[0] : b[p] === 0x04 ? b[p + 1]
    : IMM.includes(b[p]) ? L.leb.readU32(b, p + 1)[0] : null;
  const fnOf = c => i => i < c.imports ? i : i >= c.imports + 2 && i - 2 < c.funcs ? i - 2
    : fail(`Patch references instrumentation function ${i}`, Error);
  const strip = (c, b) => {
    const at = [], out = [], keep = [], fn = fnOf(c);
    for (let p = 0; p < b.length; p = insnEnd(b, p)) at.push(p);
    const match = (pat, k) => {
      const v = pat.map(([op, t], j) => {
        const p = at[k + j], x = p != null && b[p] === op ? imm(b, p) : undefined;
        return x !== undefined && (t === undefined || (typeof t === "function" ? t(x) : t === x)) ? x : undefined;
      });
      return v.includes(undefined) ? null : v;
    };
    for (let k = 0; k < at.length;) {
      const p = at[k], op = b[p];
      const seq = c.seqs.map(([pat, f]) => [pat.length, (v => v && f(v))(match(pat, k))]).find(([, r]) => r);
      if (!seq || seq[1].length) keep.push(at[k + (seq ? seq[0] - 1 : 0)]);
      if (seq) out.push(...seq[1]);
      else if (CALLS.includes(op)) out.push(op, ...L.leb.u32(fn(imm(b, p))));
      else if ((op === 0x23 || op === 0x24) && imm(b, p) >= c.globals) {
        fail(`Patch references instrumentation global ${imm(b, p)}`, Error);
      }
      else out.push(...b.subarray(p, at[k + 1] ?? b.length));
      k += seq ? seq[0] : 1;
    }
    return { out, keep };
  };
  const canonPatch = (a, index, bytes, locals) => {
    const c = a.meta?.canon;
    const b = Uint8Array.from(Array.isArray(bytes) ? bytes : fail("Invalid bytes", TypeError),
      x => int(x, "byte", 0, 256));
    int(index, "function index");
    const none = locals == null || locals.length === 0;
    const ok = none || Array.isArray(locals) && locals.every(t => typeof t === "string");
    if (!ok) fail("Invalid locals", TypeError);
    const lc = none ? {} : { locals: [...locals] };
    if (!c) return { index, bytes: Array.from(b), ...lc };
    const { out } = strip(c, b);
    return { index: fnOf(c)(index), bytes: out, ...lc };
  };
  const omap = (a, f) => {
    try {
      const { keep } = strip(a.meta.canon, f.b.subarray(f.start, f.end));
      const o = bodies(a, "p").find(x => x.index === f.index), offs = [];
      for (let q = o.start; q < o.end; q = insnEnd(o.b, q)) offs.push(q - o.start);
      return keep.length === offs.length ? keep.map((p, i) => [p, offs[i]]) : [];
    } catch { return []; }
  };
  const env = (a, f, orig) => {
    const b = f.b, m = a[orig ? "oscan" : "rscan"] ??= L.scan(b), rd = p => L.leb.readU32(b, p), fi = m.funcImports + bodies(a, orig).indexOf(f);
    const sh = i => orig && a.meta && i >= m.funcImports ? i + 2 : i;
    const e = { locals: [...m.types[m.funcs[fi]]?.params ?? [], ...flat(decls(f))], funcs: {}, types: {}, globals: {} };
    for (let q = f.start; q < f.end; q = insnEnd(b, q)) {
      const op = b[q], [i] = [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x23, 0x24].includes(op) ? rd(q + 1) : [];
      if (op === 0x10 || op === 0x12) e.funcs[sh(i)] = m.types[m.funcs[i]] ?? null;
      else if (op === 0x23 || op === 0x24) e.globals[i] = m.globals[i]?.type ?? null;
      else if (i != null) e.types[i] = m.types[i] ?? null;
    }
    return e;
  };
  const insnEnd = (b, p) => {
    const u = () => { const [v, q] = L.leb.readU32(b, p); p = q; return v; }, s = () => { while (b[p++] & 0x80); };
    const n = (k, f = s) => { while (k-- > 0) f(); }, vt = () => b[p] === 0x63 || b[p] === 0x64 ? (p++, s()) : s(), m = () => (u() & 0x40 && s(), s());
    const op = b[p++], x = op > 0xfa ? u() : 0;
    if ([2, 3, 4, 6].includes(op)) vt();
    else if (op === 0x1f) (vt(), n(u(), () => b[p++] < 2 ? n(2) : s()));
    else if (op === 0x0e) n(u() + 1);
    else if (op === 0x1c) n(u(), vt);
    else if (op === 0x11 || op === 0x13) n(2);
    else if (op >= 0x28 && op <= 0x3e) m();
    else if (op === 0x43 || op === 0x44) p += op === 0x43 ? 4 : 8;
    else if (op >= 0x20 && op <= 0x26 || [7, 8, 9, 12, 13, 16, 18, 20, 21, 24, 0x3f, 0x40, 0x41, 0x42, 0xd0, 0xd2, 0xd5, 0xd6].includes(op)) s();
    else if (op === 0xfb) x === 24 || x === 25 ? (p++, n(3)) : n([2, 3, 4, 5, 8, 9, 10, 17, 18, 19].includes(x) ? 2 : x === 15 || x > 25 ? 0 : 1);
    else if (op === 0xfc) n(x < 8 ? 0 : [8, 10, 12, 14].includes(x) ? 2 : 1);
    else if (op === 0xfd) x < 12 || x === 92 || x === 93 ? m() : x < 14 ? p += 16 : x >= 21 && x <= 34 ? p++ : x >= 84 && x <= 91 && (m(), p++);
    else if (op === 0xfe) x === 3 ? p++ : m();
    return p;
  };
  const sigs = a => a.meta?.types ?? (a.sigs ??= (m => m.funcs.map((t, i) => i < m.funcImports ? null : m.types[t] ?? null))(L.scan(code(a))));
  const callable = (a, index) => {
    const name = exported(a).get(index) ?? a.meta?.fexports?.find(x => x.func === index)?.field;
    const s = a.meta?.tableSlots.find(x => x.func === index);
    return (name != null ? a.exports[name] : s && a.exports[s.table]?.get(s.slot)) || fail("Function is not callable", Error);
  };
  const fexported = a => new Set(a.meta?.fexports?.map(x => x.field));
  const exported = a => {
    const f = fexported(a);
    const fns = Object.entries(a.exports).filter(([k, v]) => typeof v === "function" && /^\d+$/.test(v.name) && !f.has(k));
    return new Map(fns.map(([k, v]) => [+v.name, k]));
  };
  const hidden = a => new Set([...a.meta?.helpers ?? [], ...imports(a).flatMap((d, i) => d.module === "__cetus" ? [i] : []), ...[...exported(a)].flatMap(([i, n]) => a.meta && /^__cetus_/.test(n) ? [i] : [])]);
  const resolve = (a, p, m = mo(a)) => {
    const b = p?.base, o = p?.offsets, dv = new DataView(m.buffer), n = dv.byteLength, w = wide(a, m);
    const u32 = q => q >= 0 && q + (w ? 8 : 4) <= n && (w ? Number(dv.getBigUint64(q, true)) : dv.getUint32(q, true)) || NaN;
    Array.isArray(o) && o.length && o.every(Number.isInteger) && (b?.kind === "static" ? Number.isInteger(b.address) : b?.kind === "global" && typeof b.name === "string") || fail("Invalid pointer", TypeError);
    let q = b.kind === "static" ? u32(b.address) : (() => { try { return Number(findGlobal(a, b.name).acc.get()) || NaN; } catch { return NaN; } })();
    o.forEach((x, i) => q = (i ? u32(q) : q) + x);
    return q >= 0 && q < n ? q : null;
  };
  const findGlobal = (a, name) => globalsOf(a).find(x => x.name === name || x.alt.includes(name)) ?? fail(`Unknown global: ${name}`);
  const combo = e => [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta", String(e.code ?? "").replace(/^(Key|Digit)/, "") || e.key].filter(Boolean).join("+").toLowerCase();
  const onKey = e => {
    const t = e.target;
    if (!hotkeys.length && !skeys.size && !panel || t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName)) return;
    if (panel && combo(e) === panel.key) return void (e.preventDefault?.(), panel.toggle());
    if (panel && t === panel.host) return;
    for (const k of skeys) if (k.combo === combo(e)) (e.preventDefault?.(), k.fn());
    for (const h of hotkeys) if (String(h.combo).toLowerCase() === combo(e)) {
      e.preventDefault?.();
      const tell = r => (panel?.mark(h.combo, r.error), emit("hotkey", { combo: h.combo, action: h.action, ...r })), bad = err => tell({ error: msg(err) });
      try {
        const w = sel();
        const r = w && !KEYS.includes(h.action) ? fwd(w, "hotkeyRun", { hotkey: h }) : runHotkey(h, w ?? need());
        r?.then ? r.then(x => tell(x ?? {}), bad) : tell(r ?? {});
      } catch (err) { bad(err); }
    }
  };
  const KEYS = ["toggleSpeed", "toggleFreezes", "togglePause", "setSpeed", "toggleScript"];
  const ikey = (a, k) => `${a.id}:${k}`;
  const fkey = e => (k => e.memory ? `m${e.memory}:${k}` : k)(e.pointer == null ? e.address : `p:${JSON.stringify(e.pointer)}`);
  const spot = (a, { address, pointer, type: t, memory = 0 }) => {
    const m = mo(a, memory);
    return [m, pointer == null ? at(m, address, L.sizeOf(t)) : resolve(a, pointer, m) ?? fail("Pointer does not resolve", Error)];
  };
  const fz = (a, { address, pointer, type: t, memory = 0 }, on, v) => {
    L.isNum(t) || fail("Hotkey needs a numeric entry");
    const entry = { ...pointer == null ? { address } : { pointer }, type: t, ...memory && { memory } }, frozen = on ?? !freezes.has(ikey(a, fkey(entry)));
    const value = !frozen ? null : v ?? (([m, ad]) => L.formatValue(L.read(new DataView(m.buffer), ad, t), t))(spot(a, entry));
    return H.freeze({ ...entry, memory, value, enabled: frozen }, a), { entry, frozen, value };
  };
  const runHotkey = ({ action, entry = {}, entries, script, value, compare }, a) => {
    if (action === "nextScan" || action === "undoScan") {
      scan.type || fail("No scan in progress", Error);
      if (action === "undoScan") return { count: H.scanUndo().count };
      const b = { ...scan.opts, type: scan.type, compare: str(compare ?? ""), ...value != null && { value: str(value) } };
      return H.scan(b, a).then(r => ({ count: r.count }));
    }
    const cmd = { toggleSpeed: "toggle-speedhack", toggleFreezes: "toggle-freezes", togglePause: "toggle-pause" }[action];
    if (cmd) return void H.command({ name: cmd });
    if (action === "setSpeed") return H.speed({ multiplier: Number(str(value ?? "")) }), { speed };
    if (action === "toggleScript") {
      const s = scripts.get(str(script)), enabled = !s?.running;
      enabled ? runScript({ name: script, code: codes.get(script) ?? fail(`Unknown script: ${script}`) }) : (stopScript(s), scripts.delete(script));
      return { script, enabled };
    }
    if (action === "toggleGroup") {
      Array.isArray(entries) && entries.length || fail("Hotkey needs group entries", TypeError);
      const on = !entries.every(e => freezes.has(ikey(a, fkey(e)))), errs = [];
      const done = entries.flatMap(e => { try { return [fz(a, e, on)]; } catch (err) { return (errs.push(err), []); } });
      if (!done.length && errs.length) throw errs[0];
      return { entries: done };
    }
    if (["toggleFreeze", "freeze", "unfreeze"].includes(action)) return fz(a, entry, { freeze: true, unfreeze: false }[action], action === "freeze" && value != null ? str(value) : undefined);
    const t = entry.type;
    L.isNum(t) || fail("Hotkey needs a numeric entry");
    const [m, ad] = spot(a, entry), cur = L.read(new DataView(m.buffer), ad, t), n = L.parseValue(str(value ?? "1"), t);
    return void store(a, ad, t, action === "set" ? n : action === "inc" ? cur + n : action === "dec" ? cur - n : fail("Invalid action"), true, m);
  };
  const ctypes = b => { try { Array.isArray(b?.ct ?? b?.customTypes) && L.customTypes(b.ct ?? b.customTypes); } catch {} };
  const learn = list => Array.isArray(list) && list.forEach(s => typeof s?.name === "string" && typeof s.code === "string" && codes.set(s.name, s.code));
  const applyConfig = () => {
    const a = sel() ?? active(), q = (t, b) => route(t, b, a).catch(() => {});
    if (!cfgBody || !(a?.worker || a?.memory) || a.cfgDone) return;
    a.cfgDone = true;
    if (!keysSet && Array.isArray(cfgBody.hotkeys)) hotkeys = cfgBody.hotkeys;
    if (!cfgScripts) (cfgScripts = true, learn(cfgBody.hotkeyScripts), Array.isArray(cfgBody.scripts) && cfgBody.scripts.forEach(s => typeof s?.name === "string" && typeof s.code === "string" && runScript(s)));
    for (const e of Array.isArray(cfgBody.table) ? cfgBody.table : []) {
      const loc = { address: e.address, pointer: e.pointer, type: e.type, memory: e.memory ?? 0 };
      const now = async () => (v => v == null ? fail("Pointer does not resolve", Error) : L.formatValue(v, e.type))(
        (await route("readValues", { items: [loc] }, a)).values[0]);
      const fz = async () => q("freeze", { ...loc, value: e.freezeValue ?? await now(), enabled: true, mode: e.mode, step: e.step });
      if (e.frozen) fz().catch(() => {});
      const brk = { ...e.watchBreak && { break: true }, ...e.watchCondition && { condition: e.watchCondition } };
      const kinds = a.instrumented ? new Set([].concat(e.watch ?? [])) : [];
      for (const kind of kinds) q("watch", { ...loc, size: L.sizeOf(e.type), kind, enabled: true, ...brk });
    }
    const gs = Array.isArray(cfgBody.globals) ? cfgBody.globals : [];
    for (const g of gs.filter(g => g?.hash === a.hash || !gs.some(x => x?.global === g?.global && x.hash === a.hash))) {
      q("freeze", { global: g.global, value: g.value, enabled: true, mode: g.mode, step: g.step });
    }
    if (cfgBody.trainer && typeof cfgBody.trainer === "object") trainerPanel(cfgBody.trainer);
  };
  const CSS = `.p{font:12px/1.4 system-ui,sans-serif;color:#eee;background:#1e1e1ee6;border:1px solid #555;border-radius:6px;min-width:240px;max-height:70vh;overflow:auto}
    .h{display:flex;gap:6px;align-items:center;padding:4px 6px;background:#333;cursor:move;user-select:none}.t{flex:1;font-weight:600}
    .r{display:flex;gap:6px;align-items:center;padding:2px 6px}.d{flex:1}.v{min-width:64px;text-align:right;font-family:monospace}
    .g{padding:2px 6px;color:#aaa;font-weight:600}.k{color:#9cf;font-size:11px}.e{outline:1px solid #e55}input[type=text],select{width:72px}`;
  const trainerPanel = T => {
    if (panel || L.worker || typeof document === "undefined" || !document.documentElement) return;
    const mk = (tag, props = {}, ...kids) => (n => (n.append(...kids), n))(Object.assign(document.createElement(tag), props));
    const host = mk("div"), root = host.attachShadow({ mode: "closed" }), body = mk("div"), rows = [], key = String(T.toggleKey ?? "Ctrl+Shift+T");
    const keys = h => Array.isArray(h) && h.length ? mk("span", { className: "k", textContent: h.join(", ") }) : "", tags = [];
    const line = (h, ...kids) => (n => (tags.push([Array.isArray(h) ? h.map(c => String(c).toLowerCase()) : [], n]), n))(mk("div", { className: "r" }, ...kids, keys(h)));
    const req = (t, b) => route(t, b, sel() ?? need());
    const frozen = async k => (await req("state", {})).freezes.some(f => fkey(f) === k);
    const act = (n, f) => (async () => f())().then(() => (n.classList.remove("e"), n.title = ""),
      err => (n.classList.add("e"), n.title = msg(err))).then(() => refresh());
    const fold = mk("button", { textContent: "-", title: "Collapse" }), bar = mk("div", { className: "h", title: `${key} shows or hides this panel` }, mk("span", { className: "t", textContent: String(T.title ?? "Trainer") }), fold);
    fold.onclick = () => (fold.textContent = (body.hidden = !body.hidden) ? "+" : "-", refresh());
    bar.onpointerdown = e => {
      if (e.target === fold) return;
      const r = host.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = m => Object.assign(host.style, { left: `${m.clientX - dx}px`, top: `${m.clientY - dy}px`, right: "auto" });
      const up = () => (removeEventListener("pointermove", move, true), removeEventListener("pointerup", up, true));
      addEventListener("pointermove", move, true);
      addEventListener("pointerup", up, true);
    };
    const list = (Array.isArray(T.entries) ? T.entries : []).filter(e => L.isType(e?.type) && (e.pointer != null || Number.isInteger(e.address)));
    for (const g of [null, ...new Set(list.map(e => e.group).filter(Boolean))]) {
      if (g) body.append(mk("div", { className: "g", textContent: String(g) }));
      for (const e of list.filter(e => (e.group || null) === g)) {
        const num = L.isNum(e.type), loc = { address: e.address, pointer: e.pointer, type: e.type, memory: e.memory ?? 0, ...e.length && { length: e.length } };
        const opts = num && Array.isArray(e.options) && e.options.length ? e.options : null, live = mk("span", { className: "v" });
        const fr = num ? mk("input", { type: "checkbox", className: "f", title: "Freeze" }) : "";
        const inp = opts ? mk("select", {}, ...opts.map(o => mk("option", { value: String(o.value), textContent: String(o.label ?? o.value) }))) : mk("input", { type: "text", placeholder: "Set" });
        const cur = async () => (v => v == null ? null : num ? L.formatValue(v, e.type) : String(v))(
          (await req("readValues", { items: [loc] })).values[0]);
        const fz = async v => req("freeze", { ...loc, value: v, enabled: v != null, mode: e.mode, step: e.step });
        const lost = () => fail("Pointer does not resolve", Error);
        if (fr) fr.onchange = () => act(fr, async () => fz(fr.checked ? await cur() ?? lost() : null));
        inp.onchange = () => act(inp, async () => {
          await req("write", { ...loc, value: inp.value });
          if (num && await frozen(fkey(loc))) await fz(inp.value);
        });
        body.append(line(e.hotkeys, mk("span", { className: "d", textContent: String(e.description || (e.pointer ? "pointer" : `0x${e.address.toString(16)}`)) }), live, fr, inp));
        rows.push(async fs => {
          let v = null;
          try { v = await cur(); } catch {}
          live.textContent = v == null ? "?" : opts?.find(o => String(o.value) === v)?.label ?? v;
          if (fr) fr.checked = fs.has(fkey(loc));
          if (opts && root.activeElement !== inp && v != null) inp.value = v;
        });
      }
    }
    const sl = (Array.isArray(T.scripts) ? T.scripts : []).filter(s => typeof s?.name === "string" && typeof s.code === "string");
    learn(sl.filter(s => !codes.has(s.name)));
    if (sl.length) body.append(mk("div", { className: "g", textContent: "Scripts" }));
    for (const s of sl) {
      const on = mk("input", { type: "checkbox", className: "s", title: "Enable" });
      on.onchange = () => act(on, () => on.checked ? runScript({ name: s.name, code: codes.get(s.name) }) : (stopScript(scripts.get(s.name)), scripts.delete(s.name)));
      body.append(line(s.hotkeys, mk("span", { className: "d", textContent: s.name }), on));
      rows.push(() => on.checked = !!scripts.get(s.name)?.running);
    }
    const scanKey = h => h?.action === "nextScan" || h?.action === "undoScan";
    const other = hotkeys.filter(h => !h?.entry && !h?.entries && !h?.script && !scanKey(h) && typeof h?.combo === "string");
    if (other.length) body.append(mk("div", { className: "g", textContent: "Keys" }), ...other.map(h => line([h.combo],
      mk("span", { className: "d", textContent: `${h.action}${h.value == null ? "" : ` ${h.value}`}` }))));
    root.append(mk("style", { textContent: CSS }), mk("div", { className: "p" }, bar, body));
    for (const t of ["keydown", "keyup", "keypress"]) root.addEventListener(t, e => /^(INPUT|SELECT)$/.test(e.target?.tagName) && e.target.type !== "checkbox" && e.stopPropagation());
    host.style.cssText = "all:initial;position:fixed;top:8px;right:8px;z-index:2147483647";
    let timer = null;
    const refresh = () => timer && !body.hidden && (async () => (await req("state", {})).freezes)()
      .then(fs => rows.forEach(r => r(new Set(fs.map(fkey)))), () => rows.forEach(r => r(new Set())));
    const show = on => {
      host.style.display = on ? "block" : "none";
      timer = on ? timer ?? sI(refresh, 250) : cI(timer) ?? null;
      refresh();
    };
    const mark = (c, err) => tags.forEach(([cs, n]) => cs.includes(String(c).toLowerCase()) && (n.classList.toggle("e", !!err), n.title = err ? `Hotkey ${c}: ${err}` : ""));
    panel = { host, key: key.toLowerCase(), toggle: () => show(!timer), mark };
    document.documentElement.append(host);
    show(true);
  };
  const vmods = [], lanes = new WeakMap(), vmod = mut => new OM(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 10, 2, 96, 0, 1, 126, 96, 2, 126, 126, 0, 2, 8, 1, 1, 109, 1, 103, 3, 123, mut,
    3, 4, 3, 0, 0, 1, 7, 13, 3, 1, 97, 0, 0, 1, 98, 0, 1, 1, 115, 0, 2, 10, mut ? 31 : 20, 3, 7, 0, 35, 0, 253, 29, 0, 11, 7, 0, 35, 0, 253, 29, 1, 11, ...mut ? [13, 0, 32, 0, 253, 18, 32, 1, 253, 30, 1, 36, 0, 11] : [2, 0, 11]]));
  const v128 = (g, mut) => {
    const h = lanes.get(g) ?? lanes.set(g, new OI(vmods[+mut] ??= vmod(+mut), { m: { g } }).exports).get(g);
    return { get: () => new Uint8Array(new BigInt64Array([h.a(), h.b()]).buffer), set: v => (([lo, hi]) => h.s(lo, hi))(new BigInt64Array(v.slice(0, 16).buffer)) };
  };
  const access = (t, mutable, raw) => raw instanceof WebAssembly.Global ? t === "v128" ? v128(raw, mutable) : { get: () => raw.value, set: v => raw.value = v, g: raw } : raw === undefined || mutable ? null : { get: () => raw };
  const guess = g => {
    const r = g.type?.(), v = (() => { try { return { v: g.value }; } catch {} })();
    if (r) return { type: { anyfunc: "funcref" }[r.value] ?? r.value, mutable: r.mutable };
    if (!v) for (const mutable of [true, false]) try { return v128(g, mutable), { type: "v128", mutable }; } catch {}
    const t = !v ? "ref" : typeof v.v === "bigint" ? "i64" : Number.isInteger(v.v) ? "i32" : typeof v.v === "number" ? "f64" : "ref";
    return { type: t, mutable: !!v && (() => { try { g.value = v.v; return true; } catch { return false; } })(), ...t !== "ref" && { parse: t === "i64" ? t : "f64" } };
  };
  const globalsOf = a => a.gl ??= (() => {
    const x = a.exports, src = a.original ?? a.bytes, m = src && L.scan(src);
    if (!m) return Object.entries(x).filter(([, g]) => g instanceof WebAssembly.Global).map(([name, g]) => (r => ({ name, index: null, ...r, acc: access(r.type, r.mutable, g), alt: [] }))(guess(g)));
    return m.globals.map(({ type: t, mutable, import: im }, index) => {
      const exp = a.meta?.globals.find(g => g.index === index)?.name, own = m.gl[index], raw = exp ? x[exp] : own != null ? x[own] : a.gimps?.[index];
      return { name: m.names.globals[index] ?? own ?? (im ? `${im.module}.${im.field}` : `global${index}`), index, type: t, mutable, acc: access(t, mutable, raw), alt: [exp, own], fns: a.meta?.names.functions ?? { ...m.fn, ...m.names.functions } };
    });
  })();
  const shown = ({ type: t, acc, fns = {} }) => {
    try {
      const v = acc.get();
      return SC.includes(t) ? v : t === "v128" ? show(v, "aob") : v === null ? "null" : typeof v === "function" ? `func ${fns[v.name] ?? v.name}`
        : typeof v === "string" ? JSON.stringify(v) : typeof v === "object" ? Object.prototype.toString.call(v) : String(v);
    } catch { return null; }
  };
  const gparse = (g, s) => SC.includes(g.parse ?? g.type) ? L.parseValue(s, g.parse ?? g.type) : g.type === "v128" ? (({ bytes, mask }) => bytes.length === 16 && mask.every(b => b === 255) ? bytes
    : fail("v128 needs 16 hex bytes"))(L.parseAob(s)) : s.trim() === "null" ? null : fail("Reference globals can only be set to null");
  const report = (s, e) => {
    const m = s.error = msg(e), t = pn(), seen = s.seen ??= new Map();
    if (seen.size > 64) for (const [k, v] of seen) t - v >= 1000 && seen.delete(k);
    if (!(t - seen.get(m) < 1000)) (seen.set(m, t), emit("scriptError", { name: s.name, message: m }));
    return ERR;
  };
  const guard = (s, f) => { try { return f(); } catch (e) { return report(s, e); } };
  const frame = f => raf ? raf(f) : sT(f, 16), loop = () => (ticks.forEach(t => t()), (looping = ticks.size > 0) && frame(loop));
  const stopScript = s => {
    if (!s?.running) return;
    const ret = s.ret;
    s.ret = null;
    if (typeof ret === "function") guard(s, ret);
    s.running = false;
    s.undo.splice(0).reverse().forEach(f => { try { f(); } catch {} });
  };
  const runScript = ({ name, code }) => {
    stopScript(scripts.get(name));
    codes.set(name, code);
    const s = { name, running: true, error: null, undo: [] }, undo = f => s.undo.push(f), own = (set, x) => (set.add(x), undo(() => set.delete(x)), x);
    const val = (t, v) => L.isNum(type(t)) ? L.parseValue(String(v), t) : String(v), bound = x => {
      const before = new Map(freezes), r = H.freeze({ ...x, enabled: true }, need());
      for (const [k, f] of freezes) if (before.get(k) !== f) undo(() => freezes.get(k) === f && (before.has(k) ? freezes.set(k, before.get(k)) : freezes.delete(k), freezeTick()));
      return r;
    };
    const api = { read: (address, t, length) => H.readValues({ items: [{ address, type: t, length }] }, need()).values[0],
      write: (address, t, v) => store(need(), address, t, val(t, v), false),
      patch: (address, t, v) => {
        const a = need(), m = mo(a), n = L.toBytes(val(t, v), t).length, old = mem(m).slice(at(m, address, n), address + n);
        store(a, address, t, val(t, v), false, m);
        undo(() => instances.includes(a) && address + n <= m.buffer.byteLength && (mem(m).set(old, address), rearm(a, address, n, m)));
      },
      call: (f, ...args) => (a => typeof f === "string" ? a.exports[f] : callable(a, f))(need())(...args),
      hookExport: (k, { before, after } = {}) => void own(hooks.get(k) ?? hooks.set(k, new Set()).get(k), { before, after, s }),
      onHit: fn => {
        const h = own(hitFns, x => guard(s, () => fn(x)) === ERR && hitFns.delete(h));
      },
      onTick: fn => {
        const t = own(ticks, () => guard(s, fn) === ERR && ticks.delete(t));
        looping || (looping = true, frame(loop));
      },
      hotkey: (c, fn) => void (k => own(skeys, k))({ combo: String(c).toLowerCase(), fn() { guard(s, fn) === ERR && skeys.delete(this); } }),
      scan: p => H.scan(p, need()), pointer: (base, offsets) => resolve(need(), { base, offsets }), memory: () => new DataView(mo(need()).buffer),
      freeze: (address, t, value, mode) => bound({ address, type: t, value: String(value), mode }),
      freezeGlobal: (global, value, mode) => bound({ global, value: String(value), mode }),
      watch: (address, n, kind = "write", brk = false) => {
        const same = x => !x?.pointer && x?.address === address && x.size === n && x.kind === kind, had = slots.some(same);
        H.watch({ address, size: n, kind, enabled: true, ...brk && { break: true } }, need());
        const w = slots.find(same);
        if (!had) undo(() => slots[w.slot] === w && unwatch(w.slot));
        return w.slot;
      },
      log: (...x) => emit("scriptLog", { name, text: x.map(v => typeof v === "object" && v ? L.encode(v) : String(v)).join(" ") }) };
    for (const [k, f] of Object.entries(api)) api[k] = (...x) => s.running ? f(...x) : fail("Script is not running", Error);
    scripts.set(name, s);
    s.ret = guard(s, () => new Function("cetus", code)(api));
    if (s.ret === ERR) stopScript(s);
  };
  const hookFn = (k, f) => function (...args) {
    const hs = [...hooks.get(k) ?? []], run = (h, g) => (v => (v === ERR && (h.dead = true, hooks.get(k)?.delete(h)), v))(guard(h.s, g));
    for (const h of hs) if (h.before) (r => Array.isArray(r) && (args = r))(run(h, () => h.before(args)));
    let r = f.apply(this, args);
    for (const h of hs) if (h.after && !h.dead) (v => v !== undefined && v !== ERR && (r = v))(run(h, () => h.after(r, args)));
    return r;
  };
  const XD = Object.getOwnPropertyDescriptor(WebAssembly.Instance.prototype, "exports");
  if (XD?.get) Object.defineProperty(WebAssembly.Instance.prototype, "exports", { ...XD, get() {
    const x = XD.get.call(this), w = wraps.get(this);
    return !w || !hooks.size ? x : w.view ??= new Proxy(Object.assign(Object.create(null), x), { get: (t, k) => typeof x[k] === "function" && (hooks.get(k)?.size || w.fns.has(k))
      ? w.fns.get(k) ?? w.fns.set(k, hookFn(k, x[k])).get(k) : x[k] });
  } });
  const jsPath = path => {
    const ks = str(path).split("."), k = ks.pop(), o = ks.reduce((o, k) => o?.[k], globalThis);
    return o && typeof o === "object" ? { o, k } : fail("Unknown path");
  };
  const jsWalk = () => {
    const out = [], seen = new WeakSet([L, globalThis]), q = [[globalThis, "", 0]];
    for (let i = 0; i < q.length; i++) {
      const [o, path, d] = q[i];
      try {
        for (const k of Object.getOwnPropertyNames(o)) {
          const x = Object.getOwnPropertyDescriptor(o, k), v = x && "value" in x ? x.value : undefined, p = path ? `${path}.${k}` : k;
          if (k.includes(".")) continue;
          if (typeof v === "number" && x.writable || x?.get && jsFrozen.has(p)) out.push({ o, k, path: p });
          else if (v && typeof v === "object" && d < 6 && q.length < 2e5 && !ArrayBuffer.isView(v) && !seen.has(v)) q.push([v, p, d + 1]) && seen.add(v);
        }
      } catch {}
    }
    return out;
  };

  const scanNow = async (b, a) => {
    const t = ["all", "group"].includes(b.type) ? b.type : type(b.type), val = v => v == null ? undefined : L.isNum(t) ? L.parseValue(str(v), t) : str(v), sc = scan, op = sc.type ? "next" : "first";
    const tolerance = b.tolerance == null ? 0 : typeof b.tolerance === "number" && b.tolerance >= 0 ? b.tolerance : fail("Invalid tolerance");
    const p = { ...b, value: val(b.value), value2: val(b.value2), tolerance, decimals: b.decimals == null ? 0 : int(b.decimals, "decimals", 0, 16), lower: opt(b.lower), upper: opt(b.upper) };
    const saved = sc.save(), st = OW && (b.worker ?? Math.min(p.upper ?? Infinity, sc.getBuffer().byteLength) - (p.lower ?? 0) >= 2 ** 26) ? await inWorker({ op, p, state: sc.save(), saved: sc.saved, ct: L.customTypes() }, new Uint8Array(sc.getBuffer()).slice().buffer) : null;
    if (!st) sc[op](p);
    else if (Object.assign(sc, st), op === "next") sc.push(saved);
    sc.opts = (({ value, value2, compare, type, pause, memory, ...o }) => o)(b);
    return { count: sc.count, rows: sc.rows(100), worker: !!st };
  };
  const H = {
    state: () => {
      const a = active();
      const ws = workers.map(w => ({ ...wpub(w), synced: w.acked === syncs }));
      return { instances: [...instances.map(pub), ...ws], active: (sel() ?? a)?.id ?? null, scan: a && a === owner && scan.type ? { count: scan.count, type: scan.type, saved: [...scan.saved.keys()] } : null,
        freezes: freezeList(a), freezesSuspended: suspended, undo: undos.length, hotkeys, watches: pubSlots(),
        hits: [...hits.values()], globalHits: [...globalHits.values()],
        bpHits: [...bpHits.values()], speed, options: a?.meta?.options ?? null, accesses: accessList(),
        scanDepth: a && a === owner ? scan.history.length : 0, scripts: [...scripts.values()].map(({ name, running, error }) => ({ name, running, error })), snapshots: snapList(), jsFreezes: [...jsFrozen].map(([path, f]) => ({ path, value: f.value })) };
    },
    scan: async (b, a) => {
      const s = (b.pause == null || typeof b.pause === "boolean" || fail("Invalid pause", TypeError)) && b.pause && speed;
      if (b.memory != null) H.selectMemory({ index: b.memory }, a);
      if (s) setSpeed(0);
      try { return await scanNow(b, a); } finally { if (s && !speed) setSpeed(s); }
    },
    scanRows: ({ offset, limit }) => ({ count: scan.count, rows: scan.rows(int(limit, "limit", 1, 501), int(offset, "offset")) }),
    scanUndo: () => scan.undo(),
    scanSave: ({ name }) => ({ saved: scan.saveAs(str(name).trim() || fail("Missing name")) }),
    scanReset: (b, a) => (scan = session(a), {}),
    selectMemory: ({ index }, a) => {
      a.mems.some(x => x.index === index) || fail(`Unknown memory: ${index}`);
      if (a.mi !== index) (a.mi = index, [scan, ptrs] = [session(a), []]);
      return { memory: index };
    },
    strings: ({ encoding, minLength, lower, upper, offset, memory }, a) => L.findStrings(mem(mo(a, memory)), { encoding: ["ascii", "utf16", "utf8"].includes(encoding) ? encoding : fail("Invalid encoding"),
      minLength: int(minLength, "minimum length", 1), lower: opt(lower), upper: opt(upper), offset: int(offset ?? 0, "offset") }),
    read: ({ address, length, memory }, a) => {
      const m = mo(a, memory);
      return { address: at(m, address), bytes: Array.from(mem(m).subarray(address, address + int(length, "length", 0, 4097))), size: m.buffer.byteLength };
    },
    readValues: ({ items }, a) => {
      Array.isArray(items) && items.length <= 500 || fail("Invalid items", TypeError);
      const one = ({ address, pointer, type: t, length, group: g, memory }) => {
        const m = mo(a, memory), u8 = mem(m), dv = new DataView(m.buffer);
        const G = t === "group" && group(str(g)), n = G ? G.size : L.isNum(t) ? L.sizeOf(t) : type(t) && int(length, "length", 1, 4097);
        if (pointer != null && (address = resolve(a, pointer, m)) == null || int(address, "address") + n > u8.length) return null;
        return G ? gshow(G.els, u8.subarray(address, address + n)) : L.isNum(t) ? L.read(dv, address, t) : show(u8.subarray(address, address + n), t);
      };
      return { values: items.map(it => { try { return one(it); } catch { return null; } }) };
    },
    write: ({ address, pointer, type: t, value, memory }, a) => {
      const m = mo(a, memory), ad = pointer == null ? address : resolve(a, pointer, m) ?? fail("Pointer does not resolve", Error);
      return store(a, ad, t, L.isNum(type(t)) ? L.parseValue(str(value), t) : str(value), true, m);
    },
    writeBytes: ({ address, bytes: b, memory }, a) => {
      Array.isArray(b) && b.length && b.length <= 2 ** 20 && b.every(x => Number.isInteger(x) && x >= 0 && x < 256) || fail("Invalid bytes", TypeError);
      return store(a, address, "raw", Uint8Array.from(b), true, mo(a, memory));
    },
    load: ({ address, bytes: b, memory }, a) => {
      const u8 = typeof b === "string" && b.length <= 12 * 2 ** 20 ? (() => { try { return Uint8Array.fromBase64?.(b) ?? Uint8Array.from(atob(b), c => c.charCodeAt(0)); } catch {} })()
        : Array.isArray(b) && b.length <= 2 ** 23 && b.every(x => Number.isInteger(x) && x >= 0 && x < 256) ? Uint8Array.from(b) : null;
      u8?.length && u8.length <= 2 ** 23 || fail("Invalid bytes", TypeError);
      return store(a, address, "raw", u8, false, mo(a, memory));
    },
    snapshot: (q, a, { op, name, memory = a.mi } = q) => {
      ["save", "restore", "delete", "list"].includes(op) || fail(`Invalid op: ${op}`);
      const k = op === "list" ? null : str(name).trim() || fail("Missing name"), s = snaps.get(k);
      if (op === "save") {
        const m = mo(a, memory);
        m.buffer.byteLength <= SNAP || fail("Snapshot exceeds 256 MiB");
        snaps.delete(k);
        snaps.set(k, { a, m, mi: memory, mem: mem(m).slice(), gs: instances.flatMap(i => numGlobals(i).flatMap(g => { try { return [[g, g.acc.get()]]; } catch { return []; } })) });
        while (snaps.size > 4 || [...snaps.values()].reduce((n, x) => n + x.mem.length, 0) > SNAP) snaps.delete(snaps.keys().next().value);
      } else if (op !== "list") {
        s || fail(`Unknown snapshot: ${k}`);
        if (op === "delete") snaps.delete(k);
        else {
          instances.includes(s.a) && s.a.mems.some(x => x.memory === s.m) || fail("Snapshot instance is gone", Error);
          const n = Math.min(s.mem.length, s.m.buffer.byteLength);
          mem(s.m).set(s.mem.subarray(0, n));
          s.gs.forEach(([g, v]) => { try { g.acc.set(v); } catch {} });
          if (s.a.wname) rearm(s.a, 0, n, s.m);
        }
      }
      return { snapshots: snapList() };
    },
    find: ({ from, type: t, value, memory }, a) => {
      const u8 = mem(mo(a, memory)), num = L.isNum(type(t)), q = pattern(num ? L.toBytes(L.parseValue(str(value), t), t) : str(value), t), n = q.bytes.length || fail("Missing value");
      for (let i = int(from, "address"); i + n <= u8.length; i++) if (matches(u8, i, q)) return { address: i };
      return { address: null };
    },
    freeze: (q, a, { address, pointer, type: t, value, enabled, mode = "exact", step, global, memory = a.mi } = q) => {
      MODES.includes(mode) || fail("Invalid mode");
      const g = global == null ? null : findGlobal(a, str(global)), m = !g && mo(a, memory), key = ikey(a, g ? `g:${g.name}` : fkey({ address, pointer, memory }));
      if (g) t = g.parse ?? g.type;
      else L.isNum(t) ? pointer != null ? resolve(a, pointer, m) : at(m, address, L.sizeOf(t)) : fail("Freeze needs a numeric type");
      if (enabled) {
        g && (g.mutable || fail("Global is immutable", Error), SC.includes(t) || fail("Freeze needs a numeric type"), g.acc?.g || fail("Global is not accessible", Error));
        const f = { ...g ? { global: g.name } : pointer != null ? { pointer } : { address }, type: t, value: L.parseValue(str(value), t), ...!g && memory && { memory },
          ...mode !== "exact" && { mode }, ...mode === "step" && { step: L.parseValue(str(step), t) } };
        freezes.set(key, Object.assign(f, { a }, g && { g: g.acc.g }));
        hookRaf();
        applyFreezes();
      } else freezes.delete(key);
      freezeTick();
      return { freezes: freezeList(a) };
    },
    undo: () => {
      const u = undos.pop();
      if (u?.kind === "write" && instances.includes(u.a) && u.address + u.bytes.length <= u.m.buffer.byteLength) (mem(u.m).set(u.bytes, u.address), rearm(u.a, u.address, u.bytes.length, u.m));
      else if (u?.kind === "global") u.set(u.value);
      return { undone: u ? u.name == null ? { kind: u.kind, address: u.address } : { kind: u.kind, name: u.name } : null };
    },
    hotkeys: ({ bindings, scripts: list }) => (hotkeys = Array.isArray(bindings) ? bindings : fail("Invalid bindings", TypeError), keysSet = true, learn(list), {}),
    command: ({ name }) => {
      if (name === "toggle-speedhack") setSpeed(speed === 1 ? lastSpeed : 1);
      else if (name === "toggle-freezes") sync(suspended = !suspended);
      else if (name === "toggle-pause") setSpeed(speed ? 0 : before);
      else fail(`Unknown command: ${name}`);
      emit("command", { name, speed, freezesSuspended: suspended });
      return { speed, freezes: freezeList(), freezesSuspended: suspended };
    },
    watchAt: (q, a, { address, pointer, size: n, memory = a.mi } = q) => {
      a.instrumented && a.wname || fail("Instance is not instrumented", Error);
      memory === 0 || fail("Watches only work on memory 0");
      [1, 2, 4, 8].includes(n) || fail("Invalid size");
      const ad = at(a.memory, pointer == null ? address : resolve(a, pointer, a.memory) ?? fail("Pointer does not resolve", Error), n);
      return { address: ad, precise: !!a.meta?.options?.precise };
    },
    watch: (q, a, { address, pointer, size: n, kind, enabled, break: brk, condition: cnd, memory = a.mi } = q) => {
      a.instrumented && (a.worker || a.wname) || fail("Instance is not instrumented", Error);
      memory === 0 || fail("Watches only work on memory 0");
      [1, 2, 4, 8].includes(n) || fail("Invalid size");
      ["write", "read"].includes(kind) || fail("Invalid kind");
      const pk = pointer == null ? null : JSON.stringify(pointer), m = a.memory;
      pk || a.worker || at(m, address, n);
      const i = slots.findIndex(s => s && s.size === n && s.kind === kind && (pk ? JSON.stringify(s.pointer) === pk : !s.pointer && s.address === address));
      if (enabled && i < 0) {
        const f = slots.indexOf(null);
        f >= 0 || fail("All 4 watch slots are in use", Error);
        const x = pk && ((a.worker ? address : resolve(a, pointer, m)) ?? fail("Pointer does not resolve", Error));
        if (pk) address = a.worker ? x : at(m, x, n);
        slots[f] = { slot: f, address, size: n, kind, ...pk && { pointer }, ...brk && { break: true },
          ...cond(cnd) && { condition: cond(cnd) }, i: a };
        flags[f] = kind === "read" ? 2 : (a.worker ? q.precise : a.meta?.options?.precise) ? 4 : 1;
        counts.delete(`w${f}`);
        if (!a.worker) (watchFn(a)(f, address, n, flags[f]), olds[f] = uval(a, [address, n]));
      } else if (enabled && (brk != null || cnd !== undefined)) {
        if (brk != null) brk ? slots[i].break = true : delete slots[i].break;
        if (cnd !== undefined) cond(cnd) ? slots[i].condition = cond(cnd) : delete slots[i].condition;
      }
      else if (!enabled && i >= 0) unwatch(i);
      sync();
      return { watches: pubSlots() };
    },
    breakpoint: ({ func, offset, break: b, condition: c }) => {
      int(func, "function index");
      int(offset, "offset");
      typeof b === "boolean" || fail("Invalid break", TypeError);
      c === undefined || c === null || typeof c === "string" || fail("Invalid condition", TypeError);
      const k = bkey({ func, offset });
      bpBreaks.set(k, b);
      if (c !== undefined) cond(c) ? bpConds.set(k, cond(c)) : bpConds.delete(k);
      sync();
      return { bpHits: [...bpHits.values()] };
    },
    select: ({ id }) => {
      const w = workers.find(x => x.id === id);
      w || instances.some(i => i.id === id) || fail("Unknown instance");
      selected = id;
      return { active: w ? id : need().id };
    },
    siteAt: ({ func, offset }, a) => ({ site: a.meta?.sites.findIndex(s => s.func === func && s.offset === offset) ?? -1,
      name: fname(func) }),
    hotkeyRun: ({ hotkey }, a) => runHotkey(hotkey, a) ?? {},
    accesses: (q, a, { func, offset, enabled } = q) => {
      const site = a.worker ? q.site : a.meta?.sites.findIndex(s => s.func === func && s.offset === offset) ?? -1;
      site >= 0 || fail("Instruction is not traceable", Error);
      if (!enabled) armed.delete(site);
      else if (!armed.has(site)) {
        armed.size < 4 || fail("All 4 access slots are in use", Error);
        armed.set(site, { func, offset, map: new Map(), name: a.worker ? q.name : null });
      }
      a.worker || apply(a, [], [...armed.keys()]);
      sync();
      return { accesses: accessList() };
    },
    traces: () => ({ calls: [...calls.values()] }),
    stepTrace: ({ func }) => {
      int(func, "function index");
      const s = steps.get(func);
      return { steps: (s?.offsets ?? []).map(offset => ({ offset })), truncated: !!s?.truncated };
    },
    codeFilter: ({ op }, a) => {
      ["start", "executed", "notExecuted", "reset"].includes(op) || fail(`Invalid op: ${op}`);
      if (op === "reset") return cover = null, { count: 0, rows: [] };
      const cov = a.meta?.options.coverage && a.meta.cov || fail("Coverage is off: enable it and reload the game", Error);
      const now = new Map(cov.map(c => [c.func, a.exports[c.field].value >>> 0]));
      if (op === "start") cover = { a, last: now };
      else {
        cover?.a === a || fail("Start a code filter first", Error);
        for (const [f, v] of cover.last) (now.get(f) !== v) === (op === "executed") ? cover.last.set(f, now.get(f)) : cover.last.delete(f);
      }
      const rows = [...cover.last.keys()].slice(0, 500).map(func => ({ func, name: a.meta.names.functions[func] ?? null, calls: now.get(func) }));
      return { count: cover.last.size, rows };
    },
    function: ({ index, original }, a) => functionBody(a, index, !!original),
    canonPatch: ({ index, bytes, locals }, a) => canonPatch(a, index, bytes, locals),
    globals: (b, a) => ({ globals: globalsOf(a).map(g => ({ name: g.name, index: g.index, type: g.type, mutable: g.mutable, value: shown(g) })) }),
    setGlobal: ({ name, value }, a) => {
      const g = findGlobal(a, str(name));
      g.mutable || fail("Global is immutable", Error);
      g.acc?.set || fail("Global is not accessible", Error);
      const v = gparse(g, str(value));
      pushUndo({ kind: "global", name, set: g.acc.set, value: g.acc.get() });
      g.acc.set(v);
      return {};
    },
    pointerScan: async (q, a, { address, maxDepth, maxOffset, memory = a.mi } = q) => {
      const m = mo(a, memory), w = wide(a, m), gt = w ? "i64" : "i32", ranges = (a.meta?.dataRanges ?? []).filter(r => (r[2] ?? 0) === memory);
      const globals = globalsOf(a).filter(g => g.type === gt).map(g => ({ name: g.name, value: Number(shown(g)) })).filter(g => Number.isSafeInteger(g.value));
      const args = [at(m, address), { maxDepth: int(maxDepth, "depth", 1, 6), maxOffset: int(maxOffset, "offset", 0, 4097), ranges, globals, wide: w }];
      const u8 = mem(m), big = u8.length > 2 ** 28, oom = () => fail("Pointer scan failed: out of memory", RangeError);
      const buf = async () => isShared(m.buffer) ? m.buffer : u8.slice().buffer;
      const r = OW && await buf().then(b => inWorker({ args }, b)).catch(e => big ? null : Promise.reject(e));
      ptrs = r || (OW && big ? oom() : pointers(u8, ...args));
      return { count: ptrs.length, rows: ptrs };
    },
    pointerRescan: ({ address, value, type: t, pointers: list, memory }, a) => {
      list == null || Array.isArray(list) && list.length <= 1e5 || fail("Invalid pointers", TypeError);
      const m = mo(a, memory), dv = new DataView(m.buffer), ok = address != null ? (at(m, address), q => q === address)
        : L.isNum(t) ? (f => q => q != null && q + L.sizeOf(t) <= dv.byteLength && f(L.read(dv, q, t)))(tester(t, { compare: "eq", value: str(value) })) : fail("Rescan needs an address or a numeric type");
      ptrs = (list ?? ptrs).filter(p => ok(resolve(a, p, m)));
      return { count: ptrs.length, rows: ptrs };
    },
    dump: (q, a, { what, lower, upper, memory = a.mi, id = a.id } = q) => {
      const m = what === "memory" && mo(a, memory);
      const b = m ? mem(m).slice(...range({ lower: opt(lower), upper: opt(upper) }, m.buffer.byteLength)) : what === "original" ? a.original ?? fail("Module bytes are unavailable", Error)
        : what === "instrumented" ? a.meta ? a.bytes : fail("Instance is not instrumented", Error) : fail("Invalid dump");
      const file = m ? `memory-${id}${memory ? `-${memory}` : ""}.bin`
        : `module-${id}${what === "original" ? "" : ".instrumented"}.wasm`;
      return L.worker ? { size: b.length, file, bytes: b } : (save(b, file), { size: b.length });
    },
    functions: (b, a) => {
      const imp = imports(a), ts = sigs(a), ex = exported(a), hide = hidden(a);
      const fx = new Set(a.meta?.fexports?.map(x => x.func));
      return { functions: bodies(a).map(f => f.index).concat(imp.map((d, i) => i)).sort((x, y) => x - y).filter(i => !hide.has(i)).map(index => ({ index,
        name: a.meta?.names.functions[index] ?? ex.get(index) ?? (imp[index] ? `${imp[index].module}.${imp[index].name}` : null), exported: ex.has(index), imported: index < imp.length,
        internal: !ex.has(index) && fx.has(index),
        params: ts[index]?.params ?? [], results: ts[index]?.results ?? [] })) };
    },
    functionBodies: ({ from, count }, a) => {
      const lo = int(from, "from"), n = int(count, "count", 1, 201), hide = hidden(a);
      return { bodies: bodies(a).filter(f => f.index >= lo && f.index < lo + n && !hide.has(f.index)).map(f => functionBody(a, f.index)) };
    },
    codeSearch: ({ aob, limit = 500 }, a) => {
      const { bytes: pat, mask } = L.parseAob(str(aob)), b = code(a), hide = hidden(a), ex = exported(a), rows = [];
      let count = 0;
      int(limit, "limit", 1, 501);
      for (const f of bodies(a)) if (!hide.has(f.index)) for (let p = f.start; p + pat.length <= f.end; p++) {
        let j = 0;
        while (j < pat.length && !((b[p + j] ^ pat[j]) & mask[j])) j++;
        if (j === pat.length && ++count <= limit) rows.push({ func: f.index, name: a.meta?.names.functions[f.index] ?? ex.get(f.index) ?? null, offset: p });
      }
      return { count, rows };
    },
    xrefs: ({ func, global }, a) => {
      const m = L.scan(a.original ?? code(a)), adj = i => a.meta && i >= m.funcImports ? i + 2 : i, ex = exported(a), rows = [];
      const key = func != null ? "func" : global != null ? "global" : fail("Missing function or global", TypeError);
      const want = key === "func" ? int(func, "function index")
        : typeof global === "string" ? findGlobal(a, global).index : int(global, "global index", 0, m.globals.length);
      const ops = key === "func" ? { 0x10: "call", 0x12: "return_call", 0xd2: "ref.func" } : { 0x23: "global.get", 0x24: "global.set" };
      const sites = orig => new Map(bodies(a, orig).map(f => {
        const out = [];
        for (let p = f.start; p < f.end; p = insnEnd(f.b, p)) {
          const op = ops[f.b[p]], v = op && L.leb.readU32(f.b, p + 1)[0];
          if (op && (orig && key === "func" ? adj(v) : v) === want) out.push([p, op]);
        }
        return [f.index, { start: f.start, out }];
      }));
      const live = a.meta && sites(false), at = (i, k, p) => live ? live.get(i)?.out[k]?.[0] ?? live.get(i)?.start ?? p : p;
      for (const [i, { out }] of sites(true)) out.forEach(([p, op], k) => rows.push({ func: i, name: a.meta?.names.functions[i] ?? ex.get(i) ?? null,
        offset: at(i, k, p), text: `${op} ${want}` }));
      for (const r of m.refs) if (r[key] != null && (key === "func" ? adj(r.func) : r.global) === want)
        rows.push({ func: null, name: null, offset: null, text: r.op ? `${r.where} ${r.op} ${want}` : r.where });
      return { rows };
    },
    call: ({ index, args }, a) => {
      const t = !hidden(a).has(int(index, "function index")) && sigs(a)[index], f = t ? callable(a, index) : fail("Function is not callable", Error);
      Array.isArray(args) && args.length === t.params.length || fail(`Expected ${t.params.length} arguments`, TypeError);
      const r = f(...t.params.map((p, i) => NUM.includes(p) ? L.parseValue(str(args[i]), p) : fail(`Unsupported parameter type: ${p}`)));
      return { results: t.results.length > 1 ? [...r] : t.results.length ? [r] : [] };
    },
    script: ({ name, code, enabled }) => {
      enabled ? runScript({ name: str(name), code: str(code) }) : (typeof code === "string" && codes.set(name, code), stopScript(scripts.get(name)), scripts.delete(name));
      return { scripts: H.state().scripts };
    },
    jsScan: ({ compare, value }) => {
      const first = compare === "unknown" || !jsCands, ok = ["eq", "ne", "lt", "lte", "gt", "gte", ...first ? ["unknown"] : ["changed", "unchanged", "increased", "decreased"]];
      ok.includes(compare) || fail(`Invalid comparison: ${compare}`);
      const f = compare === "unknown" ? () => true : tester("f64", { compare, value: value == null || value === "" ? undefined : str(value) });
      jsCands = (first ? jsWalk() : jsCands).filter(c => {
        try { return (v => typeof v === "number" && f(v, c.prev ?? v) && (c.prev = v, true))(c.o[c.k]); } catch { return false; }
      });
      return { count: jsCands.length, rows: jsCands.slice(0, 100).map(c => ({ path: c.path, value: c.prev, frozen: jsFrozen.has(c.path) })) };
    },
    jsScanReset: () => (jsCands = null, {}),
    jsWrite: ({ path, value }) => {
      const { o, k } = jsPath(path), v = L.parseValue(str(value), "f64"), f = jsFrozen.get(path);
      f ? f.value = v : o[k] = v;
      return {};
    },
    jsFreeze: ({ path, value, enabled }) => {
      const { o, k } = jsPath(path), enumerable = Object.getOwnPropertyDescriptor(o, k)?.enumerable ?? true, f = { value: value == null ? o[k] : L.parseValue(str(value), "f64") };
      if (enabled) Object.defineProperty(o, k, { get: () => f.value, set() {}, configurable: true, enumerable }) && jsFrozen.set(path, f);
      else if (jsFrozen.has(path)) Object.defineProperty(o, k, { value: jsFrozen.get(path).value, writable: true, configurable: true, enumerable }) && jsFrozen.delete(path);
      return {};
    },
    customTypes: ({ types }) => (L.customTypes(types, true), sync(), {}),
    speed: ({ multiplier: m }) => (typeof m === "number" && m >= 0 && m <= 16 || fail("Invalid multiplier"), m && m !== 1 && (lastSpeed = m), setSpeed(m), { speed }),
  };

  const FREE = ["select", "speed", "customTypes", "command", "hotkeys", "script", "breakpoint", "jsScan", "jsScanReset", "jsWrite", "jsFreeze"];
  const merge = (w, s) => {
    const x = s.instances.find(i => i.id === w.lid), { scan: sc, freezes: fs, undo, scanDepth, options, snapshots } = s;
    if (x) Object.assign(w, { memoryBytes: x.memoryBytes, memory: x.memory, memories: x.memories, shared: x.shared });
    return { ...H.state(), scan: sc, freezes: fs, undo, scanDepth, options, snapshots };
  };
  const route = async (t, b, a) => {
    if (!a?.worker) return H[t](b, a);
    if (t === "state") return merge(a, await fwd(a, t, b));
    if (t === "dump") return (r => (save(r.bytes, r.file), { size: r.size }))(await fwd(a, t, { ...b, id: a.id }));
    if (t === "watch") b = { ...b, memory: 0, ...b.enabled && await fwd(a, "watchAt", b) };
    if (t === "accesses") b = { ...b, ...await fwd(a, "siteAt", b) };
    if (["watch", "accesses", "traces"].includes(t)) return H[t](b, a);
    const r = await fwd(a, t, b);
    if (t === "selectMemory") a.memory = r.memory;
    return r;
  };
  const handle = async (t, body) => {
    Object.hasOwn(H, t) || fail(`Unknown request: ${t}`);
    body ?? fail("Missing body", TypeError);
    return route(t, body, FREE.includes(t) ? null : t === "state" ? sel() : sel() ?? need());
  };
  const sha256 = u8 => {
    const K = [], H = [], r = (x, c) => x >>> c | x << 32 - c, frac = x => (x - Math.floor(x)) * 2 ** 32 | 0;
    for (let n = 2; K.length < 64; n++) if (Array.from({ length: n - 2 }, (_, d) => d + 2).every(d => n % d)) (H.length < 8 && H.push(frac(n ** 0.5)), K.push(frac(n ** (1 / 3))));
    const len = u8.length, m = new Uint8Array((len + 72) & ~63), dv = new DataView(m.buffer), w = new Int32Array(64);
    m.set(u8);
    m[len] = 0x80;
    dv.setUint32(m.length - 8, len / 2 ** 29);
    dv.setUint32(m.length - 4, len * 8);
    for (let p = 0; p < m.length; p += 64) {
      for (let i = 0; i < 64; i++) w[i] = i < 16 ? dv.getInt32(p + i * 4) : (r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ w[i - 2] >>> 10) + w[i - 7] + (r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ w[i - 15] >>> 3) + w[i - 16];
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + (e & f ^ ~e & g) + K[i] + w[i] | 0, t2 = (r(a, 2) ^ r(a, 13) ^ r(a, 22)) + (a & b ^ a & c ^ b & c) | 0;
        h = g, g = f, f = e, e = d + t1 | 0, d = c, c = b, b = a, a = t1 + t2 | 0;
      }
      [a, b, c, d, e, f, g, h].forEach((x, i) => H[i] = H[i] + x | 0);
    }
    return H.map(x => (x >>> 0).toString(16).padStart(8, "0")).join("");
  };
  const register = ({ instance, module, imports: io, memory, memories, bytes, original, instrumented, error, meta, warnings = [], hit }) => {
    const x = instance.exports, name = re => Object.keys(x).filter(k => re.test(k)).at(-1);
    const mems = memories?.length ? memories : memory ? [{ index: 0, memory }] : [];
    const i = { id: nextId++, instance, module, memory, mems, mi: mems[0]?.index ?? 0, m64: !!mems.find(x => x.index === 0)?.i64, bytes, original, instrumented, error, meta, warnings: [...warnings], exports: x, url: location.href, hash: original || bytes ? sha256(original ?? bytes) : null,
      gimps: module ? OM.imports(module).filter(d => d.kind === "global").map(d => io?.[d.module]?.[d.name]) : [], wname: name(/^__cetus_watch(_\d+)?$/), aname: name(/^__cetus_arm(_\d+)?$/) };
    instances.push(i);
    if (hit) hit.i = i;
    if (L.worker) return void (f => live ? live.then(f) : f(false))(lock => bc?.postMessage({ tok, t: "init", from: me, lock, instance: pub(i) }));
    workerSrc ? probe() : ask();
    wraps.set(instance, { fns: new Map() });
    try { applyConfig(); } catch (e) { i.warnings.push(msg(e)); }
    emit("init", { instance: pub(i) });
  };
  const swap = (op, kind, v) => kind === "write" ? (o => (olds[op] = v, o))(olds[op] ?? v) : v;
  const stackOf = (st, i = active()) => {
    const meta = i?.meta, helpers = meta?.helpers ?? [];
    return typeof st !== "string" ? st : [...st.matchAll(/wasm-function\[(\d+)\]:0x([0-9a-f]+)/g)]
      .filter(([, f]) => !helpers.includes(+f)).slice(0, 16)
      .map(([, f, o]) => ({ func: +f, name: meta?.names.functions[f] ?? null, offset: parseInt(o, 16) }));
  };
  const wst = (st, i) => i?.meta ? stackOf(st, i) : st;
  const hitList = () => ({ hits: [...hits.values()], globalHits: [...globalHits.values()],
    bpHits: [...bpHits.values()] });
  const fire = h => hitFns.forEach(f => f(h));
  const record = (op, kind, st, v, old, i, ls) => {
    const stack = stackOf(st, i);
    if (!stack.length) return;
    const { func, offset, name } = stack[0], k = `${op}:${kind}:${func}:${offset}`;
    old === undefined && (old = swap(op, kind, v));
    const last = { old, new: v, stack, ...ls && { locals: ls } };
    hits.set(k, { slot: op, kind, func, offset, name, count: (hits.get(k)?.count ?? 0) + 1, last });
    later("hits", hitList);
    fire({ kind, slot: op, func, offset, name, last });
  };
  const bkey = b => `${b.func}:${b.offset}`;
  const bpHit = ({ func, offset }, st, i = active(), ls) => {
    const stack = stackOf(st, i), k = bkey({ func, offset });
    const name = i?.meta?.names.functions[func] ?? stack[0]?.name ?? null;
    const last = { stack, ...ls && { locals: ls } };
    bpHits.set(k, { func, offset, name, count: (bpHits.get(k)?.count ?? 0) + 1, last });
    later("hits", hitList);
    fire({ kind: "breakpoint", bp: { func, offset }, func, offset, name, last });
  };
  const cond = c => typeof c === "string" && c.trim() ? c.trim() : null;
  const creport = (c, where, m) => cbad.has(c) || (cbad.add(c), emit("scriptError", { name: `Condition ${where}`, message: m }));
  const condOk = (c, where, hit) => {
    if (typeof c !== "string" || !c.trim()) return true;
    let f = conds.get(c);
    if (f === undefined) {
      try { f = new Function("hit", `return (${c})`); } catch (e) { f = null, creport(c, where, msg(e)); }
      conds.set(c, f);
    }
    if (!f) return false;
    try { return !!f(hit); } catch (e) { return creport(c, where, msg(e)), false; }
  };
  const bumped = k => { const n = (counts.get(k) ?? 0) + 1; return counts.set(k, n), n; };
  const stepStart = f => { const s = steps.get(f); return s && (s.offsets.length = 0, s.truncated = false), s; };
  const stepRec = (off, f, i) => {
    const max = () => (i?.meta?.options.stepTrace ?? []).find(x => x.func === f)?.max ?? 1000;
    const s = (off ? steps.get(f) : stepStart(f))
      ?? steps.set(f, { max: max(), offsets: [], truncated: false }).get(f);
    s.offsets.push(off);
    if (s.offsets.length > s.max) s.offsets.shift(), s.truncated = true;
    later("traces", () => ({ calls: [...calls.values()] }));
  };
  const takeLocals = () => lbuf.length ? lbuf.splice(0) : null;
  const gname = (g, a = active()) => a && globalsOf(a).find(x => x.index === g)?.name;
  const globalHit = (g, v, st, gn, i) => {
    const top = stackOf(st, i)[0], k = top && `${g}:${top.func}:${top.offset}`, h = globalHits.get(k);
    if (!top) return;
    const globalName = h?.globalName ?? gn ?? gname(g) ?? `global${g}`;
    const { func, offset, name } = top;
    globalHits.set(k, { global: g, globalName, func, offset, name, count: (h?.count ?? 0) + 1, last: v });
    later("hits", hitList);
    fire({ kind: "global", global: g, globalName, func, offset, name, last: v });
  };
  const trace = () => { const n = Error.stackTraceLimit; Error.stackTraceLimit = 32; try { return new Error().stack; } finally { Error.stackTraceLimit = n; } };
  const settle = op => (p => p && (pend.delete(op), p()))(pend.get(op));
  const watchHit = (op, kind, a, b, st, n, src) => {
    try {
      const i = src?.i ?? active();
      if (op === -6) return void (lbuf[a] = b);
      if (op === -7) return void stepRec(a, b, i);
      if (op >= 0) {
        const w = slots[op], s = L.worker ? wsl[op] : w && [w.address, w.size, flags[op], w.break, w.condition], st = trace();
        const ls = takeLocals();
        if (s?.[3] && condOk(s[4], `slot ${op}`, { count: bumped(`w${op}`), old: olds[op] ?? null,
          new: s && i ? uval(i, s) : null, address: s[0], locals: ls })) debugger;
        const own = !isShared(i?.memory?.buffer);
        const post = v => bc?.postMessage({ tok, t: "hit", op, kind, st: wst(st, i), v, ls, old: own ? swap(op, kind, v) : undefined });
        const done = () => (v => L.worker ? post(v) : record(op, kind, st, v, undefined, i, ls))(s && i ? uval(i, s) : null);
        settle(op);
        if (kind === "write" && s?.[2] === 4) return pend.set(op, done), Promise.resolve().then(() => settle(op));
        return done();
      }
      if (op === -5) {
        const bp = i?.meta?.options.breakpoints?.[a], k = bp && bkey(bp), ls = takeLocals();
        if (!bp) return;
        const c = bpConds.has(k) ? bpConds.get(k) : bp.condition;
        if ((bpBreaks.has(k) ? bpBreaks.get(k) : bp.break)
          && condOk(c, k, { count: bumped(`b${k}`), old: null, new: null, address: null, locals: ls })) debugger;
        return L.worker ? bc?.postMessage({ tok, t: "hit", op, bp, ls, st: wst(trace(), i) }) : bpHit(bp, trace(), i, ls);
      }
      if (op === -2) stepStart(a);
      const x = op === -4 ? { st: wst(trace(), i), n: gname(a, i) } : op === -2 ? { n: i?.meta?.names.functions[a] ?? null } : {};
      if (L.worker) return bc?.postMessage({ tok, t: "hit", op, kind, a, b, ...x });
      if (op === -4) return globalHit(a, b, st ?? trace(), n ?? x.n, i);
      if (op === -1) {
        if (instances.includes(src?.i) && src.i !== owner) return;
        const s = armed.get(b), m = s?.map;
        if (m && (m.size < 256 || m.has(a))) m.set(a, (m.get(a) ?? 0) + 1) && later("accesses", () => ({ accesses: accessList() }));
        if (s && hitFns.size) {
          fire({ kind: "access", site: b, func: s.func, offset: s.offset, name: s.name ?? fname(s.func), last: { address: a } });
        }
      } else if (op === -2) {
        calls.set(a, tracing = { func: a, name: n ?? x.n, count: (calls.get(a)?.count ?? 0) + 1, lastArgs: [] });
        later("traces", () => ({ calls: [...calls.values()] }));
      } else if (op === -3 && tracing) tracing.lastArgs[a] = b;
    } catch {}
  };
  const unhook = msg => {
    const sub = v => {
      const o = v instanceof WebAssembly.Module && L.original?.(v);
      return o ? subs.get(v) ?? subs.set(v, new OM(o)).get(v) : v;
    };
    if (msg instanceof WebAssembly.Module) return sub(msg);
    if (!msg || typeof msg !== "object" || ![Object.prototype, Array.prototype].includes(Object.getPrototypeOf(msg))) return msg;
    const c = Array.isArray(msg) ? [...msg] : { ...msg };
    for (const k of Object.keys(c)) c[k] = sub(c[k]);
    return Object.keys(c).some(k => c[k] !== msg[k]) ? c : msg;
  };
  const hooked = new WeakSet(), subs = new WeakMap(), fakes = new WeakMap(), bare = new WeakSet(), worklets = new WeakMap(), wports = new Set(), shareds = new Map(), waiting = [];
  const KEY = `cetus-${tok}`, EV = ["message", "messageerror", "error"];
  let decided = false, expired = false, probeDone = false, asked = false;
  const blob = s => URL.createObjectURL(new Blob([s], { type: "text/javascript" }));
  const abs = u => new URL(String(u), L.base ?? document.baseURI).href;
  const check = () => !decided && (expired || probeDone && workerSrc) && (decided = true) && waiting.splice(0).forEach(f => f());
  const ready = f => decided ? f() : waiting.push(f);
  const ask = () => workerSrc || asked || (asked = true, emit("needSource", {}));
  const probe = () => {
    if (probed) return;
    probed = true;
    ask();
    sT(() => check(expired = true), 2000);
    const end = (ok, w) => (w?.terminate(), blobOk ||= ok, probeDone = true, check());
    if (!OW) return end(false);
    try {
      const w = new OW(blob("postMessage(1)"));
      w.onmessage = () => end(true, w);
      w.onerror = e => (e.preventDefault(), end(false, w));
    } catch { end(false); }
  };
  const boot = () => cfg ? `dispatchEvent(new CustomEvent("cetusMsgOut", { detail: ${JSON.stringify(cfg)} }));` : "";
  const rid36 = () => Math.random().toString(36).slice(2), wids = new WeakMap(), wlids = new WeakMap();
  const wsrc = (u, mod, wid) => `self.cetusLib = ${JSON.stringify({ worker: tok, wid, workerSrc, base: u })};\n${workerSrc}\n;${boot()}\n`
    + (mod ? `await cetusLib.hold(import(${JSON.stringify(u)}));` : `importScripts(${JSON.stringify(u)});`);
  const wkit = (key, run, href) => {
    const et = new EventTarget(), q = [], ports = [], chans = [], AWP = globalThis.AudioWorkletProcessor, reg = globalThis.registerProcessor;
    const adopt = p => ports.includes(p) || (ports.push(p), p.addEventListener("message", e => e.data?.[key] && (e.stopImmediatePropagation(), chans.forEach(c => c.onmessage?.({ data: e.data[key] })))),
      p.start(), q.splice(0).forEach(m => p.postMessage({ [key]: m })));
    const d = AWP && Object.getOwnPropertyDescriptor(AWP.prototype, "port");
    if (d && reg) {
      Object.defineProperty(AWP.prototype, "port", { ...d, get() { const p = d.get.call(this); adopt(p); return p; } });
      globalThis.registerProcessor = (n, C) => reg(n, class extends C { constructor(...a) { super(...a); this.port; } });
    }
    run(globalThis, { href }, et.addEventListener.bind(et), et.removeEventListener.bind(et), et.dispatchEvent.bind(et),
      class extends Event { constructor(t, o) { super(t, o); this.detail = o?.detail ?? null; } },
      class { constructor() { chans.push(this); } postMessage(m) { ports[0] ? ports[0].postMessage({ [key]: m }) : q.length < 1e3 && q.push(m); } },
      (f, ms, ...a) => Promise.resolve().then(() => f(...a)),
      class { decode(b = []) { let s = ""; for (const c of new Uint8Array(b.buffer ?? b, b.byteOffset, b.byteLength)) s += String.fromCharCode(c); try { return decodeURIComponent(escape(s)); } catch { return s; } } });
  };
  const wcode = (u, wid) => `globalThis.cetusLib = ${JSON.stringify({ worker: tok, wid })};\n(${wkit})(${JSON.stringify(KEY)}, `
    + `(self, location, addEventListener, removeEventListener, dispatchEvent, CustomEvent, BroadcastChannel, setTimeout, TextDecoder) => {\n${workerSrc}\n;${boot()}\n}, ${JSON.stringify(u)});`;
  const start = (t, a, nt, shared) => {
    const [url, o] = a, mod = o?.type === "module", k = shared && JSON.stringify([abs(url), typeof o === "string" ? o : o?.name ?? "", mod]), wid = rid36();
    if (blobOk && workerSrc && a.length) try {
      const w = Reflect.construct(t, [shared ? shareds.get(k) ?? shareds.set(k, blob(wsrc(abs(url), mod, wid))).get(k) : blob(wsrc(abs(url), mod, wid)), ...a.slice(1)], nt);
      hooked.add(w);
      shared || wids.set(w, wid);
      return w;
    } catch {}
    const w = Reflect.construct(t, L.base && a.length ? [abs(url), ...a.slice(1)] : a, nt);
    if (shared) bare.add(w.port);
    return w;
  };
  const defer = (t, a, nt, shared) => {
    if (!a.length) return Reflect.construct(t, a, nt);
    abs(a[0]);
    const f = Reflect.construct(EventTarget, [], nt), s = { q: [], h: {} }, ch = shared && new MessageChannel();
    fakes.set(f, s);
    EV.forEach(e => f.addEventListener(e, ev => s.h[e]?.call(f, ev)));
    if (ch) s.port = ch.port1;
    ready(() => {
      if (s.dead) return;
      const w = s.real = start(t, a, t, shared);
      (shared ? ["error"] : EV).forEach(e => w.addEventListener(e, ev => f.dispatchEvent(new ev.constructor(e, ev)) || ev.preventDefault()));
      if (!ch) return s.q.splice(0).forEach(m => w.postMessage(...m));
      ch.port2.onmessage = ev => w.port.postMessage(ev.data, [...ev.ports]);
      w.port.onmessage = ev => ch.port2.postMessage(ev.data, [...ev.ports]);
    });
    return f;
  };
  const own = (C, keys) => keys.forEach(k => {
    const d = Object.getOwnPropertyDescriptor(C.prototype, k);
    d?.get && Object.defineProperty(C.prototype, k, { ...d,
      get() { const s = fakes.get(this); return s ? k === "port" ? s.port : s.h[k.slice(2)] ?? null : d.get.call(this); },
      set: d.set && function (v) { const s = fakes.get(this); s ? s.h[k.slice(2)] = typeof v === "function" ? v : null : d.set.call(this, v); } });
  });
  const wrap = (C, shared) => new Proxy(C, { construct: (t, a, nt) => (probe(), decided) ? start(t, a, nt, shared) : defer(t, a, nt, shared) });
  const { SharedWorker: OSW, AudioWorkletNode: AWN, MessagePort: MP } = globalThis, WL = globalThis.Worklet?.prototype, addModule = WL?.addModule;
  if (OW) {
    const P = OW.prototype, post = P.postMessage, term = P.terminate;
    own(OW, EV.map(e => `on${e}`));
    P.postMessage = function (m, ...r) { const s = fakes.get(this); return s ? s.real ? s.real.postMessage(m, ...r) : void s.q.push([m, ...r]) : post.call(this, hooked.has(this) ? m : unhook(m), ...r); };
    P.terminate = function () { const s = fakes.get(this); return s ? void (s.dead = true, s.real?.terminate()) : (bye(wids.get(this)), term.call(this)); };
    globalThis.Worker = wrap(OW);
  }
  if (OSW) own(OSW, ["port", "onerror"]), globalThis.SharedWorker = wrap(OSW, true);
  if (MP && (OSW || AWN)) {
    const post = MP.prototype.postMessage;
    MP.prototype.postMessage = function (m, ...r) { return post.call(this, bare.has(this) ? unhook(m) : m, ...r); };
  }
  if (addModule) WL.addModule = async function (url, ...r) {
    worklets.has(this) || worklets.set(this, new Promise(f => (probe(), ready(f)))
      .then(() => workerSrc && addModule.call(this, blob(wcode(abs(url), wlids.set(this, rid36()).get(this))), ...r).then(() => hooked.add(this))).catch(() => {}));
    await worklets.get(this);
    return addModule.call(this, url, ...r);
  };
  const AC = globalThis.AudioContext?.prototype, acClose = AC?.close;
  if (acClose && addModule) AC.close = function (...r) { bye(wlids.get(this.audioWorklet)); return acClose.apply(this, r); };
  if (AWN) {
    const d = Object.getOwnPropertyDescriptor(AWN.prototype, "port");
    globalThis.AudioWorkletNode = new Proxy(AWN, { construct: (t, a, nt) => {
      const on = hooked.has(a[0]?.audioWorklet);
      if (!on && a[2]?.processorOptions) a = [a[0], a[1], { ...a[2], processorOptions: unhook(a[2].processorOptions) }];
      const n = Reflect.construct(t, a, nt), p = d.get.call(n);
      if (!on) bare.add(p);
      else if (!wports.has(p)) wports.add(p), p.addEventListener("message", e => e.data?.[KEY] && (e.stopImmediatePropagation(), bus(e.data[KEY]))), p.start();
      return n;
    } });
  }
  if (L.base) {
    const loc = new URL(L.base), fix = u => typeof u === "string" || u instanceof URL ? abs(u) : u, { importScripts: is, fetch: fe, XMLHttpRequest: X, Request: R } = globalThis;
    Object.defineProperty(globalThis, "location", { get: () => loc, configurable: true });
    if (is) globalThis.importScripts = (...u) => is(...u.map(fix));
    if (fe) globalThis.fetch = (u, ...r) => fe(fix(u), ...r);
    if (R) globalThis.Request = new Proxy(R, { construct: (t, [u, ...r], nt) => Reflect.construct(t, [fix(u), ...r], nt) });
    if (X) { const o = X.prototype.open; X.prototype.open = function (m, u, ...r) { return o.call(this, m, fix(u), ...r); }; }
    L.hold = async p => {
      const q = [], f = e => (e.stopImmediatePropagation(), q.push(e)), on = g => ["message", "connect"].forEach(t => g(t, f));
      on(addEventListener);
      try { await p; } finally { on(removeEventListener); q.forEach(e => dispatchEvent(new e.constructor(e.type, e))); }
    };
  }
  const bus = d => {
    if (d?.tok !== tok) return;
    if (L.worker) {
      const res = r => bc?.postMessage({ tok, t: "res", rid: d.rid, ...r });
      if (d.t === "req" && d.to === me) (async () => (selected = d.lid, handle(d.type, d.body)))()
        .then(body => ({ ok: true, body }), e => ({ ok: false, error: msg(e) }))
        .then(r => { try { res(r); } catch (e) { res({ ok: false, error: msg(e) }); } });
      if (d.t !== "sync") return;
      try { if (d.sp != null && d.sp !== speed) setSpeed(d.sp); } catch {}
      suspended = !!d.su;
      ctypes(d);
      wsl = d.slots;
      bpBreaks.clear();
      bpConds.clear();
      (d.bps ?? []).forEach(([k, v]) => bpBreaks.set(k, v));
      (d.bpc ?? []).forEach(([k, v]) => bpConds.set(k, v));
      instances.forEach(i => apply(i, d.slots, d.sites));
      wsl.forEach((s, k) => olds[k] = s && active() ? uval(active(), s) : null);
      return bc?.postMessage({ tok, t: "synced", from: me, n: d.n });
    }
    if (d.t === "init") {
      const w = { ...d.instance, id: nextId++, worker: true, from: d.from, lid: d.instance.id, page: location.href };
      sync(workers.push(w));
      if (d.lock) try { locks?.request(lockName(d.from), () => drop(d.from)).catch(() => {}); } catch {}
      emit("init", { instance: wpub(w) });
      try { applyConfig(); } catch {}
    }
    else if (d.t === "res") (f => f && (waits.delete(d.rid), f(d)))(waits.get(d.rid));
    else if (d.t === "bye") drop(d.from);
    else if (d.t === "hi") sync();
    else if (d.t === "synced") workers.forEach(w => w.from === d.from && (w.acked = d.n));
    else if (d.t === "hit" && d.op === -5 && d.bp) bpHit(d.bp, d.st, undefined, d.ls);
    else if (d.t === "hit" && d.op < 0) watchHit(d.op, d.kind, d.a, d.b, d.st, d.n);
    else if (d.t === "hit" && d.st != null) {
      record(d.op, d.kind, d.st, d.v, d.old, undefined, d.ls);
      d.old === undefined || reold(d.op);
    }
  };
  if (bc) bc.onmessage = ({ data }) => bus(data);
  if (L.worker) bc?.postMessage({ tok, t: "hi" });

  if (typeof addEventListener === "function") {
    addEventListener("cetusMsgOut", async e => {
      let m, detail;
      if (typeof e.detail !== "string") return;
      const ws = e.detail.startsWith('{"type":"workerSource"');
      try { m = ws ? JSON.parse(e.detail) : L.decode(e.detail); } catch { return; }
      if (ws) return void (m?.type === "workerSource" && typeof m.body?.src === "string" && (workerSrc ??= m.body.src, instances.length && probe(), check()));
      if (m?.type === "config" && !cfg) [cfg, cfgBody] = [e.detail, m.body ?? {}], ctypes(cfgBody), applyConfig(), asked && !workerSrc && emit("needSource", {});
      else if (m?.type === "config" && m.body && typeof m.body === "object") {
        for (const k of ["table", "globals", "hotkeys", "scripts", "hotkeyScripts"]) if (k in m.body) cfgBody[k] = m.body[k];
        if ("customTypes" in m.body) (ctypes(m.body), L.worker || sync());
        learn(m.body.scripts);
        learn(m.body.hotkeyScripts);
      }
      if (m?.id == null) return;
      try { detail = L.encode({ id: m.id, ok: true, body: await handle(m.type, m.body) }); } catch (err) { detail = L.encode({ id: m.id, ok: false, error: msg(err) }); }
      dispatchEvent(new CustomEvent("cetusMsgIn", { detail }));
    });
    addEventListener("pagehide", () => emit("reset", {}));
    if (!L.worker) addEventListener("pageshow", e => e.persisted && instances.forEach(i => emit("init", { instance: pub(i) })));
    addEventListener("keydown", onKey, true);
    emit("ready", {});
  }

  Object.assign(L, { Scan, findStrings, cands, pointers, register, watchHit, handle, insnEnd, sT });
})();
