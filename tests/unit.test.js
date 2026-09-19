import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { buildGame, buildSecond, loadPage, GAME } from "./fixture.js";

test("fixture game validates and runs", async () => {
  assert.ok(WebAssembly.validate(buildGame()));
  const { instance: { exports: x } } = await WebAssembly.instantiate(buildGame());
  assert.equal(x.getHealth(), 100);
  assert.equal(x.magic(), -16);
  assert.equal(x.truncSat(3.9), 3);
  assert.deepEqual(x.pair(), [1, 2]);
  assert.equal(x.callMagic(), -16);
  assert.equal(x.level.value, 3);
  assert.equal(x.getLives(), 3);
  x.damage(10);
  x.addGold(5);
  assert.equal(x.getHealth(), 90);
  assert.equal(x.readGold(), 505);
  const dv = new DataView(x.memory.buffer);
  assert.equal(dv.getFloat32(GAME.SPEED, true), 1.5);
  assert.equal(dv.getBigInt64(GAME.SCORE, true), 1234567890123n);
  assert.equal(dv.getInt16(GAME.NEG, true), -5);
});

test("fixture importMemory variant validates", async () => {
  assert.ok(WebAssembly.validate(buildGame({ importMemory: true })));
  const memory = new WebAssembly.Memory({ initial: 1 });
  const { instance } = await WebAssembly.instantiate(buildGame({ importMemory: true }), { env: { memory } });
  assert.equal(instance.exports.memory, undefined);
  assert.equal(new DataView(memory.buffer).getInt32(GAME.HEALTH, true), 100);
});

test("fixture multimem variant validates with 0x2A at 0x100 of memory 1", async () => {
  for (const importMemory of [false, true]) assert.ok(WebAssembly.validate(buildGame({ multimem: true, importMemory })));
  const x = (await WebAssembly.instantiate(buildGame({ multimem: true }))).instance.exports;
  assert.deepEqual([x.peek2(), x.getHealth()], [0x2a, 100]);
  x.poke2(7);
  assert.deepEqual([x.peek2(), x.getHealth()], [7, 100]);
});

test("fixture loadPage runs scripts in a fake window", async () => {
  mkdirSync("temp", { recursive: true });
  writeFileSync("temp/loadpage.js", `addEventListener("ping", e => { window.got = e.detail; requestAnimationFrame(t => window.frame = t); });`);
  const ctx = loadPage(["temp/loadpage.js"], { url: "http://example.com/game?x=1" });
  ctx.dispatchEvent(new ctx.CustomEvent("ping", { detail: "hi" }));
  assert.equal(ctx.got, "hi");
  assert.equal(ctx.location.pathname, "/game");
  assert.equal(new ctx.WebAssembly.Instance(new ctx.WebAssembly.Module(buildGame())).exports.getHealth(), 100);
  await new Promise(r => setTimeout(r, 40));
  assert.equal(typeof ctx.frame, "number");
});

await import("../shared/utils.js");
const L = globalThis.cetusLib;

test("utils read/write/toBytes round trip at type boundaries", () => {
  const edges = { i8: [-128, 127], u8: [0, 255], i16: [-32768, 32767], u16: [0, 65535], i32: [-(2 ** 31), 2 ** 31 - 1], u32: [0, 2 ** 32 - 1],
    i64: [-(2n ** 63n), 2n ** 63n - 1n], u64: [0n, 2n ** 64n - 1n], f32: [-3.4028234663852886e38, 1.401298464324817e-45], f64: [-Number.MAX_VALUE, Number.MIN_VALUE] };
  const dv = new DataView(new ArrayBuffer(16));
  for (const [t, vals] of Object.entries(edges)) for (const v of vals) {
    L.write(dv, 3, t, v);
    assert.equal(L.read(dv, 3, t), v, t);
    const b = L.toBytes(v, t);
    assert.equal(b.length, L.sizeOf(t));
    assert.equal(L.read(new DataView(b.buffer), 0, t), v, t);
    assert.equal(L.isBig(t), typeof v === "bigint");
  }
  L.write(dv, 0, "u8", 256);
  assert.equal(L.read(dv, 0, "u8"), 0);
  L.write(dv, 0, "i8", 128);
  assert.equal(L.read(dv, 0, "i8"), -128);
  L.write(dv, 0, "u64", -1n);
  assert.equal(L.read(dv, 0, "u64"), 2n ** 64n - 1n);
  L.write(dv, 0, "f32", 0.1);
  assert.equal(L.read(dv, 0, "f32"), Math.fround(0.1));
  assert.ok(L.isFloat("f32") && !L.isFloat("i32"));
});

test("utils parseValue", () => {
  assert.equal(L.parseValue("0x10", "i32"), 16);
  assert.equal(L.parseValue("0xFF", "i8"), -1);
  assert.equal(L.parseValue("-5", "i16"), -5);
  assert.equal(L.parseValue(" 42 ", "u8"), 42);
  assert.equal(L.parseValue("1.5", "f32"), 1.5);
  assert.equal(L.parseValue("1e3", "f64"), 1000);
  assert.equal(L.parseValue("0.1", "f32"), Math.fround(0.1));
  assert.equal(L.parseValue("18446744073709551615", "u64"), 2n ** 64n - 1n);
  assert.equal(L.parseValue("-9223372036854775808", "i64"), -(2n ** 63n));
  for (const [s, t] of [["128", "i8"], ["-1", "u32"], ["4294967296", "u32"], ["1.5", "i32"], ["1e3", "i32"], ["abc", "f32"], ["", "i32"], ["18446744073709551616", "u64"], ["0x1FF", "i8"]])
    assert.throws(() => L.parseValue(s, t), RangeError, `${s} ${t}`);
});

test("utils formatValue and toHex", () => {
  assert.equal(L.formatValue(-1, "i8", true), "0xFF");
  assert.equal(L.formatValue(-1n, "i64", true), "0xFFFFFFFFFFFFFFFF");
  assert.equal(L.formatValue(255, "u16", true), "0x00FF");
  assert.equal(L.formatValue(-5, "i32"), "-5");
  assert.equal(L.formatValue(1.5, "f32", true), "1.5");
  assert.equal(L.formatValue(12n, "u64"), "12");
  assert.equal(L.formatValue(1.5, "i32", true), "1.5");
  assert.equal(L.formatValue(undefined, "nope", true), "undefined");
  assert.equal(L.toHex(255), "0x000000FF");
  assert.equal(L.toHex(10, 2), "0x0A");
});

test("utils LEB128 tables", () => {
  const s32 = [[0, [0]], [63, [63]], [64, [0xC0, 0]], [-64, [0x40]], [-65, [0xBF, 0x7F]], [127, [0xFF, 0]], [128, [0x80, 1]],
    [2 ** 31 - 1, [0xFF, 0xFF, 0xFF, 0xFF, 7]], [-(2 ** 31), [0x80, 0x80, 0x80, 0x80, 0x78]]];
  for (const [n, b] of s32) {
    assert.deepEqual(L.leb.s32(n), b, String(n));
    assert.deepEqual(L.leb.readS32(Uint8Array.from([9, ...b]), 1), [n, b.length + 1]);
  }
  const u32 = [[0, [0]], [63, [63]], [64, [64]], [127, [127]], [128, [0x80, 1]], [2 ** 32 - 1, [0xFF, 0xFF, 0xFF, 0xFF, 0x0F]]];
  for (const [n, b] of u32) {
    assert.deepEqual(L.leb.u32(n), b, String(n));
    assert.deepEqual(L.leb.readU32(Uint8Array.from(b), 0), [n, b.length]);
  }
  const s64 = [[0n, [0]], [-64n, [0x40]], [-65n, [0xBF, 0x7F]], [2n ** 63n - 1n, [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0]],
    [-(2n ** 63n), [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x7F]]];
  for (const [n, b] of s64) {
    assert.deepEqual(L.leb.s64(n), b, String(n));
    assert.deepEqual(L.leb.readS64(Uint8Array.from(b), 0), [n, b.length]);
  }
  assert.throws(() => L.leb.readU32(Uint8Array.from([0x80, 0x80]), 0), RangeError);
  assert.throws(() => L.leb.readS32(Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, 0]), 0), RangeError);
  assert.throws(() => L.leb.readU32(Uint8Array.from([0xFF, 0xFF, 0xFF, 0xFF, 0x1F]), 0), RangeError);
  assert.throws(() => L.leb.readS64(Uint8Array.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0]), 0), RangeError);
  assert.throws(() => L.leb.readS64(Uint8Array.from([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 1]), 0), RangeError);
  assert.throws(() => L.leb.u32(-1), RangeError);
  assert.throws(() => L.leb.u32(2 ** 32), RangeError);
  assert.throws(() => L.leb.s32(2 ** 31), RangeError);
  assert.throws(() => L.leb.s64(2n ** 63n), RangeError);
});

test("utils encode/decode", () => {
  const obj = { a: [1n, -(2n ** 70n), { b: 2n ** 64n - 1n }], s: "10n", u: new Uint8Array([1, 2, 255]), big: new BigInt64Array([-1n]), n: null };
  const out = L.decode(L.encode(obj));
  assert.deepEqual(out, { a: [1n, -(2n ** 70n), { b: 2n ** 64n - 1n }], s: "10n", u: [1, 2, 255], big: [-1n], n: null });
  assert.equal(L.decode('{"$big":"5","x":1}').x, 1);
  assert.equal(L.decode('"10n"'), "10n");
});

test("utils parseAob, toBytes text and siteKey", () => {
  const { bytes, mask } = L.parseAob("DE AD ?? E?");
  assert.deepEqual([...bytes], [0xDE, 0xAD, 0, 0xE0]);
  assert.deepEqual([...mask], [0xFF, 0xFF, 0, 0xF0]);
  assert.deepEqual([...L.parseAob("?f").mask], [0x0F]);
  assert.throws(() => L.parseAob("DE XY"), RangeError);
  assert.throws(() => L.parseAob("DEA"), RangeError);
  assert.throws(() => L.parseAob(" "), RangeError);
  assert.deepEqual([...L.toBytes("Hero", "utf16")], [0x48, 0, 0x65, 0, 0x72, 0, 0x6F, 0]);
  assert.deepEqual([...L.toBytes("Hi", "ascii")], [0x48, 0x69]);
  assert.deepEqual([...L.toBytes("DE ?? 01", "aob")], [0xDE, 0, 1]);
  assert.deepEqual([...L.toBytes("-1", "i16")], [0xFF, 0xFF]);
  assert.equal(L.TYPES.length, 23);
  assert.equal(L.siteKey("https://a.com:8080/game/x?y=1#z"), "a.com:8080/game/x");
});

test("utils loads as a classic script into an existing cetusLib", () => {
  const ctx = loadPage([]);
  ctx.cetusLib = { keep: 1 };
  vm.runInContext(readFileSync("shared/utils.js", "utf8"), ctx);
  assert.equal(ctx.cetusLib.keep, 1);
  assert.equal(ctx.cetusLib.formatValue(-1, "i8", true), "0xFF");
});

await import("../extension/libs/assembler.js");
const { assemble, disassemble, AsmError } = L;
const opBytes = c => c > 0xFF ? [c >> 12, ...L.leb.u32(c & 0xFFF)] : [c];
const OPEN = [2, 3, 4, 6, 0x1F], MID = [5, 7, 0x19];
const V128 = Array.from({ length: 16 }, (_, i) => i + 1);
const SAMPLE = { "": [[], ""], u: [[0x85, 1], " 133"], uu: [[3, 0], " 3 0"], bt: [[0x7F], " i32"], brt: [[2, 0, 1, 2], " 2 0 1 2"],
  m: [[2, 0x80, 2], " align=2 offset=256"], i32: [[0x7F], " -1"], i64: [[0x80, 0x7F], " -128"], f32: [[0, 0, 0xC0, 0x3F], " 1.5"],
  f64: [[0, 0, 0, 0, 0, 0, 0xF8, 0xBF], " -1.5"], ht: [[0x70], " func"], vt: [[1, 0x7E], " i64"],
  ml: [[0x40, 1, 0x10, 3], " align=0 offset=16 memory=1 3"], l: [[3], " 3"], z: [[0], ""], shuf: [V128, " " + V128.join(" ")],
  v128: [V128, " i32x4 0x04030201 0x08070605 0x0C0B0A09 0x100F0E0D"], tt: [[0x7F, 2, 0, 1, 2, 3, 3], " i32 catch 1 2 catch_all_ref 3"],
  htr: [[0x6E], " (ref any)"], htn: [[5], " (ref null 5)"], cast: [[1, 0, 0x6E, 0x6C], " 0 (ref null any) (ref i31)"] };

const STREAMS = [];
test("assembler golden case per table entry", () => {
  assert.equal(assemble.opcodes.length, 571);
  assert.equal(new Set(assemble.opcodes.map(e => e[1])).size, 571);
  for (const [name, code, kind, alias] of assemble.opcodes) {
    const [imm, txt] = SAMPLE[kind], open = OPEN.includes(code) || MID.includes(code);
    const [pre, preT] = code === 5 ? [[4, 0x40], "if\n"] : [7, 0x18, 0x19].includes(code) ? [[6, 0x40], "try\n"] : [[], ""];
    const bytes = code === 0x0B ? [0x0B] : [...pre, ...opBytes(code), ...imm, ...(open ? [0x0B] : []), 0x0B];
    STREAMS.push(bytes);
    const text = code === 0x0B ? "end" : `${preT}${name}${txt}\n${open ? "end\nend" : "end"}`;
    assert.equal(disassemble(bytes).text, text, name);
    assert.deepEqual([...assemble(text)], bytes, name);
    if (alias) assert.deepEqual([...assemble(text.replace(name, alias))], bytes, alias);
  }
});

test("assembler round-trips 1000 seeded random streams", () => {
  let seed = 12345;
  const rnd = n => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n;
  const pick = a => a[rnd(a.length)];
  const u32 = () => pick([0, 1, 127, 128, 0xFFFFFFFF, rnd(2 ** 31) * 2 + rnd(2)]);
  const rb = n => Array.from({ length: n }, () => rnd(256));
  const f32s = [[0, 0, 0x80, 0x7F], [0, 0, 0x80, 0xFF], [0, 0, 0, 0x80], [0, 0, 0xC0, 0x7F], [1, 0, 0x80, 0xFF], [1, 0, 0, 0]];
  const f64s = [[0, 0, 0, 0, 0, 0, 0xF0, 0x7F], [0, 0, 0, 0, 0, 0, 0xF8, 0xFF], [0, 0, 0, 0, 0, 0, 0, 0x80], [5, 0, 0, 0, 0, 0, 0xF0, 0x7F], [1, 0, 0, 0, 0, 0, 0, 0]];
  const REFS = [0x70, 0x6F, 0x6E, 0x6D, 0x6C, 0x6B, 0x6A, 0x69, 0x71, 0x72, 0x73, 0x74];
  const lu = () => L.leb.u32(u32());
  const IMM = {
    "": () => [], u: lu, uu: () => [...lu(), ...lu()],
    ht: () => rnd(2) ? [pick(REFS)] : L.leb.s64(BigInt(u32())),
    bt: () => rnd(4) ? pick([[0x40], [0x7F], [0x7E], [0x7D], [0x7C], [0x7B], [0x70], [0x6F], [0x69], L.leb.s64(BigInt(u32()))]) : [pick([0x63, 0x64]), ...IMM.ht()],
    brt: () => { const n = rnd(4); return [n, ...Array.from({ length: n + 1 }, lu).flat()]; },
    tt: () => { const n = rnd(3); return [...IMM.bt(), n, ...Array.from({ length: n }, () => { const k = rnd(4); return [k, ...(k < 2 ? lu() : []), ...lu()]; }).flat()]; },
    m: () => { const mem = rnd(2) ? [] : lu(); return [...L.leb.u32(rnd(4) | (mem.length ? 0x40 : 0)), ...mem, ...L.leb.u64(pick([0n, 2n ** 64n - 1n, BigInt(u32())]))]; },
    ml: () => [...IMM.m(), rnd(256)], l: () => [rnd(256)], z: () => [0], shuf: () => rb(16), v128: () => rb(16),
    i32: () => L.leb.s32(pick([0, -1, 2 ** 31 - 1, -(2 ** 31), 63, -64, 64, -65, rnd(2 ** 31) - rnd(2 ** 31)])),
    i64: () => L.leb.s64(pick([0n, -1n, 2n ** 63n - 1n, -(2n ** 63n), BigInt.asIntN(64, BigInt("0x" + rb(8).map(b => b.toString(16).padStart(2, "0")).join("")))])),
    f32: () => rnd(2) ? pick(f32s) : rb(4), f64: () => rnd(2) ? pick(f64s) : rb(8),
    htr: () => IMM.ht(), htn: () => IMM.ht(), cast: () => [rnd(4), ...lu(), ...IMM.ht(), ...IMM.ht()],
    vt: () => rnd(2) ? [1, pick([0x7F, 0x7E, 0x7D, 0x7C, 0x7B, ...REFS])] : [2, 0x63, ...IMM.ht(), 0x64, ...IMM.ht()],
  };
  const plain = assemble.opcodes.filter(e => !OPEN.includes(e[1]) && !MID.includes(e[1]) && e[1] !== 0x0B && e[1] !== 0x18);
  for (let i = 0; i < 1000; i++) {
    const out = [], stack = [];
    for (let n = rnd(40); n--;) {
      const r = rnd(10);
      if (r === 0) { const c = pick(OPEN); stack.push(c); out.push(c, ...(c === 0x1F ? IMM.tt() : IMM.bt())); }
      else if (r === 1 && stack.length) {
        const top = stack.at(-1);
        if ((top === 4 || top === 6) && rnd(2)) { stack[stack.length - 1] = -1; out.push(...(top === 4 ? [5] : rnd(2) ? [7, ...lu()] : [0x19])); }
        else { stack.pop(); out.push(...(top === 6 && rnd(2) ? [0x18, ...lu()] : [0x0B])); }
      }
      else { const e = pick(plain); out.push(...opBytes(e[1]), ...IMM[e[2]]()); }
    }
    out.push(...stack.map(() => 0x0B), 0x0B);
    STREAMS.push(out);
    const { text, lines } = disassemble(out);
    assert.deepEqual([...assemble(text)], out, text);
    assert.equal(lines.length, text.split("\n").length);
  }
});

test("assembler round-trips every buildGame function body", () => {
  const u8 = buildGame(), rd = p => L.leb.readU32(u8, p);
  let pos = 8, bodies = 0;
  while (pos < u8.length) {
    const id = u8[pos];
    let [size, p] = rd(pos + 1);
    if (id === 10) {
      let [count, q] = rd(p);
      for (; count--; bodies++) {
        const [len, s] = rd(q);
        let [locals, r] = rd(s);
        for (; locals--; r++) r = rd(r)[1];
        const body = u8.slice(r, s + len), dis = disassemble(body);
        q = s + len;
        assert.deepEqual(assemble(dis.text), body);
        assert.equal(dis.lines.at(-1).offset, body.length - 1);
      }
    }
    pos = p + size;
  }
  assert.ok(bodies >= 14);
  assert.match(disassemble([0x41, 0, 0x20, 0, 0xfd, 0x11, 0xfd, 0x0b, 4, 0x80, 0x0a, 0x0b]).text, /^i32x4\.splat\nv128\.store align=4 offset=1280\nend$/m);
});

const wasmVec = a => [...L.leb.u32(a.length), ...a.flat()];
const wasmSec = (id, b) => [id, ...L.leb.u32(b.length), ...b];
const groupModule = code => new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
  ...wasmSec(1, wasmVec([[0x60, 0, 0], [0x5F, 1, 0x7F, 1], [0x5E, 0x7F, 1]])), ...wasmSec(3, [1, 0]), ...wasmSec(4, wasmVec([[0x70, 0, 1]])),
  ...wasmSec(5, wasmVec([[0, 1], [0, 1]])), ...wasmSec(13, wasmVec([[0, 0]])), ...wasmSec(9, wasmVec([[1, 0, 1, 0]])), ...wasmSec(12, [1]),
  ...wasmSec(10, wasmVec([[...L.leb.u32(code.length + 1), 0, ...code]])), ...wasmSec(11, wasmVec([[1, 2, 7, 7]]))]);
const GROUPS = {
  simd: [0xFD, `i32.const 16
i32.const 0
v128.load align=4 offset=0
i32.const 0
v128.load8_splat align=0 offset=0 memory=1
i8x16.shuffle 0 17 2 19 4 21 6 23 8 25 10 27 12 29 14 31
v128.const i32x4 0x00000001 0x00000002 0x0000000A 0xFFFFFFFF
i32x4.add
v128.const i32x4 0x3FC00000 0x80000000 0x7F800000 0x7FC00000
f32x4.relaxed_min
i32x4.extract_lane 3
i32x4.splat
i64.const -1
i64x2.replace_lane 1
v128.store align=4 offset=32
i32.const 0
i32.const 0
i8x16.splat
v128.store8_lane align=0 offset=0 memory=1 15
i32.const 0
v128.load32_zero align=2 offset=4
i16x8.extend_low_i8x16_s
f64x2.convert_low_i32x4_u
v128.any_true
drop
end`],
  atomics: [0xFE, `i32.const 0
i32.const 1
i32.atomic.rmw.add align=2 offset=4
drop
i32.const 0
i64.const 5
i64.const 6
i64.atomic.rmw32.cmpxchg_u align=2 offset=0
drop
atomic.fence
i32.const 0
i32.const 1
memory.atomic.notify align=2 offset=0 memory=1
drop
i32.const 0
i64.atomic.load8_u align=0 offset=65536
drop
end`],
  bulk: [0xFC, `f32.const 1.5
i32.trunc_sat_f32_s
drop
f64.const -inf
i64.trunc_sat_f64_u
drop
i32.const 0
i32.const 0
i32.const 1
memory.init 0 1
data.drop 0
i32.const 0
i32.const 0
i32.const 1
memory.copy 1 0
i32.const 0
i32.const 0
i32.const 1
memory.fill 1
i32.const 0
i32.const 0
i32.const 1
table.init 0 0
elem.drop 0
ref.null func
i32.const 1
table.grow 0
drop
table.size 0
drop
i32.const 0
ref.null func
i32.const 0
table.fill 0
i32.const 0
i32.const 0
i32.const 0
table.copy 0 0
end`],
  refs: [0xFB, `ref.func 0
call_ref 0
ref.null func
ref.is_null
drop
ref.func 0
ref.as_non_null
drop
i32.const 1
i32.const 2
i32.const 0
select i32
drop
ref.null extern
ref.null extern
i32.const 0
select externref
drop
i32.const 0
table.get 0
i32.const 0
ref.func 0
table.set 0
drop
i32.const 7
struct.new 1
struct.get 1 0
drop
i32.const 3
i32.const 0
array.new 2
array.len
drop
i32.const 5
ref.i31
i31.get_u
drop
ref.null none
ref.test (ref 1)
drop
ref.null any
ref.cast (ref null 1)
drop
block (ref null any)
ref.null none
br_on_cast 0 (ref null any) (ref i31)
end
drop
ref.null extern
any.convert_extern
extern.convert_any
drop
ref.null none
ref.null none
ref.eq
drop
block
ref.null func
br_on_null 0
drop
end
block
i32.const 0
return_call_indirect 0 0
end
block
return_call 0
end
ref.func 0
return_call_ref 0
end`],
  eh: [0x1F, `block
block exnref
try_table catch 0 1 catch_ref 0 0 catch_all 1 catch_all_ref 0
throw 0
end
return
end
throw_ref
end
end`],
  legacyEh: [0x06, `try
throw 0
catch 0
catch_all
end
try
nop
delegate 0
try
throw 0
catch_all
rethrow 0
end
end`],
};

for (const [group, [prefix, text]] of Object.entries(GROUPS)) test(`assembler ${group} group assembles V8-valid code and round-trips`, () => {
  const code = [...assemble(text)];
  assert.ok(code.includes(prefix), group);
  assert.ok(WebAssembly.validate(groupModule(code)), group);
  const dis = disassemble(code);
  assert.equal(dis.text.replace(/^ +/gm, ""), text);
  assert.deepEqual([...assemble(dis.text)], code);
});

test("assembler accepts every v128 shape, WAT reference types and legacy atomics", () => {
  const lanes = [["i8x16", "-1 ".repeat(16)], ["i16x8", "0xFFFF ".repeat(8)], ["i32x4", "-1 -1 -1 -1"], ["i64x2", "18446744073709551615 -1"], ["f32x4", "-nan:0x7fffff ".repeat(4)]];
  for (const [shape, v] of lanes) assert.deepEqual([...assemble(`v128.const ${shape} ${v.trim()}\nend`)], [0xFD, 12, ...Array(16).fill(0xFF), 0x0B], shape);
  assert.deepEqual([...assemble("v128.const f64x2 1.5 -0\nend")].slice(2, 18), [0, 0, 0, 0, 0, 0, 0xF8, 0x3F, 0, 0, 0, 0, 0, 0, 0, 0x80]);
  assert.deepEqual([...assemble("ref.test anyref\nref.cast (ref 70)\nblock (ref 3)\nend\nselect nullfuncref (ref null extern)\nend")],
    [0xFB, 0x15, 0x6E, 0xFB, 0x16, 0xC6, 0, 2, 0x64, 3, 0x0B, 0x1C, 2, 0x73, 0x63, 0x6F, 0x0B]);
  assert.deepEqual(assemble("atomic.notify align=2 offset=0\ni32.atomic.wait align=2 offset=0\nend"), assemble("memory.atomic.notify align=2 offset=0\nmemory.atomic.wait32 align=2 offset=0\nend"));
  assert.deepEqual([...assemble("i64.load align=3 offset=18446744073709551615\nend")], [0x29, 3, ...L.leb.u64(2n ** 64n - 1n), 0x0B]);
  assert.equal(disassemble([0x28, 0x42, 3, 0x80, 1, 0x0B]).text, "i32.load align=2 offset=128 memory=3\nend");
  assert.equal(disassemble([0xFD, 0x80, 0x02, 0x0B]).text, "i8x16.relaxed_swizzle\nend");
});

test("assembler aliases, operands and errors", () => {
  assert.deepEqual(assemble("get_local 0\nend"), assemble("local.get 0\nend"));
  assert.deepEqual([...assemble("i32.const 0xFFFFFFFF\ni64.const 18446744073709551615\ni32.trunc_s/f32\nend")], [0x41, 0x7F, 0x42, 0x7F, 0xA8, 0x0B]);
  assert.deepEqual([...assemble("  block\n\tnop  \n  end\nend")], [2, 0x40, 1, 0x0B, 0x0B]);
  const cases = [["local.get\nend", 1, "Missing operand"], ["nop\nlocal.get  1\nend", 2, "Empty operand"], ["nop\nnop\ni32.const 1 2\nend", 3, "Unexpected token"],
    ["foo.bar\nend", 1, "Unknown mnemonic"], ["nop\nend\nend", 3, "Unbalanced end"], ["end\nnop", 2, "Instruction after"], ["block\nnop", 2, "Missing end"],
    ["i32.const 2147483648x\nend", 1, "Invalid integer"], ["i32.const 4294967296\nend", 1, "Invalid integer"], ["f32.const abc\nend", 1, "Invalid float"],
    ["block toString\nend\nend", 1, "Invalid integer"], ["i32.load offset=1 align=2\nend", 1, "align"], ["else\nend", 1, "else"], ["br_table 2 0 1\nend", 1, "Missing operand"],
    ["ref.null toString\nend", 1, "Invalid type"], ["", 1, "Missing end"], ["catch_all\nend", 1, "catch_all outside"], ["delegate 0\nend", 1, "Unbalanced delegate"],
    ["i32.load align=64 offset=0\nend", 1, "Invalid integer"], ["v128.const i32x3 1 2 3\nend", 1, "Invalid shape"], ["v128.const i8x16 1\nend", 1, "Missing operand"],
    ["i8x16.extract_lane_s 256\nend", 1, "Invalid integer"], ["try_table catch 0\nend\nend", 1, "Missing operand"], ["try_table bogus\nend\nend", 1, "Invalid integer"],
    ["try_table i32 catch 0 0 oops\nend\nend", 1, "catch clause"], ["ref.test (ref foo)\nend", 1, "Invalid type"], ["ref.cast i32\nend", 1, "reference type"],
    ["br_on_cast 0 anyref\nend", 1, "Missing operand"], ["select i32 (ref null bogus)\nend", 1, "Unexpected token"]];
  for (const [text, line, msg] of cases) assert.throws(() => assemble(text), e => e instanceof AsmError && e.line === line && e.message.includes(msg), text);
  for (const [bytes, offset] of [[[1, 0xFD, 0], 1], [[1, 1, 0xFE, 0], 2], [[6], 0], [[0xFC, 18], 0], [[0x41], 0], [[0x0E, 0xFF, 0xFF, 0xFF, 0xFF, 0x0F], 0],
    [[1, 0xFD, 0x9A, 1], 1], [[0xFD, 0x94, 2], 0], [[0xFE, 4], 0], [[0xFB, 0x1F], 0], [[0xFB, 0x80, 0x20], 0], [[0x17], 0], [[0xFF], 0], [[0xFE, 3, 1], 0],
    [[0x28, 0x80, 1, 0], 0], [[0x1F, 0x40, 1, 4, 0], 0], [[0xFB, 0x18, 4, 0, 0x6E, 0x6E], 0], [[0xD0, 0x60], 0], [[0x1C, 1, 0x60], 0], [[0x1C, 1, 0x63, 0x7F], 0]])
    assert.throws(() => disassemble(bytes), e => e instanceof AsmError && e.offset === offset && e.message.includes("offset"), String(bytes));
});

const PAGE = ["shared/utils.js", "shared/wail.min.js/wail.min.js", "content/init.js"];
const page = (config = {}) => {
  const ctx = loadPage(PAGE), regs = [], hits = [];
  Object.assign(ctx.cetusLib, { register: r => regs.push(r), watchHit: (slot, kind) => hits.push({ slot, kind, stack: new Error().stack }) });
  ctx.dispatchEvent(new ctx.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: { patches: [], callbacks: { processor: [], preinstantiate: [] }, ...config } }) }));
  return { ctx, regs, hits };
};
const instr = (opts, game = buildGame()) => {
  const meta = page().ctx.cetusLib.instrument(game, opts), hits = [];
  const x = new WebAssembly.Instance(new WebAssembly.Module(meta.bytes), { __cetus: { read: s => hits.push([s, "read"]), write: s => hits.push([s, "write"]) } }).exports;
  return { meta, x, hits };
};
const plain = o => JSON.parse(JSON.stringify(o));
const hitList = hits => hits.splice(0).map(h => Array.isArray(h) ? h : [h.slot, h.kind]).sort();
const caller = (h, helpers) => [...h.stack.matchAll(/wasm-function\[(\d+)\]:0x([0-9a-f]+)/g)].map(m => +m[1]).find(f => !helpers.includes(f));

test("instrument keeps behavior over 100 seeded call sequences", () => {
  let seed = 99;
  const rnd = n => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n;
  const { meta, hits } = instr(), game = buildGame();
  assert.ok(WebAssembly.validate(meta.bytes));
  const ma = new WebAssembly.Module(game), mb = new WebAssembly.Module(meta.bytes), imports = { __cetus: { read: () => hits.push(1), write: () => hits.push(1) } };
  const calls = [x => x.getHealth(), x => x.setHealth(rnd(2 ** 32) - 2 ** 31), x => x.damage(rnd(200) - 100), x => x.addGold(rnd(1000)), x => x.readGold(), x => x.getLives(),
    x => x.magic(), x => x.truncSat(rnd(1e6) / 7 - 7e4), x => x.pair(), x => x.callMagic(), x => x.level.value];
  for (let i = 0; i < 100; i++) {
    const a = new WebAssembly.Instance(ma).exports, b = new WebAssembly.Instance(mb, imports).exports;
    for (let n = rnd(30) + 1; n--;) {
      const c = rnd(calls.length), s = seed, want = calls[c](a);
      seed = s;
      assert.deepEqual(calls[c](b), want);
    }
    assert.ok(Buffer.from(a.memory.buffer).equals(Buffer.from(b.memory.buffer)));
    assert.equal(b.callMagic(), -16);
  }
  assert.equal(hits.length, 0);
});

test("write watch hits once per changing store and clears", async () => {
  const { ctx, regs, hits } = page();
  const { instance } = await ctx.WebAssembly.instantiate(buildGame()), x = instance.exports, { helpers } = regs[0].meta;
  x.__cetus_watch(0, GAME.HEALTH, 4, 1);
  x.damage(1);
  assert.equal(caller(hits[0], helpers), 4);
  assert.deepEqual(hitList(hits), [[0, "write"]]);
  x.addGold(1);
  x.setHealth(99);
  assert.deepEqual(hitList(hits), []);
  x.__cetus_watch(0, GAME.HEALTH + 2, 2, 1);
  x.damage(1);
  assert.deepEqual(hitList(hits), []);
  x.setHealth(0x12345678);
  assert.deepEqual(hitList(hits), [[0, "write"]]);
  x.__cetus_watch(0, 0, 0, 0);
  x.damage(5);
  x.setHealth(1);
  assert.deepEqual(hitList(hits), []);
});

test("read watch honors offsets and boundaries", async () => {
  const { ctx, regs, hits } = page();
  const { instance } = await ctx.WebAssembly.instantiate(buildGame()), x = instance.exports, { helpers } = regs[0].meta;
  x.__cetus_watch(1, GAME.GOLD, 4, 2);
  x.readGold();
  assert.equal(caller(hits[0], helpers), 6);
  assert.deepEqual(hitList(hits), [[1, "read"]]);
  x.getHealth();
  x.setHealth(5);
  assert.deepEqual(hitList(hits), []);
  x.__cetus_watch(1, GAME.HEALTH + 3, 1, 2);
  x.getHealth();
  assert.deepEqual(hitList(hits), [[1, "read"]]);
  x.readGold();
  assert.deepEqual(hitList(hits), []);
});

test("4 watch slots work at once and independently", () => {
  const { x, hits } = instr();
  x.__cetus_watch(0, GAME.HEALTH, 4, 1);
  x.__cetus_watch(1, GAME.GOLD, 4, 1);
  x.__cetus_watch(2, GAME.GOLD, 4, 2);
  x.__cetus_watch(3, GAME.HEALTH, 4, 2);
  x.damage(1);
  assert.deepEqual(hitList(hits), [[0, "write"], [3, "read"]]);
  x.addGold(1);
  assert.deepEqual(hitList(hits), [[1, "write"], [2, "read"]]);
  x.readGold();
  assert.deepEqual(hitList(hits), [[2, "read"]]);
  x.__cetus_watch(1, 0, 0, 0);
  x.addGold(1);
  assert.deepEqual(hitList(hits), [[2, "read"]]);
  x.__cetus_watch(0, GAME.HEALTH, 4, 3);
  x.damage(1);
  assert.deepEqual(hitList(hits), [[0, "read"], [0, "write"], [3, "read"]]);
});

test("patches replace function bodies", async () => {
  const magic = [...assemble("i32.const 999\nend")], lives = [...assemble("i32.const 7\nend")];
  const { x } = instr({ patches: [{ index: 8, bytes: magic }, { index: 7, bytes: lives }] });
  assert.equal(x.magic(), 999);
  assert.equal(x.callMagic(), 999);
  assert.equal(x.getLives(), 7);
  assert.equal(x.getHealth(), 100);
  const { ctx, regs } = page({ patches: [{ index: 8, bytes: magic }], callbacks: { processor: ["processor.patched = 1"], preinstantiate: ["importObject.env.seen = module.length"] } });
  const imports = { env: {} }, { instance } = await ctx.WebAssembly.instantiateStreaming(new Response(buildGame()), imports);
  assert.equal(instance.exports.magic(), 999);
  assert.equal(imports.env.seen, buildGame().length);
  assert.ok(regs[0].instrumented);
});

test("internal globals are exported as __cetus_g<N>", () => {
  const { x, meta } = instr();
  assert.deepEqual(plain(meta.globals), [["i32", true], ["i32", true], ["f32", true], ["v128", true], ["funcref", false], ["f64", false]].map(([type, mutable], index) => ({ index, type, mutable, name: `__cetus_g${index}` })));
  assert.deepEqual(plain(meta.memory), { kind: "export", name: "memory" });
  assert.equal(x.__cetus_g0.value, 3);
  x.__cetus_g0.value = 9;
  assert.equal(x.getLives(), 9);
  assert.deepEqual(plain(page().ctx.cetusLib.instrument(buildGame({ importMemory: true })).memory), { kind: "import", module: "env", field: "memory" });
});

test("every defined function is exported as __cetus_f<N> in running index space", () => {
  for (const opts of [{}, { multimem: true, gc: true, bulk: true }]) {
    const game = buildGame(opts), n = WebAssembly.Module.exports(new WebAssembly.Module(game)).length;
    const { meta, x } = instr({ coverage: true }, game), m = page().ctx.cetusLib.scan(game);
    assert.ok(WebAssembly.validate(meta.bytes));
    const want = m.funcs.slice(m.funcImports).map((_, k) => ({ func: k + 2, field: `__cetus_f${k + 2}` }));
    assert.deepEqual(plain(meta.fexports), plain(want));
    assert.equal(WebAssembly.Module.imports(new WebAssembly.Module(meta.bytes)).length, 2);
    for (const { func, field } of want) assert.equal(x[field].name, String(func));
    assert.equal(x[meta.fexports.at(-1).field](5), 22);
    assert.equal(x.__cetus_f15(5), 1005);
    const internalMems = meta.memories.filter(y => y.kind === "internal").length;
    assert.equal(Object.keys(x).length, n + want.length * 2 + 2 + meta.globals.length + internalMems);
  }
  const head = [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1];
  const taken = new Uint8Array([...head, 7, 14, 1, 10, ...Buffer.from("__cetus_f2"), 0, 0, 10, 4, 1, 2, 0, 0x0b]);
  const { meta, x } = instr({}, taken);
  assert.deepEqual(plain(meta.fexports), [{ func: 2, field: "__cetus_f2_1" }]);
  assert.equal(x.__cetus_f2, x.__cetus_f2_1);
});

test("hooks register every entry point with a working memory", async () => {
  for (const importMemory of [false, true]) {
    const { ctx, regs } = page(), W = ctx.WebAssembly, game = buildGame({ importMemory });
    const imports = Object.freeze({ env: Object.freeze(importMemory ? { memory: new W.Memory({ initial: 1 }) } : {}) });
    const res = () => new Response(game, { headers: { "Content-Type": "application/wasm" } });
    const paths = {
      instantiate: async () => (await W.instantiate(game, imports)).instance,
      instantiateModule: async () => W.instantiate(await W.compile(game), imports),
      instantiateStreaming: async () => (await W.instantiateStreaming(res(), imports)).instance,
      compileStreaming: async () => W.instantiate(await W.compileStreaming(Promise.resolve(res())), imports),
      compileInstance: async () => new W.Instance(await W.compile(game), imports),
      module: async () => new W.Instance(new W.Module(game), imports),
    };
    for (const [name, load] of Object.entries(paths)) {
      const instance = await load(), r = regs.at(-1);
      assert.equal(r.instance, instance, name);
      assert.ok(r.instrumented && r.error === null && r.meta.helpers.length === 11, name);
      assert.ok(W.validate(r.bytes), name);
      instance.exports.setHealth(42);
      assert.equal(new DataView(r.memory.buffer).getInt32(GAME.HEALTH, true), 42, name);
      assert.equal(typeof instance.exports.__cetus_watch, "function", name);
    }
    assert.equal(regs.length, 6);
    assert.deepEqual(Object.keys(imports), ["env"]);
  }
});

test("hooks reject errors and fall back to the original bytes", async () => {
  const { ctx, regs } = page(), W = ctx.WebAssembly;
  await assert.rejects(W.instantiate(buildGame({ importMemory: true }), { env: {} }), e => e.name === "LinkError");
  await assert.rejects(W.instantiateStreaming(new Response("missing", { status: 404 })), e => e.name === "TypeError");
  await assert.rejects(W.compile(new Uint8Array([0, 1, 2])), e => e.name === "CompileError");
  assert.throws(() => new W.Module(new Uint8Array([0])), e => e.name === "CompileError");
  assert.equal(regs.length, 0);
  ctx.cetusLib.instrument = () => { throw new Error("boom"); };
  const { instance } = await W.instantiate(buildGame());
  assert.equal(instance.exports.getHealth(), 100);
  assert.equal(instance.exports.__cetus_watch, undefined);
  assert.deepEqual([regs[0].instrumented, regs[0].error, regs[0].memory === instance.exports.memory], [false, "boom", true]);
  ctx.cetusLib.instrument = () => ({ bytes: new Uint8Array([0]) });
  const inst = new W.Instance(new W.Module(buildGame()));
  assert.equal(inst.exports.readGold(), 500);
  assert.equal(regs[1].instrumented, false);
  assert.match(regs[1].error, /magic|WebAssembly|expected/i);
});

test("WAIL handles modern opcodes, sections and segment flags", () => {
  const sec = (id, b) => [id, b.length, ...b];
  const main = [0, 0x41, 5, 0xfd, 0x11, 0xfd, 0xa0, 0x01, 0xfd, 0x1b, 0, 0x1a, 0xfe, 0x03, 0, 0xd2, 1, 0x1a, 0x41, 0, 0x2d, 0, 0, 0x1a, 0x41, 0, 0x11, 0, 0, 0x0b];
  const mod = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sec(1, [2, 0x60, 0, 1, 0x7f, 0x60, 0, 0]), ...sec(3, [2, 0, 0]), ...sec(4, [1, 0x70, 0, 2]),
    ...sec(5, [1, 0, 1]), ...sec(13, [1, 0, 1]), ...sec(7, [2, 4, ...Buffer.from("main"), 0, 0, 13, ...Buffer.from("__cetus_watch"), 0, 1]),
    ...sec(9, [3, 5, 0x70, 1, 0xd2, 1, 0x0b, 3, 0, 1, 1, 6, 0, 0x41, 0, 0x0b, 0x70, 1, 0xd2, 1, 0x0b]), ...sec(12, [1]),
    ...sec(10, [2, main.length, ...main, 4, 0, 0x41, 42, 0x0b]), ...sec(11, [1, 2, 0, 0x41, 0, 0x0b, 1, 7])]);
  assert.ok(WebAssembly.validate(mod));
  const { x, meta } = instr(undefined, mod);
  assert.deepEqual(plain(meta.memory), { kind: "internal", name: "__cetus_memory" });
  assert.equal(x.main(), 42);
  assert.equal(x.__cetus_watch(), 42);
  assert.equal(typeof x.__cetus_watch_1, "function");
  assert.equal(new Uint8Array(x.__cetus_memory.buffer)[0], 7);
});

await import("../content/cetus.js");

const scanMemory = async () => {
  const memory = new WebAssembly.Memory({ initial: 4 });
  await WebAssembly.instantiate(buildGame({ importMemory: true }), { env: { memory } });
  const u8 = new Uint8Array(memory.buffer);
  for (let i = 0x1000, s = 7; i < 0x5000; i++) u8[i] = (s = s * 1103515245 + 12345 >>> 0) >>> 25;
  const dv = () => new DataView(memory.buffer);
  return { memory, dv, scan: new L.Scan(() => memory.buffer) };
};
const S = (type, compare, value, extra = {}) => ({ type, compare, value: value == null || L.isFloat(type) && typeof value === "number" ? value : L.TYPES.indexOf(type) < 10 ? L.parseValue(String(value), type) : value, aligned: true, ...extra });
const addrs = s => s.rows(1e9).map(r => r.address);

test("scan exact integer values across types", async () => {
  const { dv, scan } = await scanMemory();
  scan.first(S("i32", "eq", 100));
  assert.ok(addrs(scan).includes(GAME.HEALTH));
  dv().setInt32(GAME.HEALTH, 90, true);
  assert.deepEqual(scan.next(S("i32", "eq", 90)), { count: 1 });
  assert.deepEqual(scan.rows(), [{ address: GAME.HEALTH, value: 90, previous: 90 }]);
  assert.deepEqual(addrs(scan), [GAME.HEALTH]);
  scan.first(S("i16", "eq", -5));
  assert.deepEqual(addrs(scan), [GAME.NEG]);
  scan.first(S("u16", "eq", 65531));
  assert.deepEqual(addrs(scan), [GAME.NEG]);
  dv().setUint32(0x300, 0xF0000001, true);
  scan.first(S("u32", "eq", 0xF0000001));
  assert.deepEqual(scan.rows(), [{ address: 0x300, value: 0xF0000001, previous: 0xF0000001 }]);
  scan.first(S("i64", "eq", 1234567890123n));
  assert.deepEqual(scan.rows(), [{ address: GAME.SCORE, value: 1234567890123n, previous: 1234567890123n }]);
  dv().setBigUint64(0x308, 2n ** 64n - 1n, true);
  scan.first(S("u64", "eq", "0xFFFFFFFFFFFFFFFF"));
  assert.deepEqual(scan.rows(), [{ address: 0x308, value: 2n ** 64n - 1n, previous: 2n ** 64n - 1n }]);
  assert.equal(scan.type, "u64");
  scan.first(S("u64", "gt", 2n ** 63n));
  assert.deepEqual(addrs(scan), [0x308]);
  assert.throws(() => scan.first(S("i32", "changed")), /Invalid comparison/);
  assert.throws(() => scan.first(S("i32", "eq")), /Missing/);
});

test("scan unknown initial value and diff compares", async () => {
  const { dv, scan } = await scanMemory();
  const total = scan.first(S("i32", "unknown")).count;
  assert.equal(total, 4 * 65536 / 4);
  dv().setInt32(GAME.HEALTH, 99, true);
  assert.equal(scan.next(S("i32", "unchanged")).count, total - 1);
  assert.ok(!addrs(scan).includes(GAME.HEALTH));
  scan.first(S("i32", "unknown"));
  dv().setInt32(GAME.HEALTH, 98, true);
  assert.deepEqual(scan.next(S("i32", "decreased")), { count: 1 });
  assert.deepEqual(scan.rows(), [{ address: GAME.HEALTH, value: 98, previous: 98 }]);
  scan.first(S("u32", "unknown"));
  dv().setUint32(GAME.GOLD, 600, true);
  assert.equal(scan.rows().length, 100);
  assert.deepEqual(scan.next(S("u32", "increased")), { count: 1 });
  assert.deepEqual(addrs(scan), [GAME.GOLD]);
  dv().setUint32(GAME.GOLD, 600, true);
  assert.equal(scan.next(S("u32", "changed")).count, 0);
  scan.first(S("u32", "unknown"));
  dv().setUint32(GAME.GOLD, 1, true);
  assert.deepEqual(scan.next(S("u32", "changed")), { count: 1 });
  assert.deepEqual(scan.rows(), [{ address: GAME.GOLD, value: 1, previous: 1 }]);
  scan.first(S("i32", "gt", 50));
  dv().setInt32(GAME.HEALTH, 40, true);
  assert.ok(addrs(scan).includes(GAME.HEALTH));
  assert.ok(!(scan.next(S("i32", "gt")), addrs(scan)).includes(GAME.HEALTH));
});

test("scan float tolerance", async () => {
  const { dv, scan } = await scanMemory();
  dv().setFloat32(GAME.SPEED, 57.29999, true);
  scan.first(S("f32", "eq", "57.3", { tolerance: 0.05, upper: 0x1000 }));
  assert.deepEqual(addrs(scan), [GAME.SPEED]);
  assert.equal(scan.first(S("f32", "eq", "57.3", { tolerance: 0 })).count, 0);
  dv().setFloat32(GAME.SPEED, 57.3, true);
  assert.deepEqual((scan.first(S("f32", "eq", "57.3")), addrs(scan)), [GAME.SPEED]);
  dv().setFloat64(0x400, NaN, true);
  assert.ok(!(scan.first(S("f64", "ne", "1")), addrs(scan)).includes(0x400));
});

test("scan range, alignment and growth", async () => {
  const { memory, dv, scan } = await scanMemory();
  scan.first(S("i32", "unknown", null, { lower: 64 }));
  dv().setInt32(0x10, 7, true);
  dv().setInt32(GAME.HEALTH, 1, true);
  assert.deepEqual(scan.next(S("i32", "changed", null, { lower: 64 })), { count: 1 });
  assert.deepEqual(addrs(scan), [GAME.HEALTH]);
  dv().setInt32(0x401, 777777, true);
  assert.equal(scan.first(S("i32", "eq", 777777)).count, 0);
  assert.deepEqual((scan.first(S("i32", "eq", 777777, { aligned: false })), addrs(scan)), [0x401]);
  assert.equal(scan.first(S("i32", "eq", 1, { upper: GAME.HEALTH + 3 })).count, 0);
  assert.equal(scan.first(S("i32", "eq", 1, { upper: GAME.HEALTH + 4 })).count, 1);
  scan.first(S("i32", "unknown"));
  memory.grow(1);
  dv().setInt32(4 * 65536, 5, true);
  assert.equal(scan.next(S("i32", "changed")).count, 0);
  scan.first(S("i32", "eq", 1, { upper: 0x1000 }));
  memory.grow(1);
  assert.deepEqual(scan.next(S("i32", "eq", 1)), { count: 1 });
  assert.deepEqual(scan.rows(), [{ address: GAME.HEALTH, value: 1, previous: 1 }]);
});

test("scan text and byte patterns", async () => {
  const { memory, dv, scan } = await scanMemory();
  const u8 = new Uint8Array(memory.buffer);
  const hit = (type, value, extra) => (scan.first({ type, compare: "eq", value, aligned: true, ...extra }), addrs(scan));
  assert.deepEqual(hit("utf16", "Hero"), [GAME.NAME_UTF16]);
  assert.equal(scan.rows()[0].value, "Hero");
  assert.deepEqual(hit("ascii", "PLAYER_ONE"), [GAME.NAME_ASCII]);
  assert.deepEqual(hit("aob", "DE AD ?? EF"), [GAME.SIG]);
  assert.equal(scan.rows()[0].value, "DE AD BE EF");
  assert.equal(scan.rows()[0].previous, "DE AD ?? EF");
  u8.set([0x41, 0x41, 0x42], 0x500);
  assert.deepEqual(hit("aob", "4? 41 42"), [0x500]);
  assert.deepEqual(hit("aob", "?1 42", { upper: 0x1000 }), [0x501]);
  u8.set([0xAA, 0xAA, 0xAA], 0x510);
  assert.deepEqual(hit("aob", "AA AA"), [0x510, 0x511]);
  u8.set([0xCA, 0xFE], u8.length - 2);
  assert.deepEqual(hit("aob", "CA FE"), [u8.length - 2]);
  assert.deepEqual(hit("aob", L.parseAob("DE AD")), [GAME.SIG]);
  u8[GAME.SIG + 1] = 0;
  assert.equal(scan.next({ compare: "eq" }).count, 0);
  assert.throws(() => scan.first({ type: "ascii", compare: "gt", value: "x" }), /Invalid comparison/);
  assert.throws(() => scan.first({ type: "aob", compare: "eq", value: "XY" }), /Invalid byte/);
  assert.equal(scan.type, null);
});

test("findStrings ascii and utf16 at byte addresses", async () => {
  const { memory } = await scanMemory();
  const u8 = new Uint8Array(memory.buffer);
  const { rows } = L.findStrings(u8, { encoding: "utf16", minLength: 4, upper: 0x1000 });
  assert.deepEqual(rows, [{ address: GAME.NAME_UTF16, text: "Hero" }]);
  assert.ok(L.findStrings(u8, { encoding: "ascii", minLength: 4, upper: 0x1000 }).rows.some(r => r.address === GAME.NAME_ASCII && r.text === "PLAYER_ONE"));
  u8.set(Buffer.from("TAIL"), u8.length - 4);
  assert.deepEqual(L.findStrings(u8, { encoding: "ascii", minLength: 4, lower: u8.length - 100 }).rows, [{ address: u8.length - 4, text: "TAIL" }]);
  u8.set(Buffer.from("End", "utf16le"), u8.length - 6);
  assert.deepEqual(L.findStrings(u8, { encoding: "utf16", minLength: 3, lower: u8.length - 100 }).rows, [{ address: u8.length - 6, text: "End" }]);
  const many = L.findStrings(u8, { encoding: "ascii", minLength: 1, limit: 5 });
  assert.equal(many.rows.length, 5);
  assert.ok(many.count > 5);
});

test("utf8 text: toBytes, read, scan, findStrings and page handlers", async () => {
  const s = "Zoë \u6f22 \u{1F600}", b = L.toBytes(s, "utf8");
  assert.deepEqual([...L.toBytes("Zoë", "utf8")], [0x5A, 0x6F, 0xC3, 0xAB]);
  assert.deepEqual([...b.slice(-4)], [0xF0, 0x9F, 0x98, 0x80]);
  assert.equal(L.read(new DataView(b.buffer), 0, "utf8", b.length), s);
  assert.equal(L.formatValue(b, "utf8"), s);
  assert.equal(L.read(new DataView(Uint8Array.of(0x41, 0xFF).buffer), 0, "utf8", 2), "A\uFFFD");
  assert.deepEqual(L.TYPES.slice(10, 15), ["ascii", "utf16", "utf8", "aob", "binary"]);
  const { memory, scan } = await scanMemory(), u8 = new Uint8Array(memory.buffer);
  assert.deepEqual((scan.first({ type: "utf8", compare: "eq", value: "Héros", aligned: true }), addrs(scan)), [GAME.NAME_UTF8]);
  assert.equal(scan.rows()[0].value, "Héros");
  assert.deepEqual((scan.first({ type: "utf8", compare: "eq", value: "hÉROS", caseSensitive: false }), addrs(scan)), []);
  assert.deepEqual((scan.first({ type: "utf8", compare: "eq", value: "hé", caseSensitive: false }), addrs(scan)), [GAME.NAME_UTF8]);
  assert.ok(L.findStrings(u8, { encoding: "utf8", minLength: 4, upper: 0x1000 }).rows.some(r => r.address === GAME.NAME_UTF8 && r.text === "Héros"));
  u8.set([0x41, 0xC3, 0x28, 0xE2, 0x82, ...b, 0xED, 0xA0, 0x80, 0xC0, 0xAF, 0xF4, 0x90, 0x80, 0x80, 0x41], u8.length - b.length - 16);
  assert.deepEqual(L.findStrings(u8, { encoding: "utf8", minLength: 3, lower: u8.length - 100 }).rows, [{ address: u8.length - b.length - 11, text: s }]);
  assert.equal(L.findStrings(u8, { encoding: "utf8", minLength: 9, lower: u8.length - 100 }).count, 0);
  const { call } = await runtime();
  assert.deepEqual((await call("strings", { encoding: "utf8", minLength: 5, upper: 0x1000 })).rows,
    [{ address: GAME.NAME_ASCII, text: "PLAYER_ONE" }, { address: GAME.NAME_UTF8, text: "Héros" }]);
  assert.deepEqual(await call("find", { from: 0, type: "utf8", value: "éros" }), { address: GAME.NAME_UTF8 + 1 });
  assert.equal((await call("scan", { type: "utf8", compare: "eq", value: "Héros", aligned: true })).count, 1);
  await call("write", { address: GAME.NAME_UTF8, type: "utf8", value: "\u{1F600}" });
  assert.deepEqual((await call("readValues", { items: [{ address: GAME.NAME_UTF8, type: "utf8", length: 6 }] })).values, ["\u{1F600}os"]);
  await assert.rejects(call("freeze", { address: GAME.NAME_UTF8, type: "utf8", value: "x", enabled: true }), /numeric/);
});

const XOR = { name: "xor", size: 4, decode: "new DataView(bytes.buffer).getInt32(0,true)^0x5A5A5A5A",
  encode: "const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, value ^ 0x5A5A5A5A, true); return [...b];" };

test("big-endian types round trip at type boundaries and scan", async () => {
  const edges = { i16: [-32768, 32767], u16: [0, 65535], i32: [-(2 ** 31), 2 ** 31 - 1], u32: [0, 2 ** 32 - 1],
    i64: [-(2n ** 63n), 2n ** 63n - 1n], u64: [0n, 2n ** 64n - 1n], f32: [-3.4028234663852886e38, 1.401298464324817e-45], f64: [-Number.MAX_VALUE, Number.MIN_VALUE] };
  assert.deepEqual(L.TYPES.slice(15), ["i16be", "u16be", "i32be", "u32be", "i64be", "u64be", "f32be", "f64be"]);
  const dv = new DataView(new ArrayBuffer(16));
  for (const [t, vals] of Object.entries(edges)) for (const v of vals) {
    const be = t + "be", b = L.toBytes(v, be);
    L.write(dv, 3, be, v);
    assert.equal(L.read(dv, 3, be), v, be);
    assert.deepEqual([...b], [...L.toBytes(v, t)].reverse(), be);
    assert.equal(L.read(new DataView(b.buffer), 0, be), v, be);
    assert.deepEqual([L.sizeOf(be), L.isBig(be), L.isFloat(be), L.isNum(be)], [L.sizeOf(t), L.isBig(t), L.isFloat(t), true]);
    assert.equal(L.parseValue(String(v), be), L.parseValue(String(v), t));
  }
  assert.equal(L.formatValue(-2, "i16be", true), "0xFFFE");
  assert.equal(L.parseValue("0xFFFF", "i16be"), -1);
  assert.deepEqual([...L.toBytes("0x11223344", "u32be")], [0x11, 0x22, 0x33, 0x44]);
  assert.deepEqual(L.parseGroup("u16be:258 i32be:*").map(e => [e.type, e.offset, e.size, e.value]), [["u16be", 0, 2, 258], ["i32be", 2, 4, null]]);
  const { memory, scan } = await scanMemory();
  assert.deepEqual((scan.first({ type: "u32be", compare: "eq", value: "287454020", aligned: true }), addrs(scan)), [GAME.BE]);
  assert.equal(scan.rows()[0].value, 287454020);
  new DataView(memory.buffer).setUint32(GAME.BE, 287454021);
  assert.deepEqual((scan.next({ compare: "increased" }), addrs(scan)), [GAME.BE]);
  assert.deepEqual((scan.first({ type: "u64be", compare: "eq", value: "0x1122334400000000", aligned: false, upper: 0x300 }), addrs(scan)), []);
  const { call } = await runtime();
  assert.equal((await call("scan", { type: "u32be", compare: "eq", value: "287454020", aligned: true })).rows[0].address, GAME.BE);
  await call("write", { address: GAME.BE, type: "i16be", value: "-2" });
  assert.deepEqual((await call("readValues", { items: [{ address: GAME.BE, type: "u16be" }, { address: GAME.BE, type: "u64be" }] })).values,
    [0xFFFE, 0xFFFE3344_00000000n]);
});

test("custom types: validation, scan, read, write, freeze and hotkeys through the codec", async () => {
  assert.throws(() => L.customTypes([{ ...XOR, name: "u32be" }]), /Invalid custom type name/);
  assert.throws(() => L.customTypes([{ ...XOR, size: 0 }]), /Invalid size/);
  assert.throws(() => L.customTypes([{ ...XOR, decode: "(" }], true), SyntaxError);
  assert.deepEqual(L.customTypes([XOR]), [XOR]);
  assert.ok(L.isNum("xor") && L.isType("xor") && !L.isFloat("xor") && L.sizeOf("xor") === 4 && !L.TYPES.includes("xor"));
  const { memory, scan } = await scanMemory(), dv = new DataView(memory.buffer);
  dv.setInt32(0x2002, 1234 ^ 0x5A5A5A5A, true);
  assert.equal(L.read(dv, 0x2002, "xor"), 1234);
  assert.deepEqual((scan.first({ type: "xor", compare: "eq", value: "1234", aligned: false }), addrs(scan)), [0x2002]);
  assert.deepEqual((scan.first({ type: "xor", compare: "eq", value: "1234", aligned: true }), addrs(scan)), []);
  scan.first({ type: "xor", compare: "unknown", aligned: true, lower: 0x2000, upper: 0x2010 });
  L.write(dv, 0x2004, "xor", 99);
  assert.deepEqual((scan.next({ compare: "changed" }), addrs(scan)), [0x2004]);
  assert.deepEqual((scan.next({ compare: "eq", value: "99" }), scan.rows().map(r => [r.address, r.value])), [[0x2004, 99]]);
  L.customTypes([{ name: "odd", size: 1, decode: "if (bytes[0] === 7) throw 0; return bytes[0]", encode: "[value]" }]);
  dv.setUint8(0x2010, 5);
  assert.deepEqual((scan.first({ type: "odd", compare: "eq", value: "5", aligned: false, lower: 0x2010, upper: 0x2011 }), addrs(scan)), [0x2010]);
  dv.setUint8(0x2010, 7);
  scan.saveAs("odd");
  dv.setUint8(0x2010, 0);
  assert.deepEqual((scan.next({ compare: "unchanged", base: "saved:odd" }), addrs(scan)), []);
  L.customTypes([]);
  const { ctx, call, x, events } = await runtime();
  assert.deepEqual((await call("readValues", { items: [{ address: 0, type: "xor" }] })).values, [null]);
  await assert.rejects(call("customTypes", { types: [{ ...XOR, encode: "return [" }] }), /Custom type xor/);
  assert.deepEqual(await call("customTypes", { types: [XOR, { name: "bad", size: 4, decode: "throw new Error('x')", encode: "[1]" }] }), {});
  x.setHealth(1234 ^ 0x5A5A5A5A);
  const r = await call("scan", { type: "xor", compare: "eq", value: "1234", aligned: true });
  assert.deepEqual([r.count, r.rows[0].address, r.rows[0].value], [1, GAME.HEALTH, 1234]);
  const items = ["xor", "bad", "i32"].map(type => ({ address: GAME.HEALTH, type }));
  assert.deepEqual((await call("readValues", { items })).values, [1234, null, 1234 ^ 0x5A5A5A5A]);
  assert.equal((await call("scanReset"), await call("scan", { type: "bad", compare: "unknown", aligned: true, upper: 0x200 })).count, 128);
  assert.equal((await call("scanReset"), await call("scan", { type: "bad", compare: "ne", value: "1", aligned: true })).count, 0);
  await assert.rejects(call("write", { address: GAME.HEALTH, type: "bad", value: "1" }), /encode must return 4 bytes/);
  await call("write", { address: GAME.HEALTH, type: "xor", value: "0x10" });
  assert.equal(x.getHealth(), 16 ^ 0x5A5A5A5A);
  assert.deepEqual(await call("find", { from: 0, type: "xor", value: "16" }), { address: GAME.HEALTH });
  await call("freeze", { address: GAME.HEALTH, type: "xor", value: "1234", enabled: true });
  await call("freeze", { address: GAME.GOLD, type: "bad", value: "1", enabled: true });
  x.setHealth(5);
  await tick(ctx);
  assert.equal(x.getHealth(), 1234 ^ 0x5A5A5A5A);
  await call("freeze", { address: GAME.HEALTH, type: "xor", value: "1000", enabled: true, mode: "noDecrease" });
  x.setHealth(2000 ^ 0x5A5A5A5A);
  await tick(ctx);
  assert.equal(x.getHealth(), 2000 ^ 0x5A5A5A5A);
  x.setHealth(10 ^ 0x5A5A5A5A);
  await tick(ctx);
  assert.equal(x.getHealth(), 2000 ^ 0x5A5A5A5A);
  await call("freeze", { address: GAME.GOLD, type: "bad", enabled: false });
  await call("customTypes", { types: [XOR, { name: "bad", size: 4, decode: "throw 0", encode: "[1, 2, 3, 4]" }] });
  const gold = x.readGold();
  await call("freeze", { address: GAME.GOLD, type: "bad", value: "1", enabled: true, mode: "step", step: "3" });
  await tick(ctx);
  assert.equal(x.readGold(), gold);
  await call("freeze", { address: GAME.HEALTH, type: "xor", enabled: false });
  await call("freeze", { address: GAME.GOLD, type: "bad", enabled: false });
  await call("hotkeys", { bindings: [{ combo: "Alt+K", action: "inc", entry: { address: GAME.HEALTH, type: "xor" }, value: "5" }] });
  ctx.dispatchEvent(Object.assign(new ctx.Event("keydown"), { code: "KeyK", key: "k", altKey: true }));
  await tick(ctx);
  assert.equal(events.filter(e => e.type === "hotkey").at(-1).body.error, undefined);
  assert.equal(x.getHealth(), 2005 ^ 0x5A5A5A5A);
  const cfg = await runtime(c => c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: {
    customTypes: [XOR], table: [{ address: GAME.GOLD, type: "xor", frozen: true, freezeValue: "7" }] } }) })));
  await tick(cfg.ctx);
  assert.equal(cfg.x.readGold(), 7 ^ 0x5A5A5A5A);
  cfg.out({ type: "config", body: { customTypes: [] } });
  assert.deepEqual((await cfg.call("readValues", { items: [{ address: GAME.GOLD, type: "xor" }] })).values, [null]);
  await cfg.call("freeze", { address: GAME.GOLD, type: "u32", enabled: false });
});

test("scan clamps bad ranges", async () => {
  const { scan } = await scanMemory();
  assert.equal(scan.first(S("i32", "unknown", null, { lower: 0x200, upper: 0x100 })).count, 0);
  assert.equal(scan.first(S("i32", "eq", 100, { lower: "x", upper: 1e12 })).count >= 1, true);
  assert.equal(L.findStrings(new Uint8Array(8), { encoding: "ascii", lower: 9, upper: 2 }).count, 0);
});

const RUNTIME = ["shared/utils.js", "shared/wail.min.js/wail.min.js", "content/cetus.js", "content/init.js"];
const runtime = async (setup = () => {}, callbacks = { processor: [], preinstantiate: [] }, wasm = buildGame()) => {
  const ctx = loadPage(RUNTIME), events = [], waits = new Map();
  let n = 0;
  setup(ctx);
  const out = m => ctx.dispatchEvent(new ctx.CustomEvent("cetusMsgOut", { detail: typeof m === "string" ? m : L.encode(m) }));
  ctx.addEventListener("cetusMsgIn", e => { const m = L.decode(e.detail); m.id != null ? waits.get(m.id)(m) : events.push(m); });
  const send = (type, body, id = ++n) => new Promise(r => { waits.set(id, r); out({ id, type, body }); });
  const call = async (type, body = {}) => { const r = await send(type, body); if (!r.ok) throw new Error(r.error); return r.body; };
  out({ type: "config", body: { patches: [], callbacks } });
  const { instance } = await ctx.WebAssembly.instantiate(wasm);
  return { ctx, events, out, send, call, instance, x: instance.exports };
};
const tick = ctx => new Promise(r => ctx.requestAnimationFrame(r));

test("runtime re-sends init on a bfcache pageshow after reset", async () => {
  const { ctx, events, call } = await runtime();
  const id = (await call("state")).instances[0].id;
  ctx.dispatchEvent(new ctx.Event("pagehide"));
  ctx.dispatchEvent(Object.assign(new ctx.Event("pageshow"), { persisted: false }));
  assert.deepEqual(events.map(e => e.type), ["needSource", "init", "reset"]);
  ctx.dispatchEvent(Object.assign(new ctx.Event("pageshow"), { persisted: true }));
  assert.deepEqual(events.map(e => e.type), ["needSource", "init", "reset", "init"]);
  assert.equal(events[3].body.instance.id, id);
});

test("watch hits keep the last values and call stack", async () => {
  const { call, x } = await runtime();
  const r = await call("watch", { address: GAME.HEALTH, size: 4, kind: "write", enabled: true, break: true });
  assert.equal(r.watches[0].break, true);
  x.damage(10);
  let [h] = (await call("state")).hits;
  assert.deepEqual([h.last.old, h.last.new, h.last.stack[0].name, h.last.stack[0].func, h.last.stack[0].offset], [100, 90, "damage", h.func, h.offset]);
  await call("write", { address: GAME.HEALTH, type: "i32", value: "50" });
  x.damage(1);
  [h] = (await call("state")).hits;
  assert.deepEqual([h.count, h.last.old, h.last.new, h.last.stack.length], [2, 50, 49, 1]);
  await call("watch", { address: GAME.HEALTH, size: 4, kind: "write", enabled: true, break: false });
  assert.equal((await call("state")).watches[0].break, undefined);
  await call("watch", { address: GAME.HEALTH, size: 4, kind: "write", enabled: false });
  await call("write", { address: GAME.HEALTH, type: "i32", value: "-1" });
  await call("watch", { address: GAME.HEALTH, size: 2, kind: "read", enabled: true });
  x.getHealth();
  [h] = (await call("state")).hits;
  assert.deepEqual([h.kind, h.last.old, h.last.new], ["read", 0xFFFF, 0xFFFF]);
});

test("watch hit stacks keep 16 frames of deep call chains", async () => {
  const dive = [0x20, 0, 4, 0x40, 0x20, 0, 0x41, 1, 0x6b, 0x10, 0, 5, 0x41, 0, 0x41, 7, 0x36, 2, ...L.leb.u32(GAME.HEALTH), 0x0b, 0x0b];
  const wasm = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...wasmSec(1, wasmVec([[0x60, 1, 0x7f, 0]])), ...wasmSec(3, wasmVec([[0]])), ...wasmSec(5, wasmVec([[0, 1]])),
    ...wasmSec(7, wasmVec([[4, ...Buffer.from("dive"), 0, 0], [6, ...Buffer.from("memory"), 2, 0]])), ...wasmSec(10, wasmVec([[...L.leb.u32(dive.length + 1), 0, ...dive]]))]);
  const { call, x } = await runtime(undefined, undefined, wasm);
  await call("watch", { address: GAME.HEALTH, size: 4, kind: "write", enabled: true });
  x.dive(20);
  const [h] = (await call("state")).hits;
  assert.deepEqual([h.last.new, h.last.stack.length, new Set(h.last.stack.map(f => f.func)).size], [7, 16, 1]);
});

test("precise watch hits report the value after the store", async () => {
  const cfg = c => c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: { instrumentOptions: { precise: true } } }) }));
  const { call, x } = await runtime(cfg);
  await call("watch", { address: GAME.HEALTH, size: 4, kind: "write", enabled: true });
  x.damage(3);
  x.damage(4);
  await Promise.resolve();
  const [h] = (await call("state")).hits;
  assert.deepEqual([h.count, h.last.old, h.last.new], [2, 97, 93]);
  x.sameStore();
  await Promise.resolve();
  const s = (await call("state")).hits.find(k => k.last.stack[0].name === "sameStore");
  assert.deepEqual([s.last.old, s.last.new], [93, 93]);
});

test("global watches report each global.set of a watched global", async () => {
  const cfg = globalWatch => L.encode({ type: "config", body: { instrumentOptions: { globalWatch } } });
  const opts = globalWatch => c => c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: cfg(globalWatch) }));
  const { call, events, x } = await runtime(opts([2, 1, 3, 5, 99, 1]));
  assert.deepEqual((await call("state")).options.globalWatch, [2, 1]);
  assert.deepEqual((await call("state")).globalHits, []);
  x.bumpLevel();
  const [h] = (await call("state")).globalHits;
  assert.deepEqual(plain(h), { global: 1, globalName: "level", func: 17, offset: h.offset, name: "bumpLevel", count: 1,
    last: 4 });
  assert.equal(x.level.value, 4);
  x.bumpLevel();
  x.damage(5);
  const again = (await call("state")).globalHits;
  assert.deepEqual(again.map(g => [g.count, g.last]), [[2, 5]]);
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(events.filter(e => e.type === "hits").at(-1).body.globalHits.map(g => g.count), [2]);
  const fb = await call("function", { index: 17 });
  assert.match(disassemble(fb.bytes).text, /global\.set 1\n\s*call \d+/);
  const refs = (await call("xrefs", { global: "level" })).rows;
  assert.deepEqual(refs.map(r => [r.text, fb.bytes[r.offset - fb.bodyOffset]]),
    [["global.get 1", 0x23], ["global.set 1", 0x24]]);
  const plainRun = await runtime(opts([]));
  plainRun.x.bumpLevel();
  assert.deepEqual((await plainRun.call("state")).globalHits, []);
  const unwatched = await plainRun.call("function", { index: 17 });
  assert.doesNotMatch(disassemble(unwatched.bytes).text, /global\.set 1\n\s*call/);
  const pre = `globalThis.posted = []; globalThis.BroadcastChannel = class {
    constructor() { globalThis.chan = this; } postMessage(m) { posted.push(m); } };`;
  const [w, m] = [`globalThis.cetusLib = { worker: "t" }; ${pre}`, pre].map(p => loadPage(RUNTIME, { pre: p }));
  for (const c of [w, m]) opts([1])(c);
  (await w.WebAssembly.instantiate(buildGame())).instance.exports.bumpLevel();
  const post = w.posted.find(p => p.t === "hit");
  assert.deepEqual([post.op, post.a, post.b, post.st[0].name, post.n], [-4, 1, 4, "bumpLevel", "level"]);
  await m.WebAssembly.instantiate(buildGame());
  await m.cetusLib.handle("watch", { address: GAME.HEALTH, size: 4, kind: "write", enabled: true });
  m.chan.onmessage({ data: { ...post, tok: m.posted.at(-1).tok } });
  const [wh] = (await m.cetusLib.handle("state", {})).globalHits;
  assert.deepEqual([wh.globalName, wh.name, wh.count, wh.last], ["level", "bumpLevel", 1, 4]);
});

test("code filter narrows functions by coverage counters", async () => {
  const cfg = c => c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: { instrumentOptions: { coverage: true } } }) }));
  const { call, x, ctx } = await runtime(cfg);
  assert.equal((await call("state")).options.coverage, true);
  await assert.rejects(call("codeFilter", { op: "executed" }), /Start a code filter first/);
  await assert.rejects(call("codeFilter", { op: "bogus" }), /Invalid op: bogus/);
  const start = await call("codeFilter", { op: "start" });
  assert.equal(start.count, 17);
  assert.deepEqual(start.rows.map(r => r.func), Array.from({ length: 17 }, (_, i) => i + 2));
  x.getHealth();
  await tick(ctx);
  const idle = await call("codeFilter", { op: "notExecuted" });
  assert.equal(idle.count, 16);
  assert.ok(!idle.rows.some(r => r.name === "getHealth"));
  x.damage(1);
  assert.deepEqual(plain(await call("codeFilter", { op: "executed" })), { count: 1, rows: [{ func: 4, name: "damage", calls: 1 }] });
  x.damage(1);
  x.damage(2);
  assert.deepEqual((await call("codeFilter", { op: "executed" })).rows.map(r => [r.name, r.calls]), [["damage", 3]]);
  assert.equal((await call("codeFilter", { op: "executed" })).count, 0);
  assert.deepEqual(plain(await call("codeFilter", { op: "reset" })), { count: 0, rows: [] });
  await call("codeFilter", { op: "start" });
  x.callMagic();
  assert.deepEqual(new Set((await call("codeFilter", { op: "executed" })).rows.map(r => r.name)), new Set(["magic", "callMagic"]));
  const fb = await call("function", { index: 4 });
  assert.match(disassemble(fb.bytes).text, /^global\.get (\d+)\ni32\.const 1\ni32\.add\nglobal\.set \1\n/);
  const off = await runtime();
  assert.equal((await off.call("state")).options.coverage, false);
  await assert.rejects(off.call("codeFilter", { op: "start" }), /Coverage is off/);
  assert.doesNotMatch(disassemble((await off.call("function", { index: 4 })).bytes).text, /i32\.add\nglobal\.set/);
  const { meta } = instr({ coverage: true }), g = meta.cov.find(c => c.func === 4);
  const patched = instr({ coverage: true, patches: [{ index: 4, bytes: [...fb.bytes] }] });
  patched.x.damage(1);
  assert.equal(patched.x[g.field].value, 1);
  const bare = instr({ patches: [{ index: 4, bytes: [...fb.bytes] }] });
  const ref = instr().x;
  [bare.x, ref].forEach(y => y.damage(1));
  assert.equal(bare.x.getHealth(), ref.getHealth());
});

test("nop builds stack-neutral replacements that validate", () => {
  const VT = { i32: 0x7F, i64: 0x7E, f32: 0x7D, f64: 0x7C, v128: 0x7B, funcref: 0x70, externref: 0x6F };
  const sec = (id, b) => [id, ...L.leb.u32(b.length), ...b], ok = [];
  const mod = (params, results, body) => {
    const code = [0, ...assemble(`${params.map((_, i) => `local.get ${i}\n`).join("")}${body}\nend`)];
    const type = [1, 0x60, params.length, ...params.map(t => VT[t]), results.length, ...results.map(t => VT[t])];
    const head = [0, 0x61, 0x73, 0x6D, 1, 0, 0, 0];
    return Uint8Array.from([...head, ...sec(1, type), ...sec(3, [1, 0]), ...sec(5, [1, 0, 1]), ...sec(10, [1, ...L.leb.u32(code.length), ...code])]);
  };
  assert.equal(L.nop("i32.store offset=256"), "drop\ndrop");
  assert.equal(L.nop("i32.load"), "drop\ni32.const 0");
  assert.equal(L.nop("    i64.load8_s align=0 offset=4 ;; hp"), "    drop\n    i64.const 0");
  assert.equal(L.nop("get_local 0", { locals: ["f64"] }), "f64.const 0");
  assert.equal(L.nop("global.get 1", { globals: { 1: "(ref null 3)" } }), "ref.null 3");
  assert.equal(L.nop("nop"), "nop");
  const bad = [["br 0"], ["end"], ["if"], ["unreachable"], ["select"], ["local.get 1", { locals: ["i32"] }], ["call 5", { funcs: {} }],
    ["call 0", { funcs: { 0: { params: [], results: ["(ref 1)"] } } }], ["struct.new 0"], ["return_call 0"], ["bogus"], [""]];
  for (const [line, env] of bad) assert.equal(L.nop(line, env), null, line);
  const envs = { tee: { locals: ["f32"] }, set: { locals: ["i32"] }, call: { funcs: { 0: { params: ["i32"], results: ["i64"] } } } };
  const cases = `i32.store align=2 offset=0|i32 i32|
    i64.load8_s align=0 offset=0|i32|i64
    f32.add|f32 f32|f32
    i32.wrap_i64|i64|i32
    f64.lt|f64 f64|i32
    i32.eqz|i32|i32
    i64.extend8_s|i64|i64
    i32.reinterpret_f32|f32|i32
    f64.const 1.5||f64
    i8x16.extract_lane_s 3|v128|i32
    f32x4.extract_lane 2|v128|f32
    f64x2.replace_lane 1|v128 f64|v128
    v128.bitselect|v128 v128 v128|v128
    i32x4.all_true|v128|i32
    v128.load32_lane align=2 offset=0 1|i32 v128|v128
    v128.store16_lane align=1 offset=0 0|i32 v128|
    i16x8.extmul_low_i8x16_s|v128 v128|v128
    f32x4.demote_f64x2_zero|v128|v128
    v128.andnot|v128 v128|v128
    i64x2.splat|i64|v128
    v128.load8_splat align=0 offset=0|i32|v128
    i32x4.relaxed_dot_i8x16_i7x16_add_s|v128 v128 v128|v128
    v128.const i32x4 1 2 3 4||v128
    memory.grow 0|i32|i32
    memory.fill 0|i32 i32 i32|
    memory.size 0||i32
    i64.atomic.rmw32.cmpxchg_u align=2 offset=0|i32 i64 i64|i64
    i32.atomic.rmw.add align=2 offset=0|i32 i32|i32
    i64.atomic.store16 align=1 offset=0|i32 i64|
    memory.atomic.notify align=2 offset=0|i32 i32|i32
    select i32|i32 i32 i32|i32
    ref.null func||funcref
    ref.is_null|externref|i32
    drop|f32|
    local.tee 0|f32|f32|tee
    local.set 0|i32||set
    call 0|i32|i64|call`.split("\n").map(l => l.trim().split("|"));
  for (const [line, params, results, env] of cases) {
    const [ps, rs] = [params, results].map(x => x.split(" ").filter(Boolean)), rep = L.nop(line, envs[env]);
    assert.ok(rep, line);
    assert.ok(WebAssembly.validate(mod(ps, rs, line)), `original ${line}`);
    assert.ok(WebAssembly.validate(mod(ps, rs, rep)), `${line} -> ${rep}`);
    ok.push(line);
  }
  assert.equal(ok.length, cases.length);
});

test("function response lists access sites with the store opcode of precise sites", async () => {
  for (const precise of [false, true]) {
    const body = { instrumentOptions: { precise } };
    const cfg = c => c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body }) }));
    const { call, x } = await runtime(cfg), f = await call("function", { index: 4 }), d = disassemble(f.bytes).lines;
    const at = o => d[d.findIndex(l => l.offset === o) + 1]?.text;
    assert.ok(f.sites.every(([o]) => f.bytes[o] === 0x10));
    const kinds = f.sites.map(([o, op]) => op ?? at(o).split(" ")[0]);
    assert.deepEqual(plain(kinds), precise ? ["i32.load", 0x36] : ["i32.load"]);
    const [[o]] = f.sites;
    assert.deepEqual(plain((await call("accesses", { func: 4, offset: f.bodyOffset + o, enabled: true })).accesses[0]),
      { func: 4, offset: f.bodyOffset + o, addresses: [] });
    x.damage(1);
    await new Promise(r => setTimeout(r, 300));
    assert.deepEqual(plain((await call("state")).accesses[0].addresses), [{ address: GAME.HEALTH, count: 1 }]);
    assert.deepEqual(plain((await call("function", { index: 4, original: true })).sites), []);
  }
});

test("nop patches the damage store in plain and precise instrumentation", async () => {
  for (const precise of [false, true]) {
    const body = { instrumentOptions: { precise } };
    const cfg = c => c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body }) }));
    const { call } = await runtime(cfg), f = await call("function", { index: 4 }), lines = disassemble(f.bytes).text.split("\n");
    assert.deepEqual(plain(f.env.locals), ["i32"]);
    const st = l => (s => s?.params.length === 4 && !s.results.length)(f.env.funcs[l.split(" ")[1]]);
    const i = lines.findIndex(l => precise ? /^call /.test(l) && st(l) : /^i32\.store /.test(l));
    assert.ok(i > 0);
    const rep = L.nop(lines[i], f.env);
    assert.equal(rep, precise ? "drop\ndrop\ndrop\ndrop" : "drop\ndrop");
    const bytes = [...assemble([...lines.slice(0, i), rep, ...lines.slice(i + 1)].join("\n"))];
    const { x } = instr({ precise, patches: [{ index: 4, bytes }] });
    x.damage(30);
    assert.equal(x.getHealth(), 100);
    x.setHealth(50);
    assert.equal(x.getHealth(), 50);
  }
  const { call } = await runtime(), g = await call("function", { index: 8, original: true });
  assert.deepEqual(plain(g.env), { locals: [], funcs: {}, types: {}, globals: {} });
});

test("runtime asks for the worker source once, only when needed, and parses it without decode", async () => {
  const ctx = loadPage(RUNTIME), types = [], out = d => ctx.dispatchEvent(new ctx.CustomEvent("cetusMsgOut", { detail: d }));
  ctx.addEventListener("cetusMsgIn", e => types.push(L.decode(e.detail).type));
  await ctx.WebAssembly.instantiate(buildGame());
  assert.deepEqual(types, ["needSource", "init"]);
  await ctx.WebAssembly.instantiate(buildGame());
  out(L.encode({ type: "config", body: {} }));
  assert.deepEqual(types, ["needSource", "init", "init", "needSource"]);
  const decode = ctx.cetusLib.decode;
  let decoded = 0;
  ctx.cetusLib.decode = d => (decoded++, decode(d));
  out(JSON.stringify({ type: "workerSource", body: { src: "{\"$big\":\"1\"}" } }));
  ctx.cetusLib.decode = decode;
  assert.equal(decoded, 0);
  out(L.encode({ type: "config", body: {} }));
  assert.deepEqual(types, ["needSource", "init", "init", "needSource"]);
  const w = loadPage(RUNTIME, { pre: "globalThis.cetusLib = { worker: \"t\", workerSrc: \"x\" }" }), wt = [];
  w.addEventListener("cetusMsgIn", e => wt.push(L.decode(e.detail).type));
  await w.WebAssembly.instantiate(buildGame());
  assert.deepEqual(wt, []);
});

test("runtime registers instances and reads and writes memory", async () => {
  const { events, call, x } = await runtime();
  assert.deepEqual(events.map(e => e.type), ["needSource", "init"]);
  const st = await call("state");
  assert.equal(st.instances.length, 1);
  assert.deepEqual([st.instances[0].instrumented, st.active, st.scan, st.speed, st.instances[0].memoryBytes], [true, st.instances[0].id, null, 1, 65536]);
  assert.deepEqual(await call("read", { address: GAME.HEALTH, length: 4 }), { address: GAME.HEALTH, bytes: [100, 0, 0, 0], size: 65536 });
  assert.deepEqual((await call("read", { address: 65534, length: 10 })).bytes.length, 2);
  await call("write", { address: GAME.HEALTH, type: "i16", value: "-1" });
  assert.deepEqual((await call("read", { address: GAME.HEALTH, length: 4 })).bytes, [0xFF, 0xFF, 0, 0]);
  assert.equal(x.getHealth(), 0xFFFF);
  const { values } = await call("readValues", { items: [{ address: GAME.SCORE, type: "i64" }, { address: GAME.NAME_UTF16, type: "utf16", length: 8 },
    { address: 65535, type: "i32" }, { address: GAME.SIG, type: "aob", length: 3 }, { address: GAME.SPEED, type: "f32" }] });
  assert.deepEqual(values, [1234567890123n, "Hero", null, "DE AD BE", 1.5]);
  await assert.rejects(call("read", { address: "256", length: 4 }), /Invalid address/);
  await assert.rejects(call("write", { address: 65535, type: "i32", value: "1" }), /Address out of range/);
  x.memory.grow(1);
  assert.deepEqual(await call("read", { address: 65536, length: 2 }), { address: 65536, bytes: [0, 0], size: 131072 });
});

test("find searches forward and writeBytes is one undo step", async () => {
  const { call, x } = await runtime();
  assert.deepEqual(await call("find", { from: 0, type: "aob", value: "DE AD ?? EF" }), { address: GAME.SIG });
  assert.deepEqual(await call("find", { from: GAME.SIG + 1, type: "aob", value: "DE AD ?? EF" }), { address: null });
  assert.deepEqual(await call("find", { from: 0, type: "ascii", value: "PLAYER" }), { address: GAME.NAME_ASCII });
  assert.deepEqual(await call("find", { from: 0, type: "utf16", value: "Hero" }), { address: GAME.NAME_UTF16 });
  assert.deepEqual(await call("find", { from: 0, type: "f32", value: "1.5" }), { address: GAME.SPEED });
  assert.deepEqual(await call("find", { from: 0xFFFF0, type: "u8", value: "0" }), { address: null });
  await assert.rejects(call("find", { from: 0, type: "ascii", value: "" }), /Missing value/);
  await assert.rejects(call("find", { from: -1, type: "u8", value: "1" }), /Invalid address/);
  await call("writeBytes", { address: GAME.HEALTH, bytes: Array(8).fill(0xAB) });
  assert.deepEqual((await call("read", { address: GAME.HEALTH, length: 8 })).bytes, Array(8).fill(0xAB));
  assert.equal((await call("state")).undo, 1);
  assert.deepEqual(await call("undo"), { undone: { kind: "write", address: GAME.HEALTH } });
  assert.equal(x.getHealth(), 100);
  assert.equal(new DataView(x.memory.buffer).getUint32(GAME.GOLD, true), 500);
  await assert.rejects(call("writeBytes", { address: GAME.HEALTH, bytes: [256] }), /Invalid bytes/);
  await assert.rejects(call("writeBytes", { address: GAME.HEALTH, bytes: [] }), /Invalid bytes/);
  await assert.rejects(call("writeBytes", { address: 0, bytes: new Array(2 ** 20 + 1).fill(0) }), /Invalid bytes/);
  await assert.rejects(call("writeBytes", { address: 65535, bytes: [1, 2] }), /Address out of range/);
});

test("snapshots restore memory and globals and load writes bytes", async () => {
  const { call, x } = await runtime();
  const row = { name: "s", instance: 1, memory: 0, bytes: x.memory.buffer.byteLength, globals: 3 };
  assert.deepEqual(await call("snapshot", { op: "save", name: " s " }), { snapshots: [row] });
  x.damage(30);
  await call("setGlobal", { name: "lives", value: "9" });
  assert.deepEqual([x.getHealth(), x.getLives()], [70, 9]);
  await call("watch", { address: GAME.HEALTH, size: 4, kind: "write", enabled: true });
  assert.deepEqual(await call("snapshot", { op: "restore", name: "s" }), { snapshots: [row] });
  assert.deepEqual([x.getHealth(), x.getLives(), x.level.value], [100, 3, 3]);
  x.sameStore();
  assert.deepEqual((await call("state")).hits, []);
  assert.deepEqual((await call("state")).snapshots, [row]);
  for (const n of ["a", "b", "c", "d"]) await call("snapshot", { op: "save", name: n });
  assert.deepEqual((await call("snapshot", { op: "list" })).snapshots.map(r => r.name), ["a", "b", "c", "d"]);
  assert.deepEqual((await call("snapshot", { op: "delete", name: "b" })).snapshots.map(r => r.name), ["a", "c", "d"]);
  await assert.rejects(call("snapshot", { op: "restore", name: "s" }), /Unknown snapshot: s/);
  await assert.rejects(call("snapshot", { op: "save", name: " " }), /Missing name/);
  await assert.rejects(call("snapshot", { op: "nope", name: "a" }), /Invalid op/);
  assert.deepEqual(await call("load", { address: GAME.HEALTH, bytes: [0x2A, 0, 0, 0] }), {});
  assert.equal(x.getHealth(), 42);
  await call("load", { address: GAME.HEALTH, bytes: Buffer.from([7, 0, 0, 0]).toString("base64") });
  assert.equal(x.getHealth(), 7);
  assert.equal((await call("state")).undo, 1);
  await assert.rejects(call("load", { address: GAME.HEALTH, bytes: [] }), /Invalid bytes/);
  await assert.rejects(call("load", { address: GAME.HEALTH, bytes: "!!" }), /Invalid bytes/);
  await assert.rejects(call("load", { address: x.memory.buffer.byteLength - 2, bytes: [1, 2, 3] }), /Address out of range/);
});

test("runtime scan envelopes correlate ids and report errors", async () => {
  const { send, call } = await runtime();
  const [a, b] = await Promise.all([send("scan", { type: "i32", compare: "eq", value: "100", aligned: true }, "a"), send("scan", { type: "nope", compare: "eq" }, "b")]);
  assert.equal(a.id, "a");
  assert.ok(a.ok && a.body.rows.some(r => r.address === GAME.HEALTH));
  assert.deepEqual([b.id, b.ok, b.error], ["b", false, "Invalid type: nope"]);
  await call("write", { address: GAME.HEALTH, type: "i32", value: "90" });
  assert.deepEqual(await call("scan", { type: "i32", compare: "eq", value: "90", aligned: true }), { count: 1, rows: [{ address: GAME.HEALTH, value: 90, previous: 90 }], worker: false });
  assert.deepEqual((await call("state")).scan, { count: 1, type: "i32", saved: [] });
  assert.deepEqual(await call("scanReset"), {});
  assert.equal((await call("state")).scan, null);
  assert.equal((await call("scan", { type: "i32", compare: "unknown", aligned: true })).count, 16384);
  assert.equal((await send("nope", {})).error, "Unknown request: nope");
  assert.deepEqual((await call("strings", { encoding: "utf16", minLength: 4, upper: 0x1000 })).rows, [{ address: GAME.NAME_UTF16, text: "Hero" }]);
});

test("runtime freezes values each frame", async () => {
  const { ctx, call, x } = await runtime();
  await call("freeze", { address: GAME.HEALTH, type: "i32", value: "100", enabled: true });
  x.damage(10);
  assert.equal(x.getHealth(), 90);
  await tick(ctx);
  assert.equal(x.getHealth(), 100);
  await call("freeze", { address: GAME.GOLD, type: "u32", value: "777", enabled: true });
  const { freezes } = await call("freeze", { address: GAME.SCORE, type: "i64", value: "5", enabled: true });
  assert.deepEqual(freezes, [{ address: GAME.HEALTH, type: "i32", value: 100 }, { address: GAME.GOLD, type: "u32", value: 777 }, { address: GAME.SCORE, type: "i64", value: 5n }]);
  x.damage(3);
  x.addGold(3);
  new DataView(x.memory.buffer).setBigInt64(GAME.SCORE, 9n, true);
  await tick(ctx);
  assert.deepEqual([x.getHealth(), x.readGold(), new DataView(x.memory.buffer).getBigInt64(GAME.SCORE, true)], [100, 777, 5n]);
  await call("freeze", { address: GAME.GOLD, type: "u32", enabled: false });
  x.addGold(1);
  x.damage(1);
  await new Promise(r => setTimeout(r, 70));
  assert.deepEqual([x.getHealth(), x.readGold()], [100, 778]);
  await assert.rejects(call("freeze", { address: GAME.HEALTH, type: "ascii", value: "x", enabled: true }), /numeric/);
  for (const address of [GAME.HEALTH, GAME.SCORE]) await call("freeze", { address, type: "i32", enabled: false });
  assert.deepEqual((await call("state")).freezes, []);
});

test("runtime watches aggregate hits per instruction", async () => {
  const { events, call, x } = await runtime();
  await call("watch", { address: GAME.HEALTH, size: 4, kind: "write", enabled: true });
  for (let i = 0; i < 3; i++) x.damage(1);
  let { hits } = await call("state");
  assert.equal(hits.length, 1);
  assert.deepEqual([hits[0].slot, hits[0].kind, hits[0].func, hits[0].count], [0, "write", 4, 3]);
  const dmg = await call("function", { index: 4 });
  assert.ok(hits[0].offset >= dmg.bodyOffset && hits[0].offset < dmg.bodyOffset + dmg.bytes.length);
  await call("freeze", { address: GAME.HEALTH, type: "i32", value: "50", enabled: true });
  await call("write", { address: GAME.HEALTH, type: "i32", value: "60" });
  await call("freeze", { address: GAME.HEALTH, type: "i32", enabled: false });
  assert.equal((await call("state")).hits[0].count, 3);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(events.filter(e => e.type === "hits").length, 1);
  await call("watch", { address: GAME.GOLD, size: 4, kind: "read", enabled: true });
  await call("watch", { address: GAME.SCORE, size: 8, kind: "write", enabled: true });
  const { watches } = await call("watch", { address: GAME.NEG, size: 2, kind: "write", enabled: true });
  assert.deepEqual(watches.map(w => w.slot), [0, 1, 2, 3]);
  await assert.rejects(call("watch", { address: 0, size: 4, kind: "write", enabled: true }), /All 4 watch slots are in use/);
  assert.deepEqual((await call("watch", { address: GAME.HEALTH, size: 4, kind: "write", enabled: false })).watches.map(w => w.slot), [1, 2, 3]);
  assert.deepEqual((await call("state")).hits, []);
  x.damage(1);
  x.readGold();
  assert.deepEqual((await call("state")).hits.map(h => [h.slot, h.kind]), [[1, "read"]]);
  await assert.rejects(call("watch", { address: GAME.HEALTH, size: 3, kind: "write", enabled: true }), /Invalid size/);
});

test("runtime surfaces patch callback errors as warnings", async () => {
  let { call, events } = await runtime(undefined, { processor: ["throw new Error('boom')"], preinstantiate: [] });
  let [i] = (await call("state")).instances;
  assert.deepEqual([i.instrumented, i.error, i.warnings], [true, null, ["boom"]]);
  assert.deepEqual(events.find(e => e.type === "init").body.instance.warnings, ["boom"]);
  ({ call } = await runtime(undefined, { processor: ["throw new Error('boom')", "processor.write = () => { throw new Error('bad'); }"], preinstantiate: ["throw new Error('pre')"] }));
  [i] = (await call("state")).instances;
  assert.deepEqual([i.instrumented, i.error, i.warnings], [false, "bad", ["boom", "pre"]]);
  ({ call } = await runtime(c => { const r = c.cetusLib.register; let n = 0; c.cetusLib.register = a => n++ ? r(a) : (() => { throw new Error("reg"); })(); }));
  [i] = (await call("state")).instances;
  assert.deepEqual([i.instrumented, i.error, i.warnings], [false, "Registration failed: reg", []]);
  ({ call } = await runtime());
  assert.deepEqual((await call("state")).instances[0].warnings, []);
});

test("runtime watch needs an instrumented instance", async () => {
  const { call, x } = await runtime(c => { c.cetusLib.instrument = () => { throw new Error("off"); }; });
  assert.equal((await call("state")).instances[0].instrumented, false);
  await assert.rejects(call("watch", { address: GAME.HEALTH, size: 4, kind: "write", enabled: true }), /not instrumented/);
  assert.deepEqual((await call("globals")).globals.map(g => [g.name, g.type, g.mutable, g.value]),
    [["lives", "i32", true, null], ["level", "i32", true, 3], ["ratio", "f32", true, 100], ["vec", "v128", true, null], ["global4", "funcref", false, null], ["gravity", "f64", false, 9.5]]);
  await call("setGlobal", { name: "level", value: "7" });
  assert.equal((await call("globals")).globals[1].value, 7);
  await call("setGlobal", { name: "ratio", value: "2.5" });
  assert.equal(x.ratio.value, 2.5);
  await assert.rejects(call("setGlobal", { name: "lives", value: "1" }), /not accessible/);
  await assert.rejects(call("freeze", { global: "vec", value: "1", enabled: true }), /numeric/);
});

test("runtime globals, functions and bodies", async () => {
  const { call, x } = await runtime();
  const { globals } = await call("globals");
  assert.deepEqual(globals, [{ name: "lives", index: 0, type: "i32", mutable: true, value: 3 }, { name: "level", index: 1, type: "i32", mutable: true, value: 3 },
    { name: "ratio", index: 2, type: "f32", mutable: true, value: 100 }, { name: "vec", index: 3, type: "v128", mutable: true, value: "01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 10" },
    { name: "global4", index: 4, type: "funcref", mutable: false, value: "func secretBonus" }, { name: "gravity", index: 5, type: "f64", mutable: false, value: 9.5 }]);
  await call("setGlobal", { name: "vec", value: "ff 00 00 00 00 00 00 00 00 00 00 00 00 00 00 80" });
  assert.equal((await call("globals")).globals[3].value, "FF 00 00 00 00 00 00 00 00 00 00 00 00 00 00 80");
  await assert.rejects(call("setGlobal", { name: "vec", value: "ff ??" }), /16 hex bytes/);
  await call("undo");
  assert.equal((await call("globals")).globals[3].value.slice(0, 5), "01 02");
  await assert.rejects(call("setGlobal", { name: "gravity", value: "1" }), /immutable/);
  await call("setGlobal", { name: "__cetus_g0", value: "9" });
  assert.equal(x.getLives(), 9);
  await call("setGlobal", { name: "lives", value: "4" });
  assert.equal(x.getLives(), 4);
  await call("setGlobal", { name: "level", value: "0x10" });
  assert.equal(x.level.value, 16);
  await assert.rejects(call("setGlobal", { name: "nope", value: "1" }), /Unknown global/);
  const f = await call("function", { index: 8 });
  assert.equal(disassemble(f.bytes).text, "i32.const 240\ni32.extend8_s\nend");
  assert.ok(f.bodyOffset > 8);
  await assert.rejects(call("function", { index: 1 }), /imported/);
  await assert.rejects(call("function", { index: 99 }), /out of range/);
});

test("runtime immutable globals and body offsets match the running module", async () => {
  let reg;
  const { call } = await runtime(c => { const r = c.cetusLib.register; c.cetusLib.register = o => (reg = o, r(o)); });
  const f = await call("function", { index: 8 });
  assert.deepEqual([...reg.bytes.subarray(f.bodyOffset, f.bodyOffset + f.bytes.length)], f.bytes);
  const ctx = loadPage(RUNTIME);
  ctx.dispatchEvent(new ctx.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: {} }) }));
  const g = new ctx.WebAssembly.Global({ value: "i32", mutable: false }, 4);
  ctx.cetusLib.register({ instance: { exports: { g, memory: new WebAssembly.Memory({ initial: 1 }) } }, memory: new WebAssembly.Memory({ initial: 1 }), instrumented: false, error: "x", meta: null });
  assert.deepEqual(plain((await ctx.cetusLib.handle("globals", {})).globals), [{ name: "g", index: null, type: "i32", mutable: false, value: 4 }]);
  await assert.rejects(ctx.cetusLib.handle("setGlobal", { name: "g", value: "1" }), /Global is immutable/);
});

test("runtime speed keeps one monotonic virtual clock", async () => {
  let t = 1000;
  const { ctx, call } = await runtime(c => { c.performance = { now: () => t }; });
  const p = ctx.performance;
  assert.equal(p.now(), 1000);
  assert.deepEqual(await call("speed", { multiplier: 2 }), { speed: 2 });
  const now = () => vm.runInContext("Date.now()", ctx), a = p.now(), d = now();
  t += 100;
  assert.equal(p.now() - a, 200);
  assert.equal(now() - d, 200);
  t += 50;
  await call("speed", { multiplier: 1 });
  const b = p.now();
  assert.equal(b, a + 300);
  t += 10;
  assert.equal(p.now(), b + 10);
  await call("speed", { multiplier: 4 });
  const start = Date.now();
  await new Promise(r => ctx.setTimeout(r, 200));
  assert.ok(Date.now() - start < 150);
  assert.equal(typeof await tick(ctx), "number");
  await assert.rejects(call("speed", { multiplier: 17 }), /Invalid multiplier/);
  await assert.rejects(call("speed", { multiplier: "2" }), /Invalid multiplier/);
});

test("speed 0 pauses the clock, rAF and timers and resumes without going backwards", async () => {
  const { ctx, call, events } = await runtime(c => { c.performance = { now: () => performance.now() }; }), p = ctx.performance, got = [], wait = ms => new Promise(r => setTimeout(r, ms));
  const now = () => vm.runInContext("Date.now()", ctx);
  await call("speed", { multiplier: 3 });
  assert.deepEqual(await call("speed", { multiplier: 0 }), { speed: 0 });
  const a = p.now(), d = now();
  ctx.requestAnimationFrame(t => got.push(["raf", t]));
  const gone = ctx.requestAnimationFrame(() => got.push(["gone"]));
  ctx.cancelAnimationFrame(gone);
  ctx.setTimeout(v => got.push(["timeout", v]), 5, 7);
  const iv = ctx.setInterval(() => got.push(["interval"]), 5), dropped = ctx.setTimeout(() => got.push(["dropped"]), 1);
  await wait(60);
  ctx.clearTimeout(dropped);
  assert.deepEqual([p.now(), now(), got], [a, d, []]);
  assert.deepEqual(await call("command", { name: "toggle-pause" }), { speed: 3, freezes: [], freezesSuspended: false });
  await wait(60);
  ctx.clearInterval(iv);
  const raf = got.find(g => g[0] === "raf");
  assert.ok(raf[1] >= a && raf[1] < a + 1000, String(raf[1] - a));
  assert.ok(p.now() >= a && now() >= d);
  assert.deepEqual(got.filter(g => g[0] !== "raf" && g[0] !== "interval"), [["timeout", 7]]);
  assert.ok(got.filter(g => g[0] === "interval").length >= 1);
  assert.equal(got.filter(g => g[0] === "raf").length, 1);
  assert.equal((await call("command", { name: "toggle-pause" })).speed, 0);
  assert.equal((await call("command", { name: "toggle-speedhack" })).speed, 1);
  assert.equal((await call("command", { name: "toggle-speedhack" })).speed, 3);
  assert.deepEqual(events.filter(e => e.type === "command").map(e => [e.body.name, e.body.speed]), [["toggle-pause", 3], ["toggle-pause", 0], ["toggle-speedhack", 1], ["toggle-speedhack", 3]]);
  await call("hotkeys", { bindings: [{ combo: "Alt+P", action: "togglePause" }] });
  ctx.dispatchEvent(Object.assign(new ctx.Event("keydown"), { code: "KeyP", key: "p", altKey: true }));
  assert.equal((await call("state")).speed, 0);
  ctx.dispatchEvent(Object.assign(new ctx.Event("keydown"), { code: "KeyP", key: "p", altKey: true }));
  assert.equal((await call("state")).speed, 3);
  const parse = ctx.cetusLib.parseValue, during = [];
  const busy = () => { const e = Date.now() + 20; while (Date.now() < e); };
  ctx.cetusLib.parseValue = (...x) => (during.push(p.now()), busy(), during.push(p.now()), parse(...x));
  assert.ok((await call("scan", { type: "i32", compare: "eq", value: "100", aligned: true, pause: true })).count >= 1);
  assert.equal(during[0], during[1]);
  during.length = 0;
  await call("scan", { type: "i32", compare: "eq", value: "100", aligned: true });
  assert.ok(during[1] - during[0] >= 50);
  ctx.cetusLib.parseValue = parse;
  assert.equal((await call("state")).speed, 3);
  await assert.rejects(call("scan", { type: "i32", compare: "eq", value: "1", aligned: true, pause: "yes" }), /Invalid pause/);
  await call("speed", { multiplier: 1 });
});

test("speed reschedules every timer, pauses and resumes them and virtualizes Date", async () => {
  const { ctx, call } = await runtime(c => { c.performance = { now: () => performance.now() }; });
  const wait = ms => new Promise(r => setTimeout(r, ms)), n = { a: 0, b: 0 }, got = [], date = () => vm.runInContext("new Date().getTime()", ctx);
  const count = async (k, ms) => { const s = n[k]; await wait(ms); return n[k] - s; };
  const a = ctx.setInterval(() => n.a++, 20);
  const base = await count("a", 400);
  await call("speed", { multiplier: 4 });
  const fast = await count("a", 400);
  assert.ok(fast > base * 2.8 && fast < base * 5.5, `${base} ${fast}`);
  const b = ctx.setInterval(() => n.b++, 20);
  assert.ok(await count("b", 200) > base, "interval created at x4 runs fast");
  await call("speed", { multiplier: 1 });
  const slow = await count("b", 400);
  assert.ok(slow > base * 0.6 && slow < base * 1.5, `${base} ${slow}`);
  ctx.clearInterval(b);
  ctx.setTimeout(v => got.push(v), 30, "t");
  await call("speed", { multiplier: 0 });
  const d0 = date();
  assert.deepEqual([await count("a", 150), got, date()], [0, [], d0]);
  await call("speed", { multiplier: 1 });
  await wait(80);
  assert.deepEqual(got, ["t"]);
  assert.ok(n.a > 0 && await count("b", 100) === 0);
  ctx.clearInterval(a);
  await call("speed", { multiplier: 2 });
  assert.equal(await count("a", 100), 0);
  const d1 = date();
  await wait(100);
  assert.ok(date() - d1 >= 180, String(date() - d1));
  assert.deepEqual([...vm.runInContext("[new Date(5).getTime(), typeof Date(), new Date() instanceof Date, new Date().constructor === Date, "
    + "Math.abs(new (class extends Date {})().getTime() - Date.now()) < 5, Date.UTC(1970, 0, 1)]", ctx)], [5, "string", true, true, true, 0]);
  await call("speed", { multiplier: 1 });
});

test("workers ask for a sync on start and follow its speed, including pause", async () => {
  const pre = `globalThis.posted = []; globalThis.BroadcastChannel = class { constructor() { globalThis.chan = this; } postMessage(m) { posted.push(m); } };`;
  const w = loadPage(RUNTIME, { pre: `globalThis.cetusLib = { worker: "t" }; const n0 = Date.now; globalThis.performance = { now: () => n0() }; ${pre}` });
  const m = loadPage(RUNTIME, { pre: `globalThis.performance = { now: () => 0 }; ${pre}` });
  assert.equal(w.posted[0].t, "hi");
  await m.cetusLib.handle("speed", { multiplier: 0 });
  m.chan.onmessage({ data: { ...w.posted[0], tok: m.posted.at(-1).tok } });
  const sync = m.posted.at(-1);
  assert.deepEqual([sync.t, sync.sp], ["sync", 0]);
  w.chan.onmessage({ data: { ...sync, tok: "t" } });
  const t = w.performance.now(), ran = [];
  w.setTimeout(() => ran.push(1), 1);
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual([w.performance.now(), ran], [t, []]);
  w.chan.onmessage({ data: { ...sync, tok: "t", sp: 4, n: 9 } });
  await new Promise(r => setTimeout(r, 40));
  assert.ok(w.performance.now() - t >= 100 && ran.length === 1);
});

test("runtime answers 200 malformed bodies with ok:false", async () => {
  const { send, out, call } = await runtime();
  let seed = 7;
  const rnd = k => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % k, pick = a => a[rnd(a.length)];
  const junk = [null, "1", "x", -1, 2 ** 40, 20.5, {}, [], true, [null], { address: "1" }];
  const types = ["scan", "strings", "read", "readValues", "write", "freeze", "watch", "function", "setGlobal", "speed", "bogus"];
  const keys = ["type", "compare", "value", "address", "length", "items", "encoding", "minLength", "size", "kind", "index", "name", "multiplier", "enabled", "lower", "tolerance"];
  for (let i = 0; i < 200; i++) {
    const body = rnd(5) ? Object.fromEntries(Array.from({ length: rnd(6) }, () => [pick(keys), pick(junk)])) : pick(junk);
    const r = await send(pick(types), body);
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.equal(typeof r.error, "string");
  }
  out("not json");
  out(L.encode([1, 2]));
  out(L.encode({ type: "state" }));
  assert.equal((await call("state")).instances.length, 1);
});

test("C12.1 fixture additions validate and run", async () => {
  for (const o of [{}, { importMemory: true }, { importMemory: true, shared: true }]) assert.ok(WebAssembly.validate(buildGame(o)), JSON.stringify(o));
  const { instance: { exports: x } } = await WebAssembly.instantiate(buildGame()), dv = new DataView(x.memory.buffer);
  assert.equal(x.mix(1, 2n, 3, 4), 10);
  assert.deepEqual([x.tbl.get(0)(), x.tbl.get(1)(5), x.callMagic()], [-16, 1005, -16]);
  x.simdSet(7);
  assert.deepEqual([0, 4, 8, 12].map(o => dv.getInt32(GAME.SIMD + o, true)), [7, 7, 7, 7]);
  x.sameStore();
  assert.equal(x.getHealth(), 100);
  assert.deepEqual([dv.getUint32(GAME.PTR, true), dv.getInt32(GAME.HERO_HP, true)], [GAME.HERO, 250]);
  assert.equal(new Uint8Array((await WebAssembly.instantiate(buildSecond())).instance.exports.memory.buffer)[0x100], 0x2a);
});

test("instrument keeps behavior in precise, trace and coverage modes over 100 seeded call sequences", () => {
  let seed = 13;
  const rnd = n => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n, game = buildGame(), ma = new WebAssembly.Module(game);
  const calls = [x => x.getHealth(), x => x.damage(rnd(200) - 100), x => x.addGold(rnd(1000)), x => x.readGold(), x => x.sameStore(), x => x.simdSet(rnd(2 ** 31)),
    x => x.mix(rnd(100), BigInt(rnd(100)), rnd(1e4) / 8, rnd(1e6) / 3), x => x.tbl.get(1)(rnd(1e5)), x => x.callMagic(), x => x.setHealth(rnd(2 ** 31))];
  const every = Array.from({ length: 14 }, (_, i) => i + 2);
  for (const opts of [{}, { precise: true, trace: every }, { coverage: true }, { coverage: true, precise: true, trace: every, globalWatch: [1] }]) {
    const { meta } = instr(opts), mb = new WebAssembly.Module(meta.bytes), probes = [];
    const imports = { __cetus: { read: (...a) => probes.push(a), write: (...a) => probes.push(a) } };
    for (let i = 0; i < 100; i++) {
      const a = new WebAssembly.Instance(ma).exports, b = new WebAssembly.Instance(mb, imports).exports;
      const made = [0, 0];
      for (let n = rnd(30) + 1; n--;) {
        const c = rnd(calls.length), s = seed, want = calls[c](a);
        seed = s;
        assert.deepEqual(calls[c](b), want);
        c < 2 && made[c]++;
      }
      assert.ok(Buffer.from(a.memory.buffer).equals(Buffer.from(b.memory.buffer)));
      const cov = f => b[meta.cov.find(c => c.func === f)?.field]?.value;
      assert.deepEqual([cov(2), cov(4)], opts.coverage ? made : [undefined, undefined]);
    }
    assert.equal(probes.some(p => p[0] >= -1), false);
    assert.equal(probes.length > 0, !!opts.trace);
  }
});

test("precise stores report same-value writes and v128 stores hit watches", () => {
  for (const precise of [true, false]) {
    const { x, hits } = instr({ precise });
    x.__cetus_watch(0, GAME.HEALTH, 4, 5);
    x.sameStore();
    x.sameStore();
    assert.deepEqual(hitList(hits), precise ? [[0, "write"], [0, "write"]] : []);
    x.__cetus_watch(0, GAME.SIMD + 4, 4, precise ? 4 : 1);
    x.simdSet(7);
    assert.deepEqual(hitList(hits), [[0, "write"]]);
    x.__cetus_watch(1, GAME.SIMD + 8, 4, 2);
    x.simdSet(7);
    assert.deepEqual(hitList(hits), precise ? [[0, "write"]] : []);
  }
});

test("instrument meta: sites, names, types, table slots and data ranges", () => {
  const { meta, x } = instr(), log = [];
  const y = new WebAssembly.Instance(new WebAssembly.Module(meta.bytes), { __cetus: { read: (...a) => log.push(a), write: (...a) => log.push(a) } }).exports;
  assert.ok(meta.sites.every(s => meta.bytes[s.offset] === 0x10));
  const site = meta.sites.findIndex(s => s.func === 6);
  y.__cetus_arm(0, site);
  y.readGold();
  y.getHealth();
  assert.deepEqual(log.splice(0), [[-1, GAME.GOLD, site]]);
  y.__cetus_arm(0, -1);
  y.readGold();
  assert.deepEqual(log, []);
  assert.equal(meta.names.functions[4], "damage");
  assert.ok(Object.values(meta.names.functions).includes("secretBonus"));
  assert.deepEqual([meta.names.globals[0], meta.names.globals[1]], ["lives", "level"]);
  assert.deepEqual(plain(meta.types[12]), { params: ["i32", "i64", "f32", "f64"], results: ["f64"] });
  assert.deepEqual(plain(meta.tableSlots), [{ table: "tbl", slot: 0, func: 8 }, { table: "tbl", slot: 1, func: 15 }]);
  assert.ok(meta.dataRanges.some(([a, b]) => a <= GAME.PTR && GAME.PTR + 4 <= b));
  assert.ok(meta.original instanceof Uint8Array && meta.original.length === buildGame().length);
  assert.equal(x.readGold(), 500);
});

test("runtime traces, accesses, select and hashes", async () => {
  const { call, x, ctx } = await runtime(c => c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: { instrumentOptions: { trace: [4] } } }) })));
  x.damage(3);
  const { calls } = await call("traces");
  assert.deepEqual(calls, [{ func: 4, name: "damage", count: 1, lastArgs: [3] }]);
  await call("watch", { address: GAME.GOLD, size: 4, kind: "read", enabled: true });
  x.readGold();
  const [h] = (await call("state")).hits;
  assert.equal(h.name, "readGold");
  await assert.rejects(call("accesses", { func: 4, offset: 1, enabled: true }), /not traceable/);
  await call("accesses", { func: h.func, offset: h.offset, enabled: true });
  x.readGold();
  x.readGold();
  assert.deepEqual((await call("state")).accesses, [{ func: 6, offset: h.offset, addresses: [{ address: GAME.GOLD, count: 2 }] }]);
  assert.deepEqual((await call("accesses", { func: h.func, offset: h.offset, enabled: false })).accesses, []);
  const st = await call("state");
  assert.match(st.instances[0].hash, /^[0-9a-f]{64}$/);
  assert.deepEqual([st.instances[0].worker, st.instances[0].shared, st.options],
    [false, false, { precise: false, trace: [4], globalWatch: [], coverage: false, breakpoints: [], stepTrace: [] }]);
  await ctx.WebAssembly.instantiate(buildSecond());
  const [a, b] = (await call("state")).instances;
  assert.equal((await call("state")).active, a.id);
  assert.deepEqual(await call("select", { id: b.id }), { active: b.id });
  assert.deepEqual((await call("read", { address: 0x100, length: 1 })).bytes, [0x2a]);
  await assert.rejects(call("select", { id: 99 }), /Unknown instance/);
});

test("freezes, watch slots and access sites stay on the instance active when set", async () => {
  const { call, x, ctx } = await runtime();
  x.memory.grow(1);
  const y = (await ctx.WebAssembly.instantiate(buildGame())).instance.exports, hp = e => new DataView(e.memory.buffer).getInt32(GAME.HEALTH, true);
  const [a, b] = (await call("state")).instances, HP = { address: GAME.HEALTH, type: "i32" }, W = { address: GAME.HEALTH, size: 4, kind: "write" };
  assert.equal((await call("state")).active, a.id);
  await call("freeze", { ...HP, value: "100", enabled: true });
  await call("freeze", { global: "level", value: "8", enabled: true });
  await call("select", { id: b.id });
  assert.deepEqual((await call("state")).freezes, []);
  assert.deepEqual(plain((await call("freeze", { global: "level", value: "9", enabled: true })).freezes), [{ global: "level", type: "i32", value: 9 }]);
  await call("write", { ...HP, value: "5" });
  x.damage(30);
  await tick(ctx);
  assert.deepEqual([hp(y), hp(x), x.level.value, y.level.value], [5, 100, 8, 9]);
  await call("select", { id: a.id });
  assert.deepEqual(plain((await call("state")).freezes), [{ ...HP, value: 100 }, { global: "level", type: "i32", value: 8 }]);
  await call("freeze", { ...HP, enabled: false });
  const r = await call("watch", { ...W, enabled: true });
  assert.equal("i" in r.watches[0], false);
  await call("select", { id: b.id });
  await call("write", { ...HP, value: "7" });
  y.damage(1);
  assert.deepEqual((await call("state")).hits, []);
  x.damage(1);
  assert.equal((await call("state")).hits.length, 1);
  await call("watch", { ...W, enabled: false });
  x.damage(1);
  assert.deepEqual((await call("state")).hits, []);
  await call("select", { id: a.id });
  await call("watch", { address: GAME.GOLD, size: 4, kind: "read", enabled: true });
  x.readGold();
  const [h] = (await call("state")).hits, site = { func: h.func, offset: h.offset };
  await call("watch", { address: GAME.GOLD, size: 4, kind: "read", enabled: false });
  await call("accesses", { ...site, enabled: true });
  x.readGold();
  assert.deepEqual((await call("state")).accesses[0].addresses, [{ address: GAME.GOLD, count: 1 }]);
  await call("select", { id: b.id });
  await call("accesses", { ...site, enabled: true });
  x.readGold();
  assert.deepEqual((await call("state")).accesses[0].addresses, []);
  y.readGold();
  assert.deepEqual((await call("state")).accesses[0].addresses, [{ address: GAME.GOLD, count: 1 }]);
  await call("freeze", { global: "level", enabled: false });
  await call("select", { id: a.id });
  assert.deepEqual((await call("freeze", { global: "level", enabled: false })).freezes, []);
});

test("scan extended compares, bases, rounding and text folds", async () => {
  const { dv, scan } = await scanMemory();
  assert.ok((scan.first(S("i32", "between", 90, { value2: 110 })), addrs(scan)).includes(GAME.HEALTH));
  scan.first(S("u32", "unknown"));
  dv().setUint32(GAME.GOLD, 505, true);
  assert.deepEqual(scan.next(S("u32", "incBy", 5)), { count: 1 });
  dv().setUint32(GAME.GOLD, 500, true);
  scan.first(S("u32", "eq", 500));
  dv().setUint32(GAME.GOLD, 560, true);
  assert.deepEqual((scan.next(S("u32", "incPct", 10)), addrs(scan)), [GAME.GOLD]);
  dv().setUint32(GAME.GOLD, 570, true);
  assert.equal(scan.next(S("u32", "incPct", 10)).count, 0);
  scan.first(S("i32", "eq", 100));
  dv().setInt32(GAME.HEALTH, 95, true);
  scan.next(S("i32", "decreased"));
  dv().setInt32(GAME.HEALTH, 97, true);
  assert.deepEqual((scan.next(S("i32", "decreased", null, { base: "first" })), addrs(scan)), [GAME.HEALTH]);
  assert.equal(scan.next(S("i32", "decreased")).count, 0);
  dv().setInt32(GAME.HEALTH, 100, true);
  const not = (scan.first(S("i32", "eq", 100, { not: true, upper: 0x1000 })), addrs(scan));
  assert.ok(!not.includes(GAME.HEALTH) && not.includes(GAME.GOLD));
  dv().setFloat32(GAME.SPEED, 57.2999, true);
  assert.ok((scan.first(S("f32", "eq", "57.29", { rounding: "truncated", decimals: 2 })), addrs(scan)).includes(GAME.SPEED));
  assert.equal(scan.first(S("f32", "eq", "57.29", { upper: 0x1000 })).count, 0);
  assert.deepEqual((scan.first({ type: "ascii", compare: "eq", value: "player_one", caseSensitive: false }), addrs(scan)), [GAME.NAME_ASCII]);
  assert.equal(scan.first({ type: "ascii", compare: "eq", value: "player_one" }).count, 0);
  assert.deepEqual((scan.first({ type: "utf16", compare: "eq", value: "hERO", caseSensitive: false }), addrs(scan)), [GAME.NAME_UTF16]);
  scan.first({ type: "all", compare: "eq", value: "100", aligned: true, upper: 0x1000 });
  const rows = scan.rows(1e9), types = new Set(rows.map(r => r.type));
  assert.ok(rows.some(r => r.address === GAME.HEALTH && r.type === "i32" && r.value === 100) && types.size > 1 && types.has("f32") === false);
  assert.throws(() => scan.first({ type: "all", compare: "unknown", aligned: true }), /Invalid comparison/);
  assert.deepEqual((scan.first({ type: "binary", compare: "eq", value: "11011110 ????1101" }), addrs(scan)), [GAME.SIG]);
  assert.equal(scan.rows()[0].value, "11011110 10101101");
  assert.equal(scan.rows()[0].previous, "11011110 ????1101");
  assert.deepEqual([...L.parseBits("1??0000 1").mask], [0x9F]);
  assert.throws(() => L.parseBits("1101"), /multiple of 8/);
  assert.throws(() => L.parseBits("1101001x"), /Invalid bit/);
  assert.deepEqual([...L.toBytes("00000001 11111111", "binary")], [1, 255]);
});

test("scan undo history and paging", async () => {
  const { dv, scan } = await scanMemory();
  const counts = [scan.first(S("i32", "unknown")).count];
  for (let i = 0; i < 3; i++) {
    dv().setInt32(GAME.HEALTH, 1000 + i, true);
    counts.push(scan.next(S("i32", i ? "unchanged" : "changed")).count);
  }
  assert.deepEqual(counts.slice(1), [1, 0, 0]);
  for (const c of counts.slice(0, 3).reverse()) assert.equal(scan.undo().count, c);
  assert.throws(() => scan.undo(), /Nothing to undo/);
  assert.equal(scan.rows(1, 5)[0].address, 5 * 4);
  for (let i = 0; i < 7; i++) scan.next(S("i32", "unchanged"));
  assert.equal(scan.history.length, 5);
  const { call, x } = await runtime();
  new Uint8Array(x.memory.buffer).fill(0x77, 0x8000, 0x8000 + 1000);
  assert.equal((await call("scan", { type: "u8", compare: "eq", value: "0x77", aligned: true, lower: 0x8000 })).count, 1000);
  const page = await call("scanRows", { offset: 100, limit: 100 });
  assert.deepEqual(page.rows.map(r => r.address), Array.from({ length: 100 }, (_, i) => 0x8000 + 100 + i));
  assert.equal(page.count, 1000);
  await call("scan", { type: "u8", compare: "unchanged", aligned: true });
  assert.equal((await call("state")).scanDepth, 1);
  assert.deepEqual(await call("scanUndo"), { count: 1000, depth: 0 });
  await assert.rejects(call("scanUndo"), /Nothing to undo/);
  await assert.rejects(call("scanRows", { offset: 0, limit: 501 }), /Invalid limit/);
  const s1 = await call("strings", { encoding: "ascii", minLength: 1 }), s2 = await call("strings", { encoding: "ascii", minLength: 1, offset: 2 });
  assert.deepEqual(s2.rows[0], s1.rows[2]);
  assert.equal(s2.count, s1.count);
});

test("saved scans compare against the value saved at the same address", async () => {
  const { call, x } = await runtime(), addrs = r => r.rows.map(r => r.address), U = { type: "i32", aligned: true };
  await assert.rejects(call("scanSave", { name: "a" }), /No scan to save/);
  await call("scan", { ...U, compare: "unknown" });
  assert.deepEqual(await call("scanSave", { name: "a" }), { saved: ["a"] });
  x.damage(10);
  assert.deepEqual(await call("scanSave", { name: "b" }), { saved: ["a", "b"] });
  x.setHealth(100);
  assert.deepEqual(addrs(await call("scan", { ...U, compare: "incBy", value: "10", base: "saved:b" })), [GAME.HEALTH]);
  await call("scanUndo");
  assert.ok((await call("scan", { ...U, compare: "unchanged", base: "saved:a" })).count > 1);
  assert.deepEqual(addrs(await call("scan", { ...U, compare: "changed", base: "saved:b" })), [GAME.HEALTH]);
  assert.deepEqual((await call("state")).scan.saved, ["a", "b"]);
  await call("scanSave", { name: "c" });
  await call("scanUndo");
  await call("scanUndo");
  x.setHealth(7);
  assert.deepEqual(addrs(await call("scan", { ...U, compare: "decreased", base: "saved:c" })), [GAME.HEALTH]);
  await call("scanUndo");
  assert.deepEqual(addrs(await call("scan", { ...U, compare: "changed", not: true, base: "saved:c" })), []);
  await call("scanUndo");
  assert.deepEqual(addrs(await call("scan", { ...U, compare: "eq", value: "90", base: "saved:b" })), []);
  await call("scanUndo");
  await assert.rejects(call("scan", { ...U, compare: "changed", base: "saved:zz" }), /Unknown saved scan: zz/);
  await assert.rejects(call("scanSave", { name: " " }), /Missing name/);
  assert.deepEqual(await call("scanSave", { name: "a" }), { saved: ["b", "c", "a"] });
  assert.deepEqual(await call("scanSave", { name: "d" }), { saved: ["c", "a", "d"] });
  await call("scanReset");
  await call("scan", { type: "all", compare: "eq", value: "7", aligned: true, upper: 0x200 });
  await call("scanSave", { name: "all" });
  x.setHealth(8);
  const inc = (await call("scan", { type: "all", compare: "incBy", value: "1", aligned: true, base: "saved:all" })).rows;
  assert.ok(inc.some(r => r.address === GAME.HEALTH && r.type === "i32") && inc.every(r => r.value === 8 || r.value === 8n));
  const { scan } = await scanMemory();
  scan.first({ type: "i32", compare: "unknown", aligned: true });
  scan.saveAs("big");
  assert.ok(scan.saved.get("big").snap.byteLength > 0);
  for (let i = 0; i < 5; i++) scan.next({ type: "i32", compare: "unchanged", base: "saved:big" });
  assert.equal(scan.history.length, 5);
  scan.saved.get("big").snap = new Uint8Array(64 * 2 ** 20 - scan.history.slice(1).reduce((n, h) => n + h.addrs.byteLength + h.prev.byteLength + h.firsts.byteLength, 0));
  scan.trim();
  assert.equal(scan.history.length, 4);
  const huge = new L.Scan(() => new ArrayBuffer(65 * 2 ** 20));
  huge.first({ type: "u8", compare: "unknown" });
  assert.throws(() => huge.saveAs("x"), /exceeds 64 MiB/);
});

test("parseGroup offsets, aliases, wildcards and errors", () => {
  assert.deepEqual(L.parseGroup("4:100 4:500 f:1.5").map(e => e.offset), [0, 4, 8]);
  assert.deepEqual(L.parseGroup("4:100 4:500 f:1.5").map(({ type, value }) => [type, value]), [["i32", 100], ["i32", 500], ["f32", 1.5]]);
  assert.deepEqual(L.parseGroup("1:255 2:* 8:-1@0x10 u16:7 d:2.25 ascii:hi aob:DE??").map(({ offset, type, value, size }) => [offset, type, value, size]),
    [[0, "i8", -1, 1], [1, "i16", null, 2], [16, "i64", -1n, 8], [24, "u16", 7, 2], [26, "f64", 2.25, 8], [34, "ascii", "hi", 2], [36, "aob", "DE ??", 2]]);
  assert.equal(L.parseGroup("f:1.5")[0].tolerance, 0.05);
  assert.equal(L.parseGroup("4:0xFFFFFFFF")[0].value, -1);
  for (const [t, re] of [[" ", /Empty group/], ["x:1", /Invalid group element/], ["4", /Invalid group element/], ["ascii:*", /Wildcard needs a numeric type/], ["aob:ABC", /Invalid byte/], ["4:abc", /Invalid integer/], ["u8:300", /out of range/], ["1:300", /out of range/]])
    assert.throws(() => L.parseGroup(t), re);
});

test("group scan matches whole blocks and rescans them", async () => {
  const { memory, dv, scan } = await scanMemory();
  const G = (compare, value, extra) => ({ type: "group", compare, value, ...extra });
  assert.deepEqual((scan.first(G("eq", "4:100 4:500 f:1.5")), addrs(scan)), [GAME.HEALTH]);
  assert.deepEqual(scan.rows(), [{ address: GAME.HEALTH, value: "i32:100 i32:500 f32:1.5", previous: "i32:100 i32:500 f32:1.5", group: "4:100 4:500 f:1.5",
    elements: [{ offset: 0, type: "i32", size: 4 }, { offset: 4, type: "i32", size: 4 }, { offset: 8, type: "f32", size: 4 }] }]);
  assert.deepEqual((scan.first(G("eq", "4:* 4:500 f:1.5", { aligned: true })), addrs(scan)), [GAME.HEALTH]);
  assert.deepEqual((scan.first(G("eq", "i32:100 f:1.5@8")), addrs(scan)), [GAME.HEALTH]);
  assert.equal(scan.rows()[0].value, "i32:100 f32:1.5@8");
  dv().setFloat32(GAME.SPEED, 1.52, true);
  assert.deepEqual((scan.first(G("eq", "4:100 4:* f:1.5")), addrs(scan)), [GAME.HEALTH]);
  assert.equal(scan.first(G("eq", "4:100 4:* f:1.5", { tolerance: 0.001 })).count, 0);
  assert.equal(scan.first(G("eq", "4:100 4:* f:1.50")).count, 0);
  dv().setFloat32(GAME.SPEED, 1.5, true);
  assert.deepEqual((scan.first(G("eq", "2:* 1:* 1:* 4:500")), addrs(scan)), [GAME.HEALTH]);
  assert.deepEqual((scan.first(G("eq", "ascii:PLAYER aob:5F4F")), addrs(scan)), [GAME.NAME_ASCII]);
  assert.equal(scan.rows()[0].value, "ascii:PLAYER aob:5F4F");
  assert.ok(!(scan.first(G("eq", "4:100 4:500", { not: true, upper: 0x200 })), addrs(scan)).includes(GAME.HEALTH));
  scan.first(G("eq", "4:* 4:500"));
  const total = scan.count;
  assert.ok(total >= 1);
  dv().setInt32(GAME.HEALTH, 90, true);
  assert.deepEqual(scan.next(G("changed")), { count: 1 });
  assert.deepEqual(scan.rows()[0], { address: GAME.HEALTH, value: "i32:90 i32:500", previous: "i32:90 i32:500", group: "4:* 4:500", elements: [{ offset: 0, type: "i32", size: 4 }, { offset: 4, type: "i32", size: 4 }] });
  scan.undo();
  assert.equal(scan.next(G("unchanged")).count, total - 1);
  scan.undo();
  assert.deepEqual(scan.next(G("changed", undefined, { base: "first" })), { count: 1 });
  scan.saveAs("g");
  dv().setUint32(GAME.GOLD, 501, true);
  assert.deepEqual(scan.next(G("eq", "4:90 4:501 f:*")), { count: 1 });
  assert.equal(scan.rows()[0].value, "i32:90 i32:501 f32:1.5");
  assert.equal(scan.rows()[0].previous, "i32:90 i32:501 f32:1.5");
  assert.deepEqual(scan.next(G("changed", undefined, { base: "saved:g" })), { count: 1 });
  assert.equal(scan.next(G("unchanged")).count, 1);
  assert.equal(scan.next(G("eq", "4:1")).count, 0);
  assert.throws(() => scan.next(G("eq")), /Missing search value/);
  assert.throws(() => scan.next(G("increased")), /Invalid comparison/);
  assert.throws(() => scan.first(G("changed")), /Invalid comparison/);
  assert.throws(() => scan.first(G("eq", "4:1 zz")), /Invalid group element/);
  scan.first({ type: "i32", compare: "eq", value: 90 });
  scan.saveAs("n");
  scan.first(G("eq", "4:90"));
  assert.throws(() => scan.next(G("unchanged", undefined, { base: "saved:n" })), /Saved scan type differs/);
  const u8 = new Uint8Array(memory.buffer);
  u8.set([1, 0, 0, 0, 2], u8.length - 5);
  assert.deepEqual((scan.first(G("eq", "4:1 1:2", { lower: u8.length - 64 })), addrs(scan)), [u8.length - 5]);
});

test("runtime group scans through the scan request", async () => {
  const { call, x } = await runtime();
  const r = await call("scan", { type: "group", compare: "eq", value: "4:100 4:500 f:1.5", aligned: true });
  assert.deepEqual([r.count, r.rows[0].address, r.rows[0].value], [1, GAME.HEALTH, "i32:100 i32:500 f32:1.5"]);
  assert.equal((await call("state")).scan.type, "group");
  x.damage(10);
  assert.equal((await call("scan", { type: "group", compare: "eq", value: "4:90 4:500 f:1.5" })).count, 1);
  assert.equal((await call("scan", { type: "group", compare: "unchanged" })).count, 1);
  assert.deepEqual((await call("readValues", { items: [{ address: GAME.HEALTH, type: "group", group: "4:* 4:*" }, { address: 2 ** 30, type: "group", group: "4:1" }] })).values, ["i32:90 i32:500", null]);
  assert.deepEqual((await call("readValues", { items: [{ address: 0, type: "group", group: "q" }] })).values, [null]);
  await assert.rejects(call("scan", { type: "group", compare: "eq", value: 5 }), /must be a string/);
});

test("scan worker runs the self-contained Scan source with identical rows", async () => {
  const { resolveObjectURL } = await import("node:buffer");
  class FakeWorker {
    constructor(url) {
      this.ready = resolveObjectURL(url).text().then(src => {
        this.g = vm.createContext({ TextDecoder, postMessage: d => setTimeout(() => this.onmessage({ data: structuredClone(d) })) });
        vm.runInContext(`globalThis.self = globalThis;\n${src}`, this.g);
      });
    }
    postMessage(d) { this.ready.then(() => this.g.onmessage({ data: structuredClone(d) })); }
    terminate() {}
  }
  const ctx = loadPage([]), waits = new Map();
  Object.assign(ctx, { Worker: FakeWorker, Blob });
  for (const f of RUNTIME) vm.runInContext(readFileSync(f, "utf8"), ctx);
  ctx.addEventListener("cetusMsgIn", e => { const m = L.decode(e.detail); m.id != null && waits.get(m.id)(m); });
  let n = 0;
  const call = (type, body) => new Promise(r => { waits.set(++n, m => r(m.ok ? m.body : m.error)); ctx.dispatchEvent(new ctx.CustomEvent("cetusMsgOut", { detail: L.encode({ id: n, type, body }) })); });
  await ctx.WebAssembly.instantiate(buildGame());
  const body = { type: "all", compare: "eq", value: "100", aligned: true, upper: 0x1000 };
  const w = await call("scan", { ...body, worker: true }), s = (await call("scanReset", {}), await call("scan", body));
  assert.deepEqual([w.worker, s.worker], [true, false]);
  assert.deepEqual(w.rows, s.rows);
  assert.equal((await call("scan", { type: "all", compare: "unchanged", aligned: true, worker: true })).worker, true);
  assert.deepEqual(await call("scanUndo", {}), { count: s.count, depth: 0 });
  await call("scanSave", { name: "s" });
  const ws = await call("scan", { type: "all", compare: "unchanged", aligned: true, worker: true, base: "saved:s" });
  assert.deepEqual([ws.worker, ws.count], [true, s.count]);
  await call("scanUndo", {});
  assert.equal(await call("scan", { type: "all", compare: "between", value: "1", aligned: true, worker: true }), "Missing search value");
});

test("freeze modes, global freezes and undo", async () => {
  const { ctx, call, x } = await runtime();
  await call("freeze", { address: GAME.HEALTH, type: "i32", value: "100", enabled: true, mode: "noDecrease" });
  x.damage(10);
  await tick(ctx);
  assert.equal(x.getHealth(), 100);
  x.setHealth(150);
  await tick(ctx);
  x.damage(5);
  await tick(ctx);
  assert.equal(x.getHealth(), 150);
  assert.deepEqual((await call("state")).freezes, [{ address: GAME.HEALTH, type: "i32", value: 150, mode: "noDecrease" }]);
  await call("freeze", { address: GAME.HEALTH, type: "i32", enabled: false });
  const { freezes } = await call("freeze", { address: GAME.GOLD, type: "u32", value: "500", enabled: true, mode: "step", step: "1" });
  assert.deepEqual(freezes, [{ address: GAME.GOLD, type: "u32", value: 501, mode: "step", step: 1 }]);
  const g0 = x.readGold();
  await tick(ctx);
  await tick(ctx);
  assert.ok(x.readGold() >= g0 + 2);
  await call("freeze", { address: GAME.GOLD, type: "u32", enabled: false });
  await assert.rejects(call("freeze", { address: GAME.GOLD, type: "u32", value: "1", enabled: true, mode: "bogus" }), /Invalid mode/);

  await call("freeze", { global: "lives", value: "9", enabled: true });
  await call("setGlobal", { name: "__cetus_g0", value: "2" });
  await tick(ctx);
  assert.equal(x.getLives(), 9);
  assert.deepEqual((await call("freeze", { global: "lives", enabled: false })).freezes, []);

  await call("write", { address: GAME.HEALTH, type: "i32", value: "7" });
  await call("setGlobal", { name: "level", value: "5" });
  assert.equal((await call("state")).undo, 3);
  assert.deepEqual(await call("undo"), { undone: { kind: "global", name: "level" } });
  assert.equal(x.level.value, 3);
  assert.deepEqual(await call("undo"), { undone: { kind: "write", address: GAME.HEALTH } });
  assert.equal(x.getHealth(), 150);
  await call("undo");
  assert.equal(x.getLives(), 9);
  assert.deepEqual(await call("undo"), { undone: null });
});

test("readValues yields null per failing item and keeps the batch checks", async () => {
  const { call } = await runtime();
  const items = [{ address: 0x100, type: "i32" }, { address: 0, type: "ascii", length: 5000 }, { address: 0, type: "i32", memory: 7 }];
  assert.deepEqual((await call("readValues", { items })).values, [100, null, null]);
  assert.deepEqual((await call("readValues", { items: [null, { address: 0, type: "bogus" }, { address: -1, type: "i32" }] })).values, [null, null, null]);
  await assert.rejects(call("readValues", { items: Array(501).fill(items[0]) }), /Invalid items/);
  await assert.rejects(call("readValues", { items: "x" }), /Invalid items/);
});

test("config table arms one watch slot per persisted kind", async () => {
  const table = [{ description: "", address: GAME.HEALTH, type: "i32", watch: ["write", "read"] }, { description: "", address: GAME.GOLD, type: "u32", watch: "read" },
    { description: "", address: GAME.SCORE, type: "i64", watch: [] }];
  const { call } = await runtime(c => c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: { table, hotkeys: [] } }) })));
  const ws = (await call("state")).watches.map(w => [w.address, w.kind]).sort();
  assert.deepEqual(ws, [[GAME.HEALTH, "read"], [GAME.HEALTH, "write"], [GAME.GOLD, "read"]].sort());
});

test("config table applies freezes and watches on register", async () => {
  const table = [{ description: "", address: GAME.HEALTH, type: "i32", frozen: true, freezeValue: "100" }, { description: "", address: GAME.GOLD, type: "u32", watch: "write" }];
  const { ctx, call, x } = await runtime(c => c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: { table, hotkeys: [] } }) })));
  const st = await call("state");
  assert.deepEqual([st.freezes, st.watches.map(w => [w.address, w.kind])], [[{ address: GAME.HEALTH, type: "i32", value: 100 }], [[GAME.GOLD, "write"]]]);
  x.damage(30);
  x.addGold(1);
  await tick(ctx);
  assert.equal(x.getHealth(), 100);
  assert.equal((await call("state")).hits.length, 1);
  await call("freeze", { address: GAME.HEALTH, type: "i32", enabled: false });
});

const fakeDom = c => {
  class N extends c.EventTarget {
    constructor(tag) { super(); Object.assign(this, { tagName: tag.toUpperCase(), children: [], style: {}, textContent: "", classList: new Set() }); this.classList.remove = this.classList.delete; this.classList.toggle = (k, on) => on ? this.classList.add(k) : this.classList.delete(k); }
    append(...k) { this.children.push(...k.filter(x => x !== "")); }
    attachShadow(o) { return this.shadow = Object.assign(new N("#root"), o); }
    get all() { return [this, ...this.children.flatMap(n => n.all ?? [])]; }
  }
  c.document = { documentElement: new N("html"), createElement: t => new N(t) };
};

test("trainer config builds a closed shadow panel whose rows freeze and hide", async () => {
  const trainer = { title: "T", entries: [{ description: "HEALTH", address: GAME.HEALTH, type: "i32", hotkeys: ["Alt+H"] }, { description: "GOLD", address: GAME.GOLD, type: "u32", group: "g" }],
    scripts: [{ name: "heal", code: "cetus.write(" + GAME.HEALTH + ", 'i32', 55)", hotkeys: ["Alt+T"] }] };
  const hotkeys = [{ combo: "Alt+H", action: "set", entry: { pointer: { base: { kind: "static", address: GAME.PTR }, offsets: [1e9] }, type: "i32" }, value: "1" },
    { combo: "Alt+D", action: "nextScan", compare: "decreased" }];
  const { ctx, call, x } = await runtime(c => (fakeDom(c), c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: { trainer, hotkeys } }) }))));
  const [host] = ctx.document.documentElement.children, all = host.shadow.all;
  assert.equal(host.shadow.mode, "closed");
  assert.equal(host.style.display, "block");
  const row = d => all.find(n => n.className === "r" && n.children[0].textContent === d);
  const [, live, freeze] = row("HEALTH").children;
  assert.deepEqual([live.textContent, row("HEALTH").children.at(-1).textContent, all.some(n => n.className === "g" && n.textContent === "g")], ["100", "Alt+H", true]);
  assert.ok(!all.some(n => n.className === "g" && n.textContent === "Keys"));
  freeze.checked = true;
  freeze.onchange();
  x.damage(30);
  await tick(ctx);
  assert.equal(x.getHealth(), 100);
  const inp = row("HEALTH").children[3];
  inp.value = "80";
  inp.onchange();
  x.damage(5);
  await tick(ctx);
  assert.deepEqual([x.getHealth(), (await call("state")).freezes], [80, [{ address: GAME.HEALTH, type: "i32", value: 80 }]]);
  freeze.checked = false;
  freeze.onchange();
  const run = row("heal").children[1];
  run.checked = true;
  run.onchange();
  assert.deepEqual([x.getHealth(), (await call("state")).freezes, (await call("state")).scripts[0].running], [55, [], true]);
  run.checked = false;
  run.onchange();
  ctx.dispatchEvent(Object.assign(new ctx.Event("keydown"), { altKey: true, code: "KeyH" }));
  assert.deepEqual([row("HEALTH").title, row("HEALTH").classList.has("e"), row("heal").title ?? ""], ["Hotkey Alt+H: Pointer does not resolve", true, ""]);
  const key = Object.assign(new ctx.Event("keydown"), { ctrlKey: true, shiftKey: true, code: "KeyT" });
  ctx.dispatchEvent(key);
  assert.equal(host.style.display, "none");
});

test("config without trainer creates no panel", async () => {
  const { ctx } = await runtime(c => (fakeDom(c), c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: { table: [] } }) }))));
  assert.deepEqual(ctx.document.documentElement.children, []);
});

test("config globals re-apply global freezes, preferring the current module hash", async () => {
  const hash = createHash("sha256").update(buildGame()).digest("hex");
  const globals = [{ global: "level", value: "7", hash: "old" }, { global: "level", value: "5", hash }, { global: "lives", value: "8", hash: "old" }, { global: "nope", value: "1", hash }];
  const { ctx, call, x } = await runtime(c => c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: { globals } }) })));
  const st = await call("state");
  assert.equal(st.instances[0].hash, hash);
  assert.deepEqual(st.freezes, [{ global: "level", type: "i32", value: 5 }, { global: "lives", type: "i32", value: 8 }]);
  x.level.value = 30;
  await tick(ctx);
  assert.deepEqual([x.level.value, x.getLives()], [5, 8]);
  for (const global of ["level", "lives"]) await call("freeze", { global, enabled: false });
});

test("hotkeys toggle freezes outside inputs and commands toggle speed and freezes", async () => {
  const { ctx, call, events, x } = await runtime();
  await call("hotkeys", { bindings: [{ combo: "Ctrl+Shift+F", action: "toggleFreeze", entry: { address: GAME.HEALTH, type: "i32" } }, { combo: "Alt+I", action: "inc", entry: { address: GAME.GOLD, type: "u32" }, value: "5" }] });
  const key = (code, mods, target) => {
    const e = Object.assign(new ctx.Event("keydown"), { code, key: code.slice(-1), ...mods });
    if (target) Object.defineProperty(e, "target", { value: target });
    ctx.dispatchEvent(e);
  };
  key("KeyF", { ctrlKey: true, shiftKey: true }, { tagName: "INPUT" });
  assert.deepEqual((await call("state")).freezes, []);
  key("KeyF", { ctrlKey: true, shiftKey: true });
  assert.deepEqual((await call("state")).freezes, [{ address: GAME.HEALTH, type: "i32", value: 100 }]);
  x.damage(30);
  await tick(ctx);
  assert.equal(x.getHealth(), 100);
  key("KeyI", { altKey: true });
  assert.equal(x.readGold(), 505);
  key("KeyF", { ctrlKey: true, shiftKey: true });
  assert.deepEqual((await call("state")).freezes, []);
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(events.filter(e => e.type === "hotkey").map(e => e.body.action), ["toggleFreeze", "inc", "toggleFreeze"]);
  const chain = { base: { kind: "static", address: GAME.PTR }, offsets: [0x10] }, hp = () => new DataView(x.memory.buffer).getInt32(GAME.HERO_HP, true), hp0 = hp();
  await call("hotkeys", { bindings: [{ combo: "Alt+P", action: "inc", entry: { pointer: chain, type: "i32" }, value: "2" }, { combo: "Alt+Q", action: "toggleFreeze", entry: { pointer: chain, type: "i32" } }] });
  key("KeyP", { altKey: true });
  assert.equal(hp(), hp0 + 2);
  key("KeyQ", { altKey: true });
  assert.deepEqual((await call("state")).freezes, [{ pointer: chain, type: "i32", value: hp0 + 2 }]);
  key("KeyQ", { altKey: true });
  assert.deepEqual((await call("state")).freezes, []);
  assert.equal((await call("command", { name: "toggle-speedhack" })).speed, 2);
  assert.equal((await call("command", { name: "toggle-speedhack" })).speed, 1);
  await call("speed", { multiplier: 3 });
  await call("speed", { multiplier: 1 });
  assert.equal((await call("command", { name: "toggle-speedhack" })).speed, 3);
  await call("freeze", { address: GAME.HEALTH, type: "i32", value: "100", enabled: true });
  assert.equal((await call("command", { name: "toggle-freezes" })).freezesSuspended, true);
  x.damage(10);
  await tick(ctx);
  assert.equal(x.getHealth(), 90);
  await call("command", { name: "toggle-freezes" });
  await tick(ctx);
  assert.equal(x.getHealth(), 100);
  await assert.rejects(call("command", { name: "nope" }), /Unknown command/);
  assert.deepEqual(events.filter(e => e.type === "command").map(({ body: b }) => [b.name, b.speed, b.freezesSuspended]), [["toggle-speedhack", 2, false], ["toggle-speedhack", 1, false], ["toggle-speedhack", 3, false], ["toggle-freezes", 3, true], ["toggle-freezes", 3, false]]);
  await call("freeze", { address: GAME.HEALTH, type: "i32", enabled: false });
});

test("hotkeys set speed, freeze, unfreeze, toggle groups and toggle scripts", async () => {
  const code = 'cetus.onTick(() => cetus.write(0x104, "u32", 77))', hp = { address: GAME.HEALTH, type: "i32" }, gold = { address: GAME.GOLD, type: "u32" };
  const hotkeys = [{ combo: "Alt+S", action: "setSpeed", value: "3" }, { combo: "Alt+F", action: "freeze", entry: hp, value: "120" }, { combo: "Alt+U", action: "unfreeze", entry: hp },
    { combo: "Ctrl+Shift+G", action: "toggleGroup", group: "player", entries: [hp, gold] }, { combo: "Alt+T", action: "toggleScript", script: "gold" }, { combo: "Alt+N", action: "toggleScript", script: "nope" }];
  const { ctx, call, events, x } = await runtime(c => c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: { hotkeys, scripts: [], hotkeyScripts: [{ name: "gold", code, enabled: false }] } }) })));
  const key = (code, mods) => ctx.dispatchEvent(Object.assign(new ctx.Event("keydown"), { code, key: code.slice(-1), ...mods }));
  const last = () => events.filter(e => e.type === "hotkey").at(-1).body;
  key("KeyS", { altKey: true });
  assert.equal((await call("state")).speed, 3);
  assert.deepEqual(last(), { combo: "Alt+S", action: "setSpeed", speed: 3 });
  await call("speed", { multiplier: 1 });
  key("KeyF", { altKey: true });
  assert.deepEqual((await call("state")).freezes, [{ ...hp, value: 120 }]);
  key("KeyF", { altKey: true });
  assert.deepEqual((await call("state")).freezes, [{ ...hp, value: 120 }]);
  assert.deepEqual(last(), { combo: "Alt+F", action: "freeze", entry: hp, frozen: true, value: "120" });
  key("KeyU", { altKey: true });
  assert.deepEqual([(await call("state")).freezes, last().frozen, last().value], [[], false, null]);
  key("KeyG", { ctrlKey: true, shiftKey: true });
  assert.deepEqual((await call("state")).freezes, [{ ...hp, value: 120 }, { ...gold, value: 500 }]);
  assert.deepEqual(last().entries.map(e => [e.entry, e.frozen, e.value]), [[hp, true, "120"], [gold, true, "500"]]);
  x.damage(30);
  x.addGold(-1);
  await tick(ctx);
  assert.deepEqual([x.getHealth(), x.readGold()], [120, 500]);
  key("KeyG", { ctrlKey: true, shiftKey: true });
  assert.deepEqual([(await call("state")).freezes, last().entries.map(e => e.frozen)], [[], [false, false]]);
  key("KeyT", { altKey: true });
  assert.deepEqual([(await call("state")).scripts, last()], [[{ name: "gold", running: true, error: null }], { combo: "Alt+T", action: "toggleScript", script: "gold", enabled: true }]);
  await tick(ctx);
  assert.equal(x.readGold(), 77);
  key("KeyT", { altKey: true });
  assert.deepEqual([(await call("state")).scripts, last().enabled], [[], false]);
  x.addGold(1);
  await tick(ctx);
  assert.equal(x.readGold(), 78);
  const n = events.length;
  key("KeyN", { altKey: true });
  assert.deepEqual([events.length, last()], [n + 1, { combo: "Alt+N", action: "toggleScript", error: "Unknown script: nope" }]);
  await call("hotkeys", { bindings: [{ combo: "Alt+N", action: "toggleScript", script: "nope" }, { combo: "Alt+Z", action: "setSpeed", value: "20" }], scripts: [{ name: "nope", code: "cetus.write(0x104, \"u32\", 5)" }] });
  key("KeyN", { altKey: true });
  assert.deepEqual([x.readGold(), last().enabled], [5, true]);
  key("KeyZ", { altKey: true });
  assert.equal((await call("state")).speed, 1);
  await call("script", { name: "nope", enabled: false });
});

test("pointer scan, rescan and pointer items follow a relocation", async () => {
  const { ctx, call, x } = await runtime();
  const chain = { base: { kind: "static", address: GAME.PTR }, offsets: [0x10] }, has = r => r.rows.some(p => JSON.stringify(p) === JSON.stringify(chain));
  const r = await call("pointerScan", { address: GAME.HERO_HP, maxDepth: 2, maxOffset: 4096 });
  assert.ok(has(r) && r.count >= r.rows.length);
  assert.deepEqual(r.rows[0], chain);
  await assert.rejects(call("pointerScan", { address: GAME.HERO_HP, maxDepth: 9, maxOffset: 4096 }), /Invalid depth/);
  const relocate = () => { const u8 = new Uint8Array(x.memory.buffer); u8.copyWithin(0x2000, 0x1000, 0x1020); new DataView(u8.buffer).setUint32(GAME.PTR, 0x2000, true); };
  relocate();
  const s = await call("pointerRescan", { address: 0x2010 });
  assert.ok(has(s) && s.count < r.count);
  const bad = { base: { kind: "static", address: 0xFFF0 }, offsets: [0, 4] };
  assert.deepEqual((await call("readValues", { items: [{ pointer: chain, type: "i32" }, { pointer: bad, type: "i32" }, { pointer: { base: { kind: "global", name: "nope" }, offsets: [0] }, type: "i32" }] })).values, [250, null, null]);
  assert.deepEqual((await call("readValues", { items: [{ pointer: { base: {}, offsets: [] }, type: "i32" }] })).values, [null]);
  await call("write", { pointer: chain, type: "i32", value: "260" });
  await call("freeze", { pointer: chain, type: "i32", value: "300", enabled: true });
  await call("freeze", { pointer: bad, type: "i32", value: "1", enabled: true });
  new DataView(x.memory.buffer).setUint32(GAME.PTR, 0x1000, true);
  await tick(ctx);
  assert.equal(new DataView(x.memory.buffer).getInt32(GAME.HERO_HP, true), 300);
  relocate();
  new DataView(x.memory.buffer).setInt32(0x2010, 5, true);
  await tick(ctx);
  assert.equal(new DataView(x.memory.buffer).getInt32(0x2010, true), 300);
  assert.deepEqual((await call("state")).freezes, [{ pointer: chain, type: "i32", value: 300 }, { pointer: bad, type: "i32", value: 1 }]);
  for (const pointer of [chain, bad]) await call("freeze", { pointer, type: "i32", enabled: false });
  await assert.rejects(call("write", { pointer: bad, type: "i32", value: "1" }), /Pointer does not resolve/);
  await assert.rejects(call("dump", { what: "nope" }), /Invalid dump/);
});

test("pointer rescans take the UI's chains on a fresh instance and filter by value", async () => {
  const chain = { base: { kind: "static", address: GAME.PTR }, offsets: [0x10] }, has = r => r.rows.some(p => JSON.stringify(p) === JSON.stringify(chain));
  const { rows } = await (await runtime()).call("pointerScan", { address: GAME.HERO_HP, maxDepth: 2, maxOffset: 4096 });
  const { call, x } = await runtime();
  assert.deepEqual(await call("pointerRescan", { address: GAME.HERO_HP }), { count: 0, rows: [] });
  const s = await call("pointerRescan", { address: GAME.HERO_HP, pointers: rows });
  assert.ok(has(s) && s.count === s.rows.length && s.count <= rows.length);
  const v = await call("pointerRescan", { value: "250", type: "i32", pointers: rows });
  assert.ok(has(v) && (await call("readValues", { items: v.rows.map(pointer => ({ pointer, type: "i32" })) })).values.every(n => n === 250));
  assert.ok(has(await call("pointerRescan", { value: "250", type: "i32" })));
  new DataView(x.memory.buffer).setInt32(GAME.HERO_HP, 7, true);
  assert.ok(!has(await call("pointerRescan", { value: "250", type: "i32", pointers: rows })));
  assert.ok(has(await call("pointerRescan", { value: "7", type: "i32", pointers: rows })));
  await assert.rejects(call("pointerRescan", { value: "7", type: "ascii", pointers: rows }), /needs an address or a numeric type/);
  await assert.rejects(call("pointerRescan", { address: GAME.HERO_HP, pointers: {} }), /Invalid pointers/);
  await assert.rejects(call("pointerRescan", { address: GAME.HERO_HP, pointers: [{ base: {}, offsets: [] }] }), /Invalid pointer/);
});

test("pointer scan runs in the scan worker with the same chains", async () => {
  const { resolveObjectURL } = await import("node:buffer");
  let used = 0;
  class FakeWorker {
    constructor(url) {
      used++;
      this.ready = resolveObjectURL(url).text().then(src => {
        this.g = vm.createContext({ TextDecoder, postMessage: d => setTimeout(() => this.onmessage({ data: structuredClone(d) })) });
        vm.runInContext(`globalThis.self = globalThis;\n${src}`, this.g);
      });
    }
    postMessage(d) { this.ready.then(() => this.g.onmessage({ data: structuredClone(d) })); }
    terminate() {}
  }
  const body = { address: GAME.HERO_HP, maxDepth: 3, maxOffset: 256 };
  const plain = await (await runtime()).call("pointerScan", body);
  const ctx = loadPage([]), waits = new Map();
  Object.assign(ctx, { Worker: FakeWorker, Blob });
  for (const f of RUNTIME) vm.runInContext(readFileSync(f, "utf8"), ctx);
  ctx.addEventListener("cetusMsgIn", e => { const m = L.decode(e.detail); m.id != null && waits.get(m.id)(m.body); });
  await ctx.WebAssembly.instantiate(buildGame());
  const w = await new Promise(r => { waits.set(1, r); ctx.dispatchEvent(new ctx.CustomEvent("cetusMsgOut", { detail: L.encode({ id: 1, type: "pointerScan", body }) })); });
  assert.equal(used, 1);
  assert.deepEqual(w, plain);
  assert.deepEqual(plain.rows[0], { base: { kind: "static", address: GAME.PTR }, offsets: [0x10] });
});

test("pointer scans size their arrays by candidates and fail cleanly when the worker runs out of memory", async () => {
  const u8 = new Uint8Array(2 ** 26), K = loadPage(RUNTIME).cetusLib, t = performance.now();
  new DataView(u8.buffer).setUint32(0x300, 0x1000, true);
  const rows = K.pointers(u8, 0x1010, { maxDepth: 3, maxOffset: 4096, ranges: [[0x300, 0x304]], globals: [] });
  assert.ok(performance.now() - t < 500);
  assert.deepEqual(plain(rows), [{ base: { kind: "static", address: 0x300 }, offsets: [0x10] }]);
  assert.deepEqual([...K.cands(u8)], [0x1000n << 32n | 0x300n]);
  assert.equal(K.cands(u8).buffer.byteLength, 8);
  const sent = [];
  let mode = "post";
  class Dying {
    postMessage(d) {
      sent.push(d.buf);
      setTimeout(() => mode === "post" ? this.onmessage({ data: { error: "Array buffer allocation failed" } }) : this.onerror({ preventDefault() {} }));
    }
    terminate() {}
  }
  let scan;
  const reg = memory => {
    const ctx = loadPage([]);
    Object.assign(ctx, { Worker: Dying, Blob });
    for (const f of RUNTIME) vm.runInContext(readFileSync(f, "utf8"), ctx);
    ctx.dispatchEvent(new ctx.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: {} }) }));
    ctx.cetusLib.register({ instance: { exports: { memory } }, memory, instrumented: false, error: "x", meta: null });
    scan = () => ctx.cetusLib.handle("pointerScan", { address: 0x1010, maxDepth: 2, maxOffset: 16 });
  };
  const big = new WebAssembly.Memory({ initial: 4097, maximum: 4097, shared: true }), small = new WebAssembly.Memory({ initial: 1 });
  reg(big);
  await assert.rejects(scan(), { name: "RangeError", message: "Pointer scan failed: out of memory" });
  assert.equal(sent[0], big.buffer);
  mode = "error";
  await assert.rejects(scan(), /^RangeError: Pointer scan failed: out of memory$/);
  reg(small);
  mode = "post";
  await assert.rejects(scan(), /Array buffer allocation failed/);
  assert.equal(sent[2].byteLength, 65536);
  assert.notEqual(sent[2], small.buffer);
  mode = "error";
  assert.deepEqual((await scan()).count, 0);
});

test("module tools: functions, bodies, code search, calls and comments", async () => {
  const { call } = await runtime();
  const { functions } = await call("functions");
  const fn = n => plain(functions.find(f => f.name === n));
  const fnRow = (index, name, exported, results) =>
    ({ index, name, exported, imported: false, internal: !exported, params: ["i32"], results });
  assert.deepEqual(fn("damage"), fnRow(4, "damage", true, []));
  assert.deepEqual(fn("secretBonus"), fnRow(15, "secretBonus", false, ["i32"]));
  assert.deepEqual(fn("hiddenCalc"), fnRow(18, "hiddenCalc", false, ["i32"]));
  assert.ok(functions.every(f => f.index >= 2 && f.index <= 18) && !functions.some(f => /^__cetus_f/.test(f.name)));
  assert.deepEqual((await call("codeSearch", { aob: "41 F0 01 C0" })).rows.map(r => [r.func, r.name]), [[8, "magic"]]);
  assert.equal((await call("codeSearch", { aob: "41 ?? 01 C0", limit: 1 })).rows.length, 1);
  assert.deepEqual((await call("call", { index: 12, args: ["1", "2", "3", "4"] })).results, [10]);
  assert.deepEqual((await call("call", { index: 15, args: ["5"] })).results, [1005]);
  assert.deepEqual((await call("call", { index: 18, args: ["5"] })).results, [22]);
  assert.deepEqual((await call("call", { index: 3, args: ["42"] })).results, []);
  assert.deepEqual((await call("call", { index: 2, args: [] })).results, [42]);
  await assert.rejects(call("call", { index: 0, args: ["1", "2", "3"] }), /Function is not callable/);
  await assert.rejects(call("call", { index: 12, args: ["1"] }), /Expected 4 arguments/);
  const { bodies } = await call("functionBodies", { from: 0, count: 200 });
  assert.deepEqual(bodies.map(b => b.index), functions.map(f => f.index));
  assert.deepEqual(bodies[6], await call("function", { index: 8 }));
  assert.equal((await call("functionBodies", { from: 10, count: 2 })).bodies.length, 2);
  for (const count of [0, 201, "5"]) await assert.rejects(call("functionBodies", { from: 0, count }), /Invalid count/);
  await assert.rejects(call("dump", { what: "nope" }), /Invalid dump/);
  assert.deepEqual(assemble("i32.const 5 ;; five\n;; x\nend ;;"), assemble("i32.const 5\nend"));
  const pt = await runtime(c => c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: { patches: [{ index: 8, bytes: [0x41, 5, 0x0b] }] } }) })));
  assert.deepEqual((await pt.call("function", { index: 8 })).bytes, [0x41, 5, 0x0b]);
  assert.deepEqual((await pt.call("function", { index: 8, original: true })).bytes, [0x41, 0xF0, 0x01, 0xC0, 0x0B]);
  assert.equal(pt.x.magic(), 5);
  const u = await runtime(c => { c.cetusLib.instrument = () => { throw new Error("off"); }; });
  const f = (await u.call("functions")).functions;
  const mix = { index: 10, name: "mix", exported: true, imported: false, internal: false };
  Object.assign(mix, { params: ["i32", "i64", "f32", "f64"], results: ["f64"] });
  assert.deepEqual(plain(f.find(x => x.index === 10)), mix);
  assert.equal(f.length, 17);
  assert.ok(f.every(x => !x.internal));
  assert.deepEqual((await u.call("call", { index: 10, args: ["1", "2", "3", "4"] })).results, [10]);
  await assert.rejects(u.call("call", { index: 13, args: ["5"] }), /not callable/);
  await assert.rejects(u.call("call", { index: 16, args: ["5"] }), /not callable/);
  await assert.rejects(u.call("dump", { what: "instrumented" }), /not instrumented/);
});

test("scripts: ticks, hooks from config, call, pointer and errors", async () => {
  const cfg = scripts => c => c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: { scripts } }) }));
  const { ctx, call, events, x } = await runtime(cfg([{ name: "nodmg", code: 'cetus.hookExport("damage", { before: a => [0] })', enabled: true }]));
  x.damage(50);
  assert.equal(x.getHealth(), 100);
  await call("script", { name: "nodmg", enabled: false });
  const cached = x.damage;
  cached(10);
  assert.equal(x.getHealth(), 90);
  await call("script", { name: "half", code: 'cetus.hookExport("damage", { before: ([n]) => [n / 2], after: () => 7 })', enabled: true });
  assert.equal(cached(10), 7);
  assert.equal(x.getHealth(), 85);
  await call("script", { name: "half", enabled: false });
  const { scripts } = await call("script", { name: "hold", code: 'cetus.onTick(() => cetus.write(0x100, "i32", "100"))', enabled: true });
  assert.deepEqual(scripts, [{ name: "hold", running: true, error: null }]);
  x.damage(30);
  await tick(ctx);
  assert.equal(x.getHealth(), 100);
  assert.equal((await call("state")).undo, 0);
  await call("script", { name: "hold", enabled: false });
  x.damage(30);
  await tick(ctx);
  await tick(ctx);
  assert.equal(x.getHealth(), 70);
  await call("script", { name: "calc", code: 'cetus.log(cetus.call("mix", 1, 2n, 3, 4) === 10, cetus.pointer({ kind: "static", address: 0x300 }, [0x10]) === 0x1010, cetus.read(0x104, "u32")); return () => cetus.log("bye")', enabled: true });
  await call("script", { name: "calc", enabled: false });
  assert.deepEqual(events.filter(e => e.type === "scriptLog").map(e => e.body), [{ name: "calc", text: "true true 500" }, { name: "calc", text: "bye" }]);
  const r = await call("script", { name: "bad", code: "throw new Error('boom')", enabled: true });
  assert.deepEqual(r.scripts, [{ name: "bad", running: false, error: "boom" }]);
  assert.deepEqual(events.filter(e => e.type === "scriptError").map(e => e.body), [{ name: "bad", message: "boom" }]);
  await call("script", { name: "tickbad", code: "cetus.onTick(() => { throw new Error('tick') })", enabled: true });
  await tick(ctx);
  await tick(ctx);
  assert.equal(events.filter(e => e.type === "scriptError").length, 2);
  assert.equal((await call("read", { address: GAME.HEALTH, length: 4 })).bytes[0], 70);
  await call("script", { name: "lvl", code: 'cetus.freezeGlobal("level", 9)', enabled: true });
  x.level.value = 1;
  await tick(ctx);
  assert.equal(x.level.value, 9);
  await call("freeze", { global: "level", enabled: false });
});

test("scripts: in-page hotkeys run script callbacks", async () => {
  const { ctx, call, x } = await runtime();
  await call("script", { name: "k", code: 'cetus.hotkey("Ctrl+Shift+H", () => cetus.write(0x104, "u32", 7))', enabled: true });
  ctx.dispatchEvent(Object.assign(new ctx.Event("keydown"), { code: "KeyH", key: "H", ctrlKey: true, shiftKey: true }));
  assert.equal(x.readGold(), 7);
  await call("script", { name: "k", enabled: false });
  x.addGold(1);
  ctx.dispatchEvent(Object.assign(new ctx.Event("keydown"), { code: "KeyH", key: "H", ctrlKey: true, shiftKey: true }));
  assert.equal(x.readGold(), 8);
});

test("hotkey failures are reported in the hotkey event", async () => {
  const { ctx, call, events, x } = await runtime(), key = code => ctx.dispatchEvent(Object.assign(new ctx.Event("keydown"), { code, key: code.slice(-1), altKey: true }));
  const ptr = { base: { kind: "static", address: GAME.PTR }, offsets: [1e9] };
  await call("hotkeys", { bindings: [{ combo: "Alt+Q", action: "set", entry: { pointer: ptr, type: "i32" }, value: "5" }, { combo: "Alt+W", action: "set", entry: { address: GAME.HEALTH, type: "i32" }, value: "abc" },
    { combo: "Alt+E", action: "toggleScript", script: "ghost" }, { combo: "Alt+R", action: "toggleFreeze", entry: { address: 1e9, type: "i32" } }, { combo: "Alt+T", action: "toggleGroup", entries: [{ pointer: ptr, type: "i32" }] },
    { combo: "Alt+Y", action: "inc", entry: { address: GAME.GOLD, type: "u32" }, value: "2" }] });
  for (const c of ["KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY"]) key(c);
  await tick(ctx);
  const hk = events.filter(e => e.type === "hotkey").map(e => [e.body.combo, e.body.error ?? null]);
  assert.deepEqual(hk.slice(0, 3), [["Alt+Q", "Pointer does not resolve"], ["Alt+W", "Invalid integer: abc"], ["Alt+E", "Unknown script: ghost"]]);
  assert.deepEqual([hk[3][0], typeof hk[3][1], hk[4], hk[5]], ["Alt+R", "string", ["Alt+T", "Pointer does not resolve"], ["Alt+Y", null]]);
  assert.equal(x.getHealth(), 100);
});

test("scan hotkeys run next scans and undo on the active session", async () => {
  const { ctx, call, events, x } = await runtime();
  const key = code => ctx.dispatchEvent(Object.assign(new ctx.Event("keydown"), { code, key: code.slice(-1), altKey: true }));
  const last = () => events.filter(e => e.type === "hotkey").at(-1).body;
  const bindings = [{ combo: "Alt+D", action: "nextScan", compare: "decreased" }, { combo: "Alt+Z", action: "undoScan" },
    { combo: "Alt+E", action: "nextScan", compare: "eq", value: "90" }];
  await call("hotkeys", { bindings });
  key("KeyD");
  await tick(ctx);
  assert.deepEqual(plain(last()), { combo: "Alt+D", action: "nextScan", error: "No scan in progress" });
  const first = (await call("scan", { type: "i32", compare: "unknown", aligned: true })).count;
  x.damage(10);
  key("KeyD");
  await tick(ctx);
  const n = last().count;
  assert.ok(n > 0 && n < first);
  assert.ok((await call("scanRows", { offset: 0, limit: 500 })).rows.some(r => r.address === GAME.HEALTH));
  assert.equal((await call("state")).scan.count, n);
  key("KeyZ");
  await tick(ctx);
  assert.deepEqual(plain(last()), { combo: "Alt+Z", action: "undoScan", count: first });
  assert.equal((await call("state")).scan.count, first);
  key("KeyD");
  await tick(ctx);
  key("KeyE");
  await tick(ctx);
  assert.equal(last().count, (await call("state")).scan.count);
  assert.ok((await call("scanRows", { offset: 0, limit: 500 })).rows.some(r => r.address === GAME.HEALTH));
  assert.equal((await call("state")).scanDepth, 2);
});

test("script errors are throttled and a throwing hook is removed", async () => {
  const { ctx, call, events, instance } = await runtime(), errs = () => events.filter(e => e.type === "scriptError");
  await call("script", { name: "hk", code: 'cetus.hookExport("getHealth", { before() { throw new Error("x") }, after: () => 1 })', enabled: true });
  const f = instance.exports.getHealth;
  const rs = Array.from({ length: 100 }, () => f());
  assert.deepEqual([errs().map(e => e.body), new Set(rs)], [[{ name: "hk", message: "x" }], new Set([100])]);
  assert.deepEqual((await call("state")).scripts, [{ name: "hk", running: true, error: "x" }]);
  await call("script", { name: "k", code: 'cetus.hotkey("Alt+U", () => { throw new Error("k") }); cetus.hotkey("Alt+U", () => cetus.log("ok"))', enabled: true });
  for (let i = 0; i < 3; i++) ctx.dispatchEvent(Object.assign(new ctx.Event("keydown"), { code: "KeyU", key: "u", altKey: true }));
  assert.deepEqual([errs().length, events.filter(e => e.type === "scriptLog").length], [2, 3]);
  const code = ["getLives", "readGold", "damage"].map((k, i) => `cetus.hookExport("${k}", { after() { throw new Error("${i < 2 ? "y" : "z"}") } });`).join(" ");
  await call("script", { name: "fl", code, enabled: true });
  const e = instance.exports;
  [e.getLives(), e.getLives(), e.readGold(), e.damage(1), e.damage(1)];
  assert.deepEqual(errs().filter(e => e.body.name === "fl").map(e => e.body.message), ["y", "z"]);
});

test("disabling or removing a script undoes everything it did", async () => {
  const { ctx, call, events, instance, x } = await runtime(), ascii = async () => (await call("readValues", { items: [{ address: GAME.NAME_ASCII, type: "ascii", length: 10 }] })).values[0];
  const key = () => ctx.dispatchEvent(Object.assign(new ctx.Event("keydown"), { code: "KeyJ", key: "J", ctrlKey: true, shiftKey: true }));
  await call("freeze", { address: GAME.HEALTH, type: "i32", value: "50", enabled: true });
  await call("watch", { address: GAME.SPEED, size: 4, kind: "write", enabled: true });
  const code = `globalThis.leak = cetus; globalThis.n = 0;
    cetus.freeze(0x100, "i32", 999); cetus.freeze(0x118, "i16", 7, "noDecrease"); cetus.freezeGlobal("level", 9);
    globalThis.slots = [cetus.watch(0x104, 4), cetus.watch(0x108, 4)];
    cetus.patch(0x220, "ascii", "XX"); cetus.patch(0x240, "aob", "90 90"); cetus.patch(0x240, "u8", 1);
    cetus.hookExport("damage", { before: () => [0] }); cetus.onTick(() => n++); cetus.hotkey("Ctrl+Shift+J", () => cetus.write(0x104, "u32", 5));
    return () => cetus.log("bye", cetus.read(0x100, "i32"))`;
  await call("script", { name: "all", code, enabled: true });
  await tick(ctx);
  let st = await call("state");
  assert.deepEqual(plain(st.freezes), [{ address: GAME.HEALTH, type: "i32", value: 999 }, { address: GAME.NEG, type: "i16", value: 7, mode: "noDecrease" }, { global: "level", type: "i32", value: 9 }]);
  assert.deepEqual([st.watches.length, plain(ctx.slots)], [2, [1, 0]]);
  assert.equal(await ascii(), "XXAYER_ONE");
  instance.exports.damage(10);
  x.addGold(1);
  key();
  assert.deepEqual([x.getHealth(), x.readGold(), ctx.n > 0], [999, 5, true]);
  assert.ok((await call("state")).hits.some(h => h.slot === 1));
  await call("script", { name: "all", enabled: false });
  st = await call("state");
  assert.deepEqual(plain(st.freezes), [{ address: GAME.HEALTH, type: "i32", value: 50 }]);
  assert.deepEqual(plain(st.watches), [{ slot: 0, address: GAME.SPEED, size: 4, kind: "write" }]);
  assert.ok(!st.hits.some(h => h.slot === 1));
  assert.deepEqual(st.scripts, []);
  assert.equal(await ascii(), "PLAYER_ONE");
  assert.deepEqual((await call("read", { address: GAME.SIG, length: 6 })).bytes, [0xDE, 0xAD, 0xBE, 0xEF, 0x13, 0x37]);
  assert.deepEqual(events.filter(e => e.type === "scriptLog").map(e => e.body.text), ["bye 999"]);
  const n = ctx.n;
  await tick(ctx);
  await tick(ctx);
  key();
  x.level.value = 1;
  await tick(ctx);
  instance.exports.damage(10);
  assert.deepEqual([ctx.n, x.readGold(), x.level.value, x.getHealth()], [n, 5, 1, 40]);
  assert.throws(() => vm.runInContext('leak.freeze(0x104, "u32", 1)', ctx), /Script is not running/);
  assert.equal((await call("state")).freezes.length, 1);
  await call("freeze", { address: GAME.HEALTH, enabled: false, type: "i32", value: "0" });
  await call("script", { name: "bad", code: 'cetus.freeze(0x104, "u32", 1); cetus.watch(0x104, 4); cetus.patch(0x220, "ascii", "Q"); throw new Error("late")', enabled: true });
  st = await call("state");
  assert.deepEqual([st.freezes.length, st.watches.length, await ascii(), st.scripts[0].error], [0, 1, "PLAYER_ONE", "late"]);
  await call("script", { name: "re", code: 'cetus.freeze(0x104, "u32", 1)', enabled: true });
  await call("freeze", { address: GAME.GOLD, type: "u32", value: "2", enabled: true });
  await call("script", { name: "re", code: 'cetus.freeze(0x108, "f32", 1)', enabled: true });
  assert.deepEqual(plain((await call("state")).freezes), [{ address: GAME.GOLD, type: "u32", value: 2 }, { address: GAME.SPEED, type: "f32", value: 1 }]);
  await call("script", { name: "re", enabled: false });
  await call("freeze", { address: GAME.GOLD, type: "u32", value: "2", enabled: false });
  assert.deepEqual((await call("state")).freezes, []);
});

test("js value scan, write and freeze", async () => {
  const { ctx, call } = await runtime();
  vm.runInContext("globalThis.game = { js: { player: { hp: 77 } }, jsHit: n => game.js.player.hp -= n }", ctx);
  const path = "game.js.player.hp", has = r => r.rows.some(x => x.path === path);
  const r = await call("jsScan", { compare: "eq", value: "77" });
  assert.ok(has(r));
  ctx.game.jsHit(7);
  const d = await call("jsScan", { compare: "decreased" });
  assert.ok(has(d) && d.count <= r.count);
  assert.equal(d.rows.find(x => x.path === path).value, 70);
  await assert.rejects(call("jsScan", { compare: "between" }), /Invalid comparison/);
  await call("jsWrite", { path, value: "50" });
  assert.equal(ctx.game.js.player.hp, 50);
  await call("jsFreeze", { path, value: "60", enabled: true });
  ctx.game.jsHit(7);
  assert.equal(ctx.game.js.player.hp, 60);
  assert.deepEqual(plain((await call("state")).jsFreezes), [{ path, value: 60 }]);
  await call("jsScanReset");
  assert.equal((await call("jsScan", { compare: "eq", value: "60" })).rows.find(x => x.path === path).frozen, true);
  await call("jsWrite", { path, value: "65" });
  ctx.game.jsHit(1);
  assert.equal(ctx.game.js.player.hp, 65);
  assert.ok(has(await call("jsScan", { compare: "changed" })));
  await call("jsFreeze", { path, enabled: false });
  ctx.game.jsHit(5);
  assert.equal(ctx.game.js.player.hp, 60);
  assert.deepEqual((await call("state")).jsFreezes, []);
  await call("jsScanReset");
  assert.ok(has(await call("jsScan", { compare: "unknown" })));
  await assert.rejects(call("jsWrite", { path: "nope.x", value: "1" }), /Unknown path/);
});

test("hooked worker resolves relative urls against the real script and holds messages until the module loads", async () => {
  const ctx = loadPage(["shared/utils.js", "shared/wail.min.js/wail.min.js", "content/cetus.js", "content/init.js"], { pre: `globalThis.cetusLib = { worker: "t", workerSrc: "src", base: "http://h/w/worker.js" }; globalThis.seen = []; globalThis.fetch = u => seen.push(u);` });
  vm.runInContext(`fetch("a.wasm"); fetch(new URL("http://x/b"));`, ctx);
  assert.deepEqual([ctx.location.href, [...ctx.seen]], ["http://h/w/worker.js", ["http://h/w/a.wasm", "http://x/b"]]);
  let go;
  const held = vm.runInContext("p => cetusLib.hold(p)", ctx)(new Promise(r => go = r));
  vm.runInContext(`globalThis.got = []; addEventListener("message", e => got.push(e.data));`, ctx);
  vm.runInContext(`dispatchEvent(new MessageEvent("message", { data: 1 }))`, Object.assign(ctx, { MessageEvent }));
  assert.deepEqual([...ctx.got], []);
  go();
  await held;
  assert.deepEqual([...ctx.got], [1]);
});

test("UI storage updates are serialized so concurrent read-modify-writes are not lost", async () => {
  const pre = `globalThis.store = {}; const clone = v => v === undefined ? v : JSON.parse(JSON.stringify(v)), tick = v => new Promise(r => setTimeout(() => r(v), 5));
    globalThis.chrome = { storage: { local: { get: k => tick({ [k]: clone(store[k]) }), set: o => tick(Object.assign(store, clone(o))) }, session: { get: () => tick({}) } },
      tabs: { query: () => tick([]), sendMessage: (t, m) => (({ id, type, body }) => type === "canonPatch" ? tick(JSON.stringify({ id, ok: true, body: { index: body.index - 2, bytes: [...body.bytes, 0], ...body.locals.length && { locals: body.locals } } }))
        : Promise.reject(new Error("x")))(JSON.parse(m)) }, runtime: { onMessage: { addListener() {} } } };
    globalThis.view = { render() {}, toast() {} }; globalThis.document = new EventTarget();`;
  const ctx = loadPage(["shared/utils.js", "extension/extension.js"], { pre });
  const ui = vm.runInContext("ui", ctx);
  ctx.store.savedPatches = [{ name: "a", url: null, enabled: true, version: 2, functionPatches: [{ index: 5, bytes: [1] }, { index: 7, bytes: [2] }] }];
  await Promise.all([1, 2, 3].map(i => ui.table(l => [...l, { address: i, type: "i32" }])));
  await Promise.all([ui.savePatch("a", 5, [11]), ui.savePatch("b", 4, [11])]);
  assert.deepEqual(JSON.parse(JSON.stringify([ctx.store.cheatTables[""].map(e => e.address), ctx.store.savedPatches.map(p => p.name)])), [[1, 2, 3], ["a", "b"]]);
  assert.deepEqual(plain(ctx.store.savedPatches.map(p => p.functionPatches)), [[{ index: 7, bytes: [2] }, { index: 3, bytes: [11, 0], space: "original" }], [{ index: 2, bytes: [11, 0], space: "original" }]]);
  await ui.savePatch("a", 9, [12]);
  assert.deepEqual(plain(ctx.store.savedPatches[0].functionPatches.map(f => f.index)), [7, 3, 7]);
  await ui.savePatch("a", 9, [13]);
  assert.deepEqual(plain(ctx.store.savedPatches[0].functionPatches.map(f => [f.index, f.bytes[0]])), [[7, 2], [3, 11], [7, 13]]);
  assert.deepEqual(plain(ui.functionPatch({ index: 1, bytes: { 0: 5 }, space: "running" })), { index: 1, bytes: [5] });
  await ui.savePatch("c", 4, Object.assign([1], { locals: ["i32", "f64"] }), { processor: "p()", preinstantiate: " " });
  const c = () => plain(ctx.store.savedPatches.find(p => p.name === "c"));
  assert.deepEqual([c().functionPatches, c().callbacks], [[{ index: 2, bytes: [1, 0], space: "original", locals: ["i32", "f64"] }], { processor: "p()" }]);
  await ui.savePatch("c", 4, [2]);
  assert.deepEqual([c().functionPatches, c().callbacks], [[{ index: 2, bytes: [2, 0], space: "original" }], { processor: "p()" }]);
  await ui.savePatch("c", 4, [3], { processor: "", preinstantiate: "q()" });
  assert.deepEqual(c().callbacks, { preinstantiate: "q()" });
  await ui.savePatch("c", 4, [3], { processor: "", preinstantiate: "" });
  assert.equal(c().callbacks, undefined);
  assert.deepEqual(plain(ui.functionPatch({ index: 1, bytes: [5], space: "original", locals: ["i32"] })), { index: 1, bytes: [5], space: "original", locals: ["i32"] });
  assert.deepEqual(plain(ui.functionPatch({ index: 1, bytes: [5], space: "original", locals: [7] })), { index: 1, bytes: [5], space: "original" });
});

test("UI table entries carry the selected memory and match only within the same memory", async () => {
  const pre = `globalThis.store = {}; const clone = v => v === undefined ? v : JSON.parse(JSON.stringify(v)), tick = v => new Promise(r => setTimeout(() => r(v), 1));
    globalThis.chrome = { storage: { local: { get: k => tick({ [k]: clone(store[k]) }), set: o => tick(Object.assign(store, clone(o))) }, session: { get: () => tick({}) } },
      tabs: { query: () => tick([]), sendMessage: () => Promise.reject(new Error("x")) }, runtime: { onMessage: { addListener() {} } } };
    globalThis.view = { render() {}, toast() {} }; globalThis.document = new EventTarget();`;
  const ctx = loadPage(["shared/utils.js", "extension/extension.js"], { pre }), ui = vm.runInContext("ui", ctx);
  await new Promise(r => setTimeout(r, 30));
  ui.state = { active: 1, instances: [{ id: 1, url: "http://a.test/g", memory: 1 }] };
  assert.equal(ui.mem(), 1);
  assert.ok(!ui.same({ address: 1, type: "i32" }, { address: 1, type: "i32", memory: 1 }));
  assert.ok(ui.same({ address: 1, type: "i32", memory: 0 }, { address: 1, type: "i32" }));
  await ui.addEntries([{ address: 1, type: "i32" }, { address: 1, type: "i32", memory: 0 }, { address: 1, type: "i32" }]);
  await ui.addEntries([{ address: 1, type: "i32", memory: 1 }], 0);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.store.cheatTables["a.test/g"])), [{ address: 1, type: "i32", memory: 1 }, { address: 1, type: "i32" }]);
});

test("UI pointer scans are stored per site, compactly, with at most 100,000 chains across sites", async () => {
  const pre = `globalThis.store = {}; const clone = v => v === undefined ? v : JSON.parse(JSON.stringify(v)), tick = v => new Promise(r => setTimeout(() => r(v), 1));
    globalThis.chrome = { storage: { local: { get: k => tick({ [k]: clone(store[k]) }), set: o => tick(Object.assign(store, clone(o))) }, session: { get: () => tick({}) } },
      tabs: { query: () => tick([]), sendMessage: () => Promise.reject(new Error("x")) }, runtime: { onMessage: { addListener() {} } } };
    globalThis.view = { render() {}, toast() {} }; globalThis.document = new EventTarget();`;
  const ctx = loadPage(["shared/utils.js", "extension/extension.js"], { pre }), ui = vm.runInContext("ui", ctx);
  const at = url => ui.state = { active: 1, instances: [{ id: 1, url }] }, plain = v => JSON.parse(JSON.stringify(v));
  const rows = [{ base: { kind: "static", address: 0x300 }, offsets: [0x10] }, { base: { kind: "global", name: "level" }, offsets: [4, -8] }];
  await new Promise(r => setTimeout(r, 30));
  assert.equal(await ui.pointerScan(), null);
  at("http://a.test/game");
  await ui.pointerScan({ target: 0x1010, type: "i32", rows });
  assert.deepEqual(plain(ctx.store.pointerScans["a.test/game"]), { target: 0x1010, type: "i32", rows: [[0x300, 0x10], ["level", 4, -8]] });
  assert.deepEqual(plain(await ui.pointerScan()), { target: 0x1010, type: "i32", rows });
  at("http://b.test/");
  assert.equal(await ui.pointerScan(), undefined);
  await ui.pointerScan({ target: 4, type: "u8", rows: Array(99998).fill(rows[0]) });
  assert.deepEqual(plain(Object.keys(ctx.store.pointerScans)), ["b.test/", "a.test/game"]);
  await ui.pointerScan({ target: 4, type: "u8", rows: Array(100001).fill(rows[0]) });
  assert.deepEqual(plain([Object.keys(ctx.store.pointerScans), ctx.store.pointerScans["b.test/"].rows.length]), [["b.test/"], 100000]);
});

test("worker contexts acknowledge watch syncs and state reports synced per worker", async () => {
  const pre = `globalThis.posted = []; globalThis.BroadcastChannel = class { constructor() { globalThis.chan = this; } postMessage(m) { posted.push(m); } };`;
  const w = loadPage(RUNTIME, { pre: `globalThis.cetusLib = { worker: "t" }; ${pre}` });
  w.chan.onmessage({ data: { tok: "t", t: "sync", n: 3, slots: [null, null, null, null], sites: [] } });
  assert.deepEqual(Array.from(w.posted, ({ t, n, from }) => [t, n, typeof from]), [["hi", undefined, "undefined"], ["synced", 3, "string"]]);
  const m = loadPage(RUNTIME, { pre }), call = (t, b) => m.cetusLib.handle(t, b);
  m.dispatchEvent(new m.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: {} }) }));
  await m.WebAssembly.instantiate(buildGame(), { env: {} });
  await call("watch", { address: 0x100, size: 4, kind: "write", enabled: true });
  const tok = m.posted.at(-1).tok, synced = async () => Array.from((await call("state", {})).instances.filter(i => i.worker), i => i.synced);
  m.chan.onmessage({ data: { tok, t: "init", from: "w1", instance: { id: 1, worker: true, shared: true } } });
  assert.deepEqual([m.posted.at(-1).t, await synced()], ["sync", [false]]);
  m.chan.onmessage({ data: { tok, t: "synced", from: "w2", n: m.posted.at(-1).n } });
  assert.deepEqual(await synced(), [false]);
  m.chan.onmessage({ data: { tok, t: "synced", from: "w1", n: m.posted.at(-1).n } });
  assert.deepEqual(await synced(), [true]);
  await call("watch", { address: 0x100, size: 4, kind: "write", enabled: false });
  assert.deepEqual(await synced(), [false]);
  await call("customTypes", { types: [XOR] });
  assert.deepEqual([m.posted.at(-1).t, plain(m.posted.at(-1).ct)], ["sync", [XOR]]);
  assert.ok(!w.cetusLib.isType("xor"));
  w.chan.onmessage({ data: { tok: "t", t: "sync", n: 4, slots: [null, null, null, null], sites: [], ct: [XOR] } });
  assert.ok(w.cetusLib.isType("xor"));
});

test("a selected worker instance runs every request in its own context over the channel", async () => {
  const pre = "globalThis.peer = () => {}; globalThis.BroadcastChannel = class { "
    + "constructor() { globalThis.chan = this; } postMessage(m) { peer(m); } };";
  const m = loadPage(RUNTIME, { pre }), posts = [], later = (c, d) => setTimeout(() => c.chan.onmessage({ data: d }));
  let w = null;
  m.peer = d => (posts.push(d), w && later(w, d));
  await m.cetusLib.handle("breakpoint", { func: 0, offset: 0, break: false });
  w = loadPage(RUNTIME, { pre: `globalThis.cetusLib = { worker: ${JSON.stringify(posts[0].tok)} }; ${pre}` });
  w.peer = d => (posts.push(d), later(m, d));
  const cfg = (c, body) => c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body }) }));
  cfg(m, { table: [{ address: GAME.GOLD, type: "u32", frozen: true, freezeValue: "7" }], hotkeys: [] });
  cfg(w, {});
  const x = (await w.WebAssembly.instantiate(buildGame())).instance.exports, call = (t, b = {}) => m.cetusLib.handle(t, b);
  const until = async f => {
    for (let i = 0; i < 300 && !await f(); i++) await new Promise(r => setTimeout(r, 10));
    assert.ok(await f());
  };
  await until(async () => (await call("state")).instances.length === 1);
  const { instances: [wi], active } = await call("state");
  assert.deepEqual([wi.worker, active], [true, wi.id]);
  try {
    await until(() => x.readGold() === 7);
    assert.deepEqual(plain(await call("select", { id: wi.id })), { active: wi.id });
    await assert.rejects(call("select", { id: 99 }), /Unknown instance/);
    const found = await call("scan", { type: "i32", compare: "eq", value: "100", aligned: true });
    assert.ok(found.rows.some(r => r.address === GAME.HEALTH));
    const req = posts.find(p => p.t === "req" && p.type === "scan");
    const res = posts.find(p => p.t === "res" && p.rid === req.rid);
    assert.deepEqual([typeof req.to, req.lid, res.ok, res.body.count], ["string", 1, true, found.count]);
    await call("write", { address: GAME.HEALTH, type: "i32", value: "999" });
    const hp = await call("readValues", { items: [{ address: GAME.HEALTH, type: "i32" }] });
    assert.deepEqual(plain([x.getHealth(), hp.values]), [999, [999]]);
    await assert.rejects(call("read", { address: 2 ** 20, length: 4 }), /Address out of range/);
    await call("freeze", { address: GAME.HEALTH, type: "i32", value: "999", enabled: true });
    x.damage(5);
    await until(() => x.getHealth() === 999);
    const st = await call("state");
    const frozen = st.freezes.map(f => f.address).sort();
    assert.deepEqual(plain([st.scan.count, frozen]), [found.count, [GAME.HEALTH, GAME.GOLD].sort()]);
    assert.ok((await call("globals")).globals.some(g => g.name === "level"));
    assert.ok((await call("function", { index: 4 })).bytes.length > 0);
    await call("freeze", { address: GAME.HEALTH, type: "i32", enabled: false });
    await call("hotkeys", { bindings: [{ combo: "Alt+K", action: "set", entry: { address: GAME.HEALTH, type: "i32" }, value: "5" }] });
    m.dispatchEvent(Object.assign(new m.Event("keydown"), { altKey: true, code: "KeyK" }));
    await until(() => x.getHealth() === 5);
    await call("watch", { address: GAME.HEALTH, size: 4, kind: "write", enabled: true });
    await until(async () => (await call("state")).instances[0].synced);
    x.damage(1);
    await until(async () => (await call("state")).hits.length === 1);
    assert.deepEqual((({ name, last }) => [name, last.old, last.new])((await call("state")).hits[0]), ["damage", 5, 4]);
    const clicks = [];
    Object.assign(m, { Blob, document: { createElement: () => ({ click() { clicks.push(this.download); } }) } });
    assert.deepEqual(plain([(await call("dump", { what: "memory" })).size, clicks]), [65536, [`memory-${wi.id}.bin`]]);
  } finally {
    await call("freeze", { address: GAME.GOLD, type: "u32", enabled: false });
  }
});

test("worker instances that go away are dropped, with their pending requests, and the newest worker wins ties", async () => {
  const pre = `globalThis.posted = []; globalThis.close = () => { globalThis.closed = true; }; globalThis.BroadcastChannel = class {
    constructor() { globalThis.chan = this; } postMessage(m) { posted.push(m); globalThis.peer?.(m); } };
    globalThis.locked = []; globalThis.navigator = { locks: { request: (n, f) => (locked.push([n, f]), Promise.resolve()) } };`;
  const m = loadPage(RUNTIME, { pre }), call = (t, b = {}) => m.cetusLib.handle(t, b);
  m.peer = d => d.t === "req" && d.type === "state" && setTimeout(() => m.chan.onmessage({ data: { tok: d.tok, t: "res", rid: d.rid, ok: true, body: { instances: [] } } }));
  await call("breakpoint", { func: 0, offset: 0, break: false });
  const tok = m.posted[0].tok, init = (from, id, lock) => m.chan.onmessage({ data: { tok, t: "init", from, lock, instance: { id, worker: true, memoryBytes: 65536 } } });
  init("w1", 1);
  init("w2", 1);
  const ids = async () => (s => [s.instances.map(i => i.id), s.active])(await call("state"));
  const [[a, b], active] = await ids();
  assert.equal(active, b);
  assert.equal((await call("state")).instances[0].page, m.location.href);
  await call("select", { id: a });
  const pending = call("readValues", { items: [{ address: 0, type: "i32" }] });
  assert.equal(m.posted.at(-1).to, "w1");
  const seen = [];
  m.addEventListener("cetusMsgIn", e => seen.push(L.decode(e.detail).type));
  m.chan.onmessage({ data: { tok, t: "bye", from: "w1" } });
  await assert.rejects(pending, /Worker is gone/);
  m.chan.onmessage({ data: { tok, t: "bye", from: "w1" } });
  assert.deepEqual(seen, ["instances"]);
  assert.deepEqual(plain(await ids()), [[b], b]);
  init("w3", 1, true);
  const [[, c], now] = await ids();
  assert.deepEqual(plain([now, m.locked.map(([n]) => n)]), [c, [`cetus-${tok}-w3`]]);
  m.locked[0][1]();
  assert.deepEqual(plain(await ids()), [[b], b]);
  const w = loadPage(RUNTIME, { pre: `globalThis.cetusLib = { worker: ${JSON.stringify(tok)}, wid: "w9" }; ${pre}` });
  w.close();
  assert.deepEqual(plain([w.closed, w.posted.at(-1), w.locked.map(([n]) => n)]), [true, { tok, t: "bye", from: "w9" }, [`cetus-${tok}-w9`]]);
});

test("watchAt rejects a pointer that resolves past the end of memory", async () => {
  const { call } = await runtime(c => c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: {} }) })));
  await call("write", { address: 0x2000, type: "u32", value: String(65534) });
  const pointer = { base: { kind: "static", address: 0x2000 }, offsets: [0] };
  await assert.rejects(call("watchAt", { pointer, size: 4 }), /Address out of range/);
  assert.equal((await call("watchAt", { pointer, size: 2 })).address, 65534);
});

test("worker hit stacks use the firing instance's names, not the last requested one", async () => {
  const pre = `globalThis.posted = []; globalThis.BroadcastChannel = class {
    constructor() { globalThis.chan = this; } postMessage(m) { posted.push(m); } };`;
  const w = loadPage(RUNTIME, { pre: `globalThis.cetusLib = { worker: "t", wid: "w1" }; ${pre}` });
  w.dispatchEvent(new w.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: {} }) }));
  const x = (await w.WebAssembly.instantiate(buildGame())).instance.exports;
  await w.WebAssembly.instantiate(typedGlobals(), { env: { tick: 5, speed: new w.WebAssembly.Global({ value: "f32", mutable: true }, 4) } });
  await new Promise(r => setTimeout(r));
  const lid = w.posted.filter(p => p.t === "init").at(-1).instance.id;
  w.chan.onmessage({ data: { tok: "t", t: "req", to: "w1", lid, rid: 1, type: "state", body: {} } });
  w.chan.onmessage({ data: { tok: "t", t: "sync", n: 1, slots: [[GAME.HEALTH, 4, 1], null, null, null], sites: [] } });
  x.damage(1);
  const hit = w.posted.find(p => p.t === "hit");
  assert.deepEqual([hit.op, hit.st[0].name], [0, "damage"]);
});

const typedGlobals = () => {
  const s = t => [t.length, ...Buffer.from(t)], sec = (id, b) => [id, b.length, ...b], f32 = v => [...Buffer.from(new Float32Array([v]).buffer)];
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sec(1, [1, 0x60, 0, 0]), ...sec(2, [2, ...s("env"), ...s("tick"), 3, 0x7f, 0, ...s("env"), ...s("speed"), 3, 0x7d, 1]), ...sec(3, [1, 0]), ...sec(5, [1, 0, 1]),
    ...sec(6, [5, 0x7d, 1, 0x43, ...f32(3), 0x0b, 0x63, 0x70, 1, 0xd0, 0x70, 0x0b, 0x6f, 1, 0xd0, 0x6f, 0x0b, 0x7e, 0, 0x42, 7, 0x0b, 0x7f, 0, 0x23, 0, 0x41, 1, 0x6a, 0x0b]),
    ...sec(7, [4, ...s("whole"), 3, 2, ...s("ext"), 3, 4, ...s("big"), 3, 5, ...s("memory"), 2, 0]), ...sec(10, [1, 2, 0, 0x0b]), ...sec(0, [...s("name"), ...sec(7, [1, 3, ...s("cb")])])]);
};
const typedRuntime = async setup => {
  const ctx = loadPage(RUNTIME);
  setup?.(ctx);
  ctx.dispatchEvent(new ctx.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: {} }) }));
  const speed = new ctx.WebAssembly.Global({ value: "f32", mutable: true }, 4), { instance } = await ctx.WebAssembly.instantiate(typedGlobals(), { env: { tick: 5, speed } });
  return { speed, x: instance.exports, call: async (t, b = {}) => L.decode(L.encode(await ctx.cetusLib.handle(t, b))) };
};
const TYPED = [["env.tick", "i32", false, 5], ["env.speed", "f32", true, 4], ["whole", "f32", true, 3], ["cb", "(ref null func)", true, "null"], ["ext", "externref", true, "null"],
  ["big", "i64", false, 7n], ["global6", "i32", false, 6]];

test("scan reads exact global types and mutability from the global and import sections", () => {
  const { scan } = page().ctx.cetusLib;
  assert.deepEqual(plain(scan(typedGlobals()).globals), [{ type: "i32", mutable: false, import: { module: "env", field: "tick" } }, { type: "f32", mutable: true, import: { module: "env", field: "speed" } },
    { type: "f32", mutable: true }, { type: "(ref null func)", mutable: true }, { type: "externref", mutable: true }, { type: "i64", mutable: false }, { type: "i32", mutable: false }]);
  assert.deepEqual(plain(scan(buildGame()).globals).map(g => g.type), ["i32", "i32", "f32", "v128", "funcref", "f64"]);
});

test("globals list imported and defined globals with declared types, instrumented or not", async () => {
  for (const off of [false, true]) {
    const { call, x, speed } = await typedRuntime(off ? (c => { c.cetusLib.instrument = () => { throw new Error("off"); }; }) : null);
    assert.equal((await call("state")).instances[0].instrumented, !off);
    const rows = (await call("globals")).globals.map(g => [g.name, g.type, g.mutable, g.value]);
    assert.deepEqual(rows, off ? TYPED.map(r => ["cb", "global6"].includes(r[0]) ? [...r.slice(0, 3), null] : r) : TYPED);
    await call("setGlobal", { name: "whole", value: "2.5" });
    assert.equal(x.whole.value, 2.5);
    await call("setGlobal", { name: "env.speed", value: "1.25" });
    assert.equal(speed.value, 1.25);
    x.ext.value = { a: 1 };
    assert.equal((await call("globals")).globals[4].value, "[object Object]");
    await call("setGlobal", { name: "ext", value: "null" });
    assert.equal(x.ext.value, null);
    await assert.rejects(call("setGlobal", { name: "ext", value: "1" }), /only be set to null/);
    await assert.rejects(call("setGlobal", { name: "env.tick", value: "1" }), /immutable/);
    await call("freeze", { global: "whole", value: "6", enabled: true });
    x.whole.value = 1;
    await new Promise(r => setTimeout(r, 120));
    assert.equal(x.whole.value, 6);
    assert.deepEqual((await call("freeze", { global: "whole", enabled: false })).freezes, []);
  }
});

test("pointer scan bases use only i32 globals", async () => {
  const { call, x } = await runtime();
  x.ratio.value = 0x1000;
  x.level.value = 0x1000;
  const bases = (await call("pointerScan", { address: GAME.HERO_HP, maxDepth: 1, maxOffset: 4096 })).rows.map(r => r.base.name).filter(Boolean);
  assert.ok(bases.includes("level") && !bases.includes("ratio"));
});

test("globals without module bytes detect v128 through a helper module", async () => {
  const ctx = loadPage(["shared/utils.js", "content/cetus.js"]);
  ctx.dispatchEvent(new ctx.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: {} }) }));
  const bytes = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 6, 22, 1, 0x7b, 1, 0xfd, 0x0c, ...Array(16).fill(7), 0x0b, 7, 5, 1, 1, 0x76, 3, 0]);
  const memory = new ctx.WebAssembly.Memory({ initial: 1 }), instance = new ctx.WebAssembly.Instance(new ctx.WebAssembly.Module(bytes));
  ctx.cetusLib.register({ instance: { exports: { ...instance.exports, memory } }, memory, instrumented: false, error: "x", meta: null });
  const call = async (t, b = {}) => plain(await ctx.cetusLib.handle(t, b));
  assert.deepEqual((await call("globals")).globals, [{ name: "v", index: null, type: "v128", mutable: true, value: Array(16).fill("07").join(" ") }]);
  await call("setGlobal", { name: "v", value: "01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 02" });
  assert.equal((await call("globals")).globals[0].value, "01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 02");
});

test("insnEnd walks every assembler stream on instruction boundaries", () => {
  const { insnEnd } = loadPage(RUNTIME).cetusLib;
  assert.ok(STREAMS.length > 1500);
  for (const b of STREAMS) {
    const offs = [];
    for (let p = 0; p < b.length; p = insnEnd(Uint8Array.from(b), p)) offs.push(p);
    assert.deepEqual(offs, disassemble(b).lines.map(l => l.offset), String(b));
  }
});

test("xrefs list callers, table entries and global accesses", async () => {
  const { call } = await runtime();
  const { rows } = await call("xrefs", { func: 8 }), tail = await call("function", { index: 16 });
  assert.deepEqual(plain(rows).map(r => [r.func, r.name, r.text]), [[16, "magicTail", "call 8"], [16, "magicTail", "return_call 8"], [null, null, "elem 0 table 0 slot 0"]]);
  assert.deepEqual(rows.slice(0, 2).map(r => tail.bytes[r.offset - tail.bodyOffset]), [0x10, 0x12]);
  assert.deepEqual(plain((await call("xrefs", { func: 15 })).rows).map(r => r.text), ["global 4 = ref.func 15", "elem 0 table 0 slot 1"]);
  const lives = plain((await call("xrefs", { global: "lives" })).rows);
  assert.deepEqual(lives.map(r => [r.func, r.name, r.text]), [[7, "getLives", "global.get 0"]]);
  assert.deepEqual(plain((await call("xrefs", { global: 0 })).rows), lives);
  assert.deepEqual((await call("xrefs", { func: 11 })).rows, []);
  await assert.rejects(call("xrefs", {}), /Missing function or global/);
  await assert.rejects(call("xrefs", { global: 6 }), /Invalid global index/);
  await assert.rejects(call("xrefs", { global: "nope" }), /Unknown global/);
  await assert.rejects(call("xrefs", { func: -1 }), /Invalid function index/);
  const bare = await runtime(c => c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: { patches: [{ index: 8, bytes: [0xff] }] } }) })));
  assert.equal((await bare.call("state")).instances[0].instrumented, false);
  const raw = plain((await bare.call("xrefs", { func: 6 })).rows), body = await bare.call("function", { index: 14 });
  assert.deepEqual(raw.map(r => [r.func, r.text, body.bytes[r.offset - body.bodyOffset] ?? null]), [[14, "call 6", 0x10], [14, "return_call 6", 0x12], [null, "elem 0 table 0 slot 0", null]]);
});

test("xrefs cover imports, start, passive and declared elements and const expressions", async () => {
  const ctx = loadPage(RUNTIME), s = (id, b) => [id, b.length, ...b], t = x => [x.length, ...Buffer.from(x)];
  ctx.dispatchEvent(new ctx.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: { patches: [], callbacks: { processor: [], preinstantiate: [] } } }) }));
  const bytes = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...s(1, [1, 0x60, 0, 0]),
    ...s(2, [2, ...t("env"), ...t("f"), 0, 0, ...t("env"), ...t("base"), 3, 0x7f, 0]), ...s(3, [2, 0, 0]), ...s(5, [1, 0, 1]),
    ...s(6, [1, 0x7f, 0, 0x23, 0, 0x0b]), ...s(8, [2]), ...s(9, [2, 5, 0x70, 1, 0xd2, 1, 0x0b, 3, 0, 1, 1]),
    ...s(10, [2, 4, 0, 0x10, 0, 0x0b, 7, 0, 0x10, 1, 0x23, 1, 0x1a, 0x0b]), ...s(11, [1, 0, 0x23, 0, 0x0b, 1, 0x2a])]);
  let calls = 0;
  await ctx.WebAssembly.instantiate(bytes, { env: { f: () => calls++, base: 0x40 } });
  assert.equal(calls, 1);
  const call = async (type, body) => plain(await ctx.cetusLib.handle(type, body)), texts = async b => (await call("xrefs", b)).rows.map(r => [r.func, r.text]);
  assert.equal((await call("state", {})).instances[0].instrumented, true);
  assert.deepEqual(await texts({ func: 3 }), [[4, "call 3"], [null, "elem 0 passive"], [null, "elem 1 declare"]]);
  assert.deepEqual(await texts({ func: 4 }), [[null, "start"]]);
  assert.deepEqual(await texts({ func: 0 }), [[3, "call 0"]]);
  assert.deepEqual(await texts({ global: 0 }), [[null, "global 1 = global.get 0"], [null, "data 0 offset global.get 0"]]);
  assert.deepEqual(await texts({ global: 1 }), [[4, "global.get 1"]]);
});

test("multi-memory: instrumentation records every memory and skips accesses to memories above 0", async () => {
  for (const precise of [false, true]) {
    const { meta, x, hits } = instr({ precise }, buildGame({ multimem: true })), base = instr({ precise }).meta;
    assert.ok(WebAssembly.validate(meta.bytes));
    assert.deepEqual(plain(meta.memories), [{ index: 0, kind: "export", name: "memory" }, { index: 1, kind: "internal", name: "__cetus_memory1" }]);
    assert.deepEqual(plain(meta.memory), { kind: "export", name: "memory" });
    assert.equal(meta.sites.length, base.sites.length);
    assert.deepEqual(plain(meta.dataRanges.at(-1)), [GAME.HEALTH, GAME.HEALTH + 1, 1]);
    assert.equal(new Uint8Array(x.__cetus_memory1.buffer)[GAME.HEALTH], 0x2a);
    x.__cetus_watch(0, GAME.HEALTH, 4, precise ? 4 : 1);
    x.__cetus_watch(1, GAME.HEALTH, 4, 2);
    x.poke2(5);
    x.peek2();
    assert.deepEqual(hits.splice(0), []);
    x.damage(1);
    x.getHealth();
    assert.deepEqual(hitList(hits), [[0, "write"], [1, "read"], [1, "read"]]);
  }
  const imp = page().ctx.cetusLib.instrument(buildGame({ multimem: true, importMemory: true }));
  assert.deepEqual(plain(imp.memories), [{ index: 0, kind: "import", module: "env", field: "memory" }, { index: 1, kind: "internal", name: "__cetus_memory1" }]);
});

test("multi-memory: selectMemory switches address requests, freezes and table entries keep their memory", async () => {
  const { ctx, call, x } = await runtime(undefined, undefined, buildGame({ multimem: true }));
  let st = await call("state");
  assert.deepEqual(plain(st.instances[0].memories), [{ index: 0, bytes: 65536, shared: false }, { index: 1, bytes: 65536, shared: false }]);
  assert.equal(st.instances[0].memory, 0);
  assert.equal((await call("read", { address: GAME.HEALTH, length: 1 })).bytes[0], 100);
  await call("scan", { type: "u8", compare: "eq", value: "42", aligned: false });
  await assert.rejects(call("selectMemory", { index: 5 }), /Unknown memory: 5/);
  assert.deepEqual(await call("selectMemory", { index: 1 }), { memory: 1 });
  st = await call("state");
  assert.deepEqual([st.instances[0].memory, st.scan], [1, null]);
  assert.equal((await call("read", { address: GAME.HEALTH, length: 1 })).bytes[0], 0x2a);
  assert.deepEqual((await call("readValues", { items: [{ address: GAME.HEALTH, type: "i32" }, { address: GAME.HEALTH, type: "i32", memory: 0 }] })).values, [0x2a, 100]);
  assert.deepEqual(plain((await call("scan", { type: "u8", compare: "eq", value: "42", aligned: false })).rows.map(r => r.address)), [GAME.HEALTH]);
  assert.deepEqual(await call("find", { from: 0, type: "aob", value: "2A" }), { address: GAME.HEALTH });
  await call("write", { address: GAME.HEALTH, type: "i32", value: "9" });
  assert.deepEqual([x.peek2(), x.getHealth()], [9, 100]);
  await call("writeBytes", { address: GAME.HEALTH, bytes: [1, 0, 0, 0] });
  assert.equal(x.peek2(), 1);
  await call("undo");
  assert.equal(x.peek2(), 9);
  assert.deepEqual((await call("snapshot", { op: "save", name: "m1" })).snapshots.map(r => [r.name, r.memory]), [["m1", 1]]);
  x.poke2(3);
  await call("snapshot", { op: "restore", name: "m1" });
  assert.equal(x.peek2(), 9);
  await assert.rejects(call("watch", { address: GAME.HEALTH, size: 4, kind: "write", enabled: true }), /Watches only work on memory 0/);
  const f = await call("freeze", { address: GAME.HEALTH, type: "i32", value: "7", enabled: true });
  await call("freeze", { address: GAME.HEALTH, type: "i32", value: "55", enabled: true, memory: 0 });
  assert.deepEqual(f.freezes, [{ address: GAME.HEALTH, type: "i32", value: 7, memory: 1 }]);
  x.poke2(99);
  x.damage(10);
  await tick(ctx);
  assert.deepEqual([x.peek2(), x.getHealth()], [7, 55]);
  await call("selectMemory", { index: 0 });
  await call("freeze", { address: GAME.HEALTH, type: "i32", enabled: false, memory: 1 });
  assert.deepEqual((await call("state")).freezes, [{ address: GAME.HEALTH, type: "i32", value: 55 }]);
  await call("freeze", { address: GAME.HEALTH, type: "i32", enabled: false });
  assert.deepEqual(plain((await call("scan", { type: "u8", compare: "eq", value: "7", aligned: false, memory: 1 })).rows.map(r => r.address)), [GAME.HEALTH]);
  assert.equal((await call("state")).instances[0].memory, 1);
  await call("selectMemory", { index: 0 });
  await call("hotkeys", { bindings: [{ combo: "Alt+M", action: "toggleFreeze", entry: { address: GAME.HEALTH, type: "i32", memory: 1 } }] });
  ctx.dispatchEvent(Object.assign(new ctx.Event("keydown"), { code: "KeyM", key: "m", altKey: true }));
  assert.deepEqual((await call("state")).freezes, [{ address: GAME.HEALTH, type: "i32", value: 7, memory: 1 }]);
  await call("freeze", { address: GAME.HEALTH, type: "i32", enabled: false, memory: 1 });
});

test("multi-memory: a write watch on memory 0 is not hit by stores to memory 1, even in precise mode", async () => {
  for (const precise of [false, true]) {
    const cfg = c => c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body: { instrumentOptions: { precise } } }) }));
    const { call, x } = await runtime(cfg, undefined, buildGame({ multimem: true }));
    await call("watch", { address: GAME.HEALTH, size: 4, kind: "write", enabled: true });
    await call("watch", { address: GAME.HEALTH, size: 4, kind: "read", enabled: true });
    x.poke2(1);
    x.poke2(2);
    x.peek2();
    assert.deepEqual((await call("state")).hits, []);
    x.damage(1);
    await new Promise(r => setTimeout(r));
    assert.deepEqual((await call("state")).hits.map(h => h.kind).sort(), ["read", "write"]);
  }
});

test("multi-memory: uninstrumented instances list only reachable memories", async () => {
  const { ctx, regs } = page();
  ctx.cetusLib.instrument = () => { throw new Error("boom"); };
  await ctx.WebAssembly.instantiate(buildGame({ multimem: true }));
  assert.deepEqual(plain(regs[0].memories.map(m => m.index)), [0]);
  const plainRegs = page();
  await plainRegs.ctx.WebAssembly.instantiate(buildGame({ multimem: true }));
  assert.deepEqual(plain(plainRegs.regs[0].memories.map(m => m.index)), [0, 1]);
  assert.equal(plainRegs.regs[0].memory, plainRegs.regs[0].instance.exports.memory);
  const hidden = page();
  hidden.ctx.cetusLib.instrument = () => { throw new Error("boom"); };
  const { instance } = await hidden.ctx.WebAssembly.instantiate(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 5, 5, 2, 0, 1, 0, 1, 7, 6, 1, 2, 0x6d, 0x31, 2, 1]));
  assert.deepEqual(plain([hidden.regs[0].memories.map(m => [m.index, m.memory === instance.exports.m1]), hidden.regs[0].memory === instance.exports.m1]), [[[0, true]], true]);
});

const optRuntime = (body, callbacks) => runtime(c => c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: L.encode({ type: "config", body }) })), callbacks);
const originalBody = index => {
  const b = buildGame(), m = page().ctx.cetusLib.scan(b), rd = p => L.leb.readU32(b, p);
  let p = 8;
  while (b[p] !== 10) p = rd(p + 1)[1] + rd(p + 1)[0];
  let [n, r] = rd(rd(p + 1)[1]);
  for (let k = m.funcImports; n--; k++) {
    const [size, s] = rd(r);
    let [locals, t] = rd(s);
    while (locals--) t = rd(t)[1] + 1;
    if (k === index) return [...b.subarray(t, s + size)];
    r = s + size;
  }
};

test("function original returns the unpatched body in running index space", async () => {
  const { call } = await runtime(), f = await call("function", { index: 16, original: true });
  assert.equal(disassemble(f.bytes).text, "call 8\ndrop\nreturn_call 8\nend");
  assert.deepEqual(Object.keys(f.env.funcs), ["8"]);
  assert.deepEqual(plain(f.env.funcs[8]), { params: [], results: ["i32"] });
  assert.deepEqual(originalBody(14), [0x10, 6, 0x1a, 0x12, 6, 0x0b]);
  const bare = await runtime(c => { c.cetusLib.instrument = () => { throw new Error("off"); }; });
  assert.equal(disassemble((await bare.call("function", { index: 14, original: true })).bytes).text, "call 6\ndrop\nreturn_call 6\nend");
  assert.deepEqual(await bare.call("canonPatch", { index: 14, bytes: [0x10, 6, 0x0b] }), { index: 14, bytes: [0x10, 6, 0x0b] });
});

test("canonPatch strips every instrumentation sequence into original index space", async () => {
  const funcs = [...Array(17).keys()], trace = funcs.map(i => i + 2);
  for (const opts of [{}, { coverage: true, trace, globalWatch: [1] }, { coverage: true, trace, globalWatch: [1], precise: true }]) {
    const { call } = await optRuntime({ instrumentOptions: opts });
    for (const index of funcs) {
      const c = await call("canonPatch", { index: index + 2, bytes: (await call("function", { index: index + 2 })).bytes });
      assert.equal(c.index, index);
      if (!opts.precise) assert.deepEqual(c.bytes, originalBody(index), `${JSON.stringify(opts)} ${index}`);
      else assert.doesNotMatch(disassemble(c.bytes).text, /call (1[89]|[2-9]\d)|global\.[gs]et ([6-9]|\d\d)/, `${index}`);
    }
    const tail = await call("canonPatch", { index: 16, bytes: (await call("function", { index: 16, original: true })).bytes });
    assert.deepEqual(tail, { index: 14, bytes: originalBody(14) });
    await assert.rejects(call("canonPatch", { index: 4, bytes: [0x10, 0, 0x0b] }), /instrumentation function 0/);
    await assert.rejects(call("canonPatch", { index: 4, bytes: [0xd2, 19, 0x0b] }), /instrumentation function 19/);
    await assert.rejects(call("canonPatch", { index: 1, bytes: [0x0b] }), /instrumentation function 1/);
    await assert.rejects(call("canonPatch", { index: 4, bytes: [0x23, 40, 0x1a, 0x0b] }), /instrumentation global 40/);
    await assert.rejects(call("canonPatch", { index: 4, bytes: [0x0b, 300] }), /Invalid byte/);
  }
});

test("canonical NOP patches survive precise and global watch option changes", async () => {
  for (const precise of [false, true]) {
    const { call } = await optRuntime({ instrumentOptions: { precise } }), f = await call("function", { index: 4 }), lines = disassemble(f.bytes).text.split("\n");
    const i = lines.findIndex(l => precise ? /^call /.test(l) && (t => t?.params.length === 4 && !t.results.length)(f.env.funcs[l.split(" ")[1]]) : /^i32\.store /.test(l));
    const bytes = [...assemble([...lines.slice(0, i), L.nop(lines[i], f.env), ...lines.slice(i + 1)].join("\n"))];
    const c = await call("canonPatch", { index: 4, bytes });
    for (const on of [false, true]) {
      const { x, meta } = instr({ precise: on, patches: [{ ...c, space: "original" }] });
      x.damage(30);
      assert.equal(x.getHealth(), 100, `saved precise ${precise}, loaded ${on}`);
      assert.ok(meta.sites.some(s => s.func === 4));
    }
    const { ctx, regs } = page({ patches: [{ ...c, space: "original" }], instrumentOptions: { precise: !precise } });
    const { instance } = await ctx.WebAssembly.instantiate(buildGame());
    instance.exports.damage(30);
    assert.deepEqual([regs[0].instrumented, regs[0].error, instance.exports.getHealth()], [true, null, 100]);
  }
  const { call } = await optRuntime({ instrumentOptions: { globalWatch: [1] } }), f = await call("function", { index: 17 });
  const bytes = [...assemble(disassemble(f.bytes).text.replace("i32.const 1\n", "i32.const 5\n"))];
  const c = await call("canonPatch", { index: 17, bytes });
  assert.deepEqual(c, { index: 15, bytes: [0x23, 1, 0x41, 5, 0x6a, 0x24, 1, 0x0b] });
  const { x, meta } = instr({ patches: [{ ...c, space: "original" }] });
  x.bumpLevel();
  assert.deepEqual(plain([x.level.value, meta.options.globalWatch]), [8, []]);
});

test("canonical patches apply uninstrumented when instrumentation fails, legacy ones only when instrumented", async () => {
  const magic = { index: 6, bytes: [...assemble("i32.const 999\nend")], space: "original" }, lives = { index: 7, bytes: [0x41, 7, 0x0b] };
  const boom = { processor: ["processor.addInstructionParser(0x0b, () => { throw new Error('bad load'); })"], preinstantiate: [] };
  const off = await optRuntime({ patches: [magic, lives], callbacks: boom });
  const st = (await off.call("state")).instances[0];
  assert.deepEqual([st.instrumented, off.x.magic(), off.x.callMagic(), off.x.getLives(), off.x.__cetus_watch], [false, 999, 999, 3, undefined]);
  assert.match(st.error, /bad load/);
  assert.equal(disassemble((await off.call("function", { index: 6 })).bytes).text, "i32.const 999\nend");
  assert.equal(disassemble((await off.call("function", { index: 6, original: true })).bytes).text, "i32.const 240\ni32.extend8_s\nend");
  const on = await optRuntime({ patches: [magic, lives] });
  assert.deepEqual([(await on.call("state")).instances[0].instrumented, on.x.magic(), on.x.getLives()], [true, 999, 7]);
  assert.equal(disassemble((await on.call("function", { index: 8, original: true })).bytes).text, "i32.const 240\ni32.extend8_s\nend");
  const bad = await optRuntime({ patches: [magic, { index: 5, bytes: [0xff], space: "original" }] });
  const b = (await bad.call("state")).instances[0];
  assert.deepEqual([b.instrumented, bad.x.magic()], [false, -16]);
  assert.match(b.error, /patched module failed/);
  const missing = i => ({ index: i, bytes: [0x0b], space: "original" });
  const { meta } = instr({ patches: [magic, missing(99), missing(17)] });
  const skipped = i => `Patch for function ${i} skipped: no such function`;
  assert.deepEqual(plain(meta.warnings), [skipped(99), skipped(17)]);
});

test("assembler accepts leading local declarations and disassembles them back", () => {
  const b = assemble("local i32 (ref null func) funcref (ref 5) (ref null 0x6f) f64\nlocal.get 1\ndrop\nend");
  assert.deepEqual([[...b], [...b.locals]], [[0x20, 1, 0x1a, 0x0b], ["i32", "(ref null func)", "funcref", "(ref 5)", "(ref null 111)", "f64"]]);
  assert.equal(disassemble(b).text, "local i32 (ref null func) funcref (ref 5) (ref null 111) f64\nlocal.get 1\ndrop\nend");
  assert.deepEqual(disassemble(b).lines[0], { offset: -1, text: "local i32 (ref null func) funcref (ref 5) (ref null 111) f64" });
  assert.deepEqual([[...assemble("nop\nend").locals], disassemble([0x0b]).text, disassemble([0x0b], ["i64"]).text], [[], "end", "local i64\nend"]);
  assert.throws(() => assemble("nop\nlocal i32\nend"), e => e instanceof AsmError && e.line === 2 && /before the first instruction/.test(e.message));
  assert.throws(() => assemble("local i33\nend"), e => e.line === 1 && /Invalid type/.test(e.message));
  assert.throws(() => assemble("local\nend"), /Missing operand/);
  assert.throws(() => assemble("local i32\nlocal f64\nend"), e => e.line === 2 && /single line/.test(e.message));
});

test("patch scratch locals are appended after the original declarations and instrument", async () => {
  const text = disassemble((await (await runtime()).call("function", { index: 4, original: true })).bytes).text;
  const src = `local i32\nlocal.get 0\ni32.const 2\ni32.mul\nlocal.set 1\n${text.replace("local.get 0", "local.get 1")}`, b = assemble(src);
  const { call } = await runtime(), c = await call("canonPatch", { index: 4, bytes: [...b], locals: b.locals });
  const ob = originalBody(2);
  assert.deepEqual(plain(c), { index: 2, bytes: [0x20, 0, 0x41, 2, 0x6c, 0x21, 1, ...ob.with(ob.indexOf(0x20) + 1, 1)], locals: ["i32"] });
  const patch = { ...c, space: "original" };
  for (const opts of [{}, { precise: true, coverage: true, trace: [4] }]) {
    const { x, meta } = instr({ ...opts, patches: [patch] });
    assert.ok(WebAssembly.validate(meta.bytes) && WebAssembly.validate(meta.patched));
    x.damage(10);
    assert.equal(x.getHealth(), 80, JSON.stringify(opts));
    assert.ok(meta.sites.some(s => s.func === 4));
  }
  const on = await optRuntime({ patches: [patch] }), f = await on.call("function", { index: 4 });
  on.x.damage(10);
  assert.deepEqual(plain([on.x.getHealth(), f.locals, f.added, (await on.call("function", { index: 4, original: true })).added]), [80, [[1, "i32"]], ["i32"], []]);
  const again = assemble(disassemble(f.bytes, f.added).text);
  assert.deepEqual(plain(await on.call("canonPatch", { index: 4, bytes: [...again], locals: again.locals })), plain(c));
  const boom = { processor: ["processor.addInstructionParser(0x0b, () => { throw new Error('off'); })"], preinstantiate: [] }, off = await optRuntime({ patches: [patch], callbacks: boom });
  off.x.damage(10);
  assert.deepEqual(plain([(await off.call("state")).instances[0].instrumented, off.x.getHealth(), (await off.call("function", { index: 2 })).added]), [false, 80, ["i32"]]);
  const many = instr({ patches: [{ ...patch, locals: ["i32", "i32", "f64", "(ref null func)"] }] });
  const m = new WebAssembly.Instance(new WebAssembly.Module(many.meta.patched), {}).exports;
  m.damage(5);
  many.x.damage(5);
  assert.deepEqual([m.getHealth(), many.x.getHealth()], [90, 90]);
  const bad = await optRuntime({ patches: [{ ...patch, locals: ["i33"] }] }), st = (await bad.call("state")).instances[0];
  assert.deepEqual([st.instrumented, /Invalid local type: i33/.test(st.error)], [false, true]);
});

test("patches without locals splice byte-identically", () => {
  const game = buildGame(), body = originalBody(2);
  for (const extra of [{}, { locals: [] }, { locals: null }]) {
    assert.deepEqual([...instr({ patches: [{ index: 2, bytes: body, space: "original", ...extra }] }, game).meta.patched], [...game]);
  }
});

test("WAIL walks every assembler stream on instruction boundaries", () => {
  const [Parser, Reader] = vm.runInContext("[WailParser, BufferReader]", loadPage(PAGE)), w = new Parser();
  assert.ok(STREAMS.length > 1500);
  for (const b of STREAMS) {
    const r = new Reader(Uint8Array.from(b)), offs = [];
    for (; r.inPos < b.length; w._readInstruction(r)) offs.push(r.inPos);
    assert.deepEqual(offs, disassemble(b).lines.map(l => l.offset), String(b));
  }
});

const gcModule = ({ types, imports = [], funcs, tables = [], tags = [], globals = [], elems = [], data = [], mems = [[0, 1]] }) => {
  const sec = (id, items) => items.length ? wasmSec(id, wasmVec(items)) : [], str = s => wasmVec([...Buffer.from(s)]);
  const base = imports.filter(x => x[2] === 0).length, body = f => [...wasmVec(f.locals ?? []), ...f.code, 0x0b];
  const exports = [...funcs.map((f, i) => [...str(f.name), 0, base + i]), ...tags.map((t, i) => [...str(`t${i}`), 4, i])];
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...sec(1, types),
    ...sec(2, imports.map(([m, f, kind, ...d]) => [...str(m), ...str(f), kind, ...d])),
    ...sec(3, funcs.map(f => [f.type])),
    ...sec(4, tables), ...sec(5, mems), ...sec(13, tags.map(t => [0, t])), ...sec(6, globals), ...sec(7, exports),
    ...sec(9, elems), ...data.length ? wasmSec(12, L.leb.u32(data.length)) : [],
    ...sec(10, funcs.map(f => [...L.leb.u32(body(f).length), ...body(f)])), ...sec(11, data)]);
};
const FT = (params, results) => ({ params, results }), I32T = FT([], ["i32"]);
const ALL_GC = [
  0x41, 1, 0x41, 2, 0xfb, 0, 0, 0x21, 0, 0xfb, 1, 0, 0x1a,
  0x20, 0, 0xfb, 2, 0, 0, 0x21, 4, 0x20, 0, 0xfb, 3, 0, 1, 0x1a, 0x20, 0, 0xfb, 4, 0, 1, 0x1a,
  0x20, 0, 0x41, 5, 0xfb, 5, 0, 0, 0x41, 7, 0x41, 4, 0xfb, 6, 1, 0x21, 1, 0x41, 3, 0xfb, 7, 1, 0x1a,
  0x41, 1, 0x41, 2, 0xfb, 8, 1, 2, 0x1a, 0x41, 0, 0x41, 2, 0xfb, 9, 1, 0, 0x1a,
  0x41, 0, 0x41, 1, 0xfb, 10, 2, 0, 0x21, 2, 0x20, 2, 0x41, 0, 0xfb, 11, 2, 0x1a,
  0x20, 1, 0x41, 0, 0xfb, 12, 1, 0x1a, 0x20, 1, 0x41, 0, 0xfb, 13, 1, 0x1a,
  0x20, 1, 0x41, 0, 0x41, 9, 0xfb, 14, 1, 0x20, 1, 0xfb, 15, 0x1a, 0x20, 1, 0x41, 1, 0x41, 3, 0x41, 2, 0xfb, 16, 1,
  0x20, 1, 0x41, 0, 0x20, 1, 0x41, 1, 0x41, 2, 0xfb, 17, 1, 1,
  0x20, 1, 0x41, 0, 0x41, 0, 0x41, 1, 0xfb, 18, 1, 0, 0x20, 2, 0x41, 0, 0x41, 0, 0x41, 1, 0xfb, 19, 2, 0,
  ...[20, 21, 22, 23].flatMap(k => [0x20, 0, 0xfb, k, 0, 0x1a]), 0x20, 0, 0x21, 3,
  0x02, 0x63, 0, 0x20, 3, 0xfb, 24, 3, 0, 0x6e, 0, 0x1a, 0xd0, 0, 0x0b, 0x1a,
  0x02, 0x63, 0x6e, 0x20, 3, 0xfb, 25, 3, 0, 0x6e, 0, 0x1a, 0xd0, 0x6e, 0x0b, 0x1a,
  0xd0, 0x72, 0xfb, 26, 0x1a, 0x20, 3, 0xfb, 27, 0x1a, 0x41, 3, 0xfb, 28, 0xfb, 29, 0x1a,
  0x41, 3, 0xfb, 28, 0xfb, 30, 0x20, 4, 0x6a];
const GC_CASES = {
  "rec group with struct, array and func types": {
    types: [[0x60, 0, 1, 0x7f], [0x4e, 3, 0x50, 0, 0x5f, 1, 0x7f, 1, 0x5e, 0x78, 1, 0x60, 1, 0x7f, 1, 0x7f],
      [0x4f, 1, 1, 0x5f, 2, 0x7f, 1, 0x7e, 0]],
    sigs: [I32T, null, null, FT(["i32"], ["i32"]), null], want: 5, store: true,
    funcs: [{ name: "run", type: 3, code: [0x41, 0, 0x20, 0, 0xfb, 0, 1, 0xfb, 2, 1, 0, 0x36, 2, 0x80, 2, 0x20, 0] },
      { name: "probe", type: 0, code: [0x41, 5, 0x10, 0] }],
  },
  "typed-ref params, results, locals and globals": {
    types: [[0x5f, 1, 0x7f, 0], [0x60, 1, 0x63, 0, 1, 0x63, 0], [0x60, 0, 1, 0x7f], [0x60, 2, 0x64, 0, 0x7f, 1, 0x7f]],
    sigs: [null, FT(["(ref null 0)"], ["(ref null 0)"]), I32T, FT(["(ref 0)", "i32"], ["i32"])], want: 10,
    imports: [["env", "id", 0, 1], ["env", "tbl", 1, 0x63, 0x70, 0, 1], ["env", "ext", 3, 0x63, 0x6f, 0]],
    globals: [[0x63, 0, 1, 0xd0, 0, 0x0b], [0x64, 0, 0, 0x41, 9, 0xfb, 0, 0, 0x0b]],
    funcs: [{ name: "pass", type: 1, locals: [[1, 0x63, 0]], code: [0x20, 0, 0x21, 1, 0x20, 1, 0x10, 0] },
      { name: "sum", type: 3, code: [0x20, 0, 0xfb, 2, 0, 0, 0x20, 1, 0x6a] },
      { name: "run", type: 2, code: [0x23, 2, 0x24, 1, 0x23, 1, 0x10, 1, 0xd4, 0x41, 1, 0x10, 2] },
      { name: "probe", type: 2, code: [0x10, 3] }],
  },
  "GC and extended-const global initializers": {
    types: [[0x5f, 1, 0x7f, 0], [0x5e, 0x7f, 1], [0x60, 0, 1, 0x7f]], sigs: [null, null, I32T], want: 21,
    globals: [[0x64, 0, 0, 0x41, 7, 0xfb, 0, 0, 0x0b], [0x64, 1, 0, 0x41, 1, 0x41, 2, 0x41, 3, 0xfb, 8, 1, 3, 0x0b],
      [0x64, 0x6c, 0, 0x41, 5, 0xfb, 28, 0x0b], [0x7f, 0, 0x41, 2, 0x41, 3, 0x6c, 0x0b], [0x63, 0x6e, 0, 0x23, 0, 0x0b],
      [0x63, 0x6e, 0, 0xd0, 0x72, 0xfb, 26, 0x0b], [0x63, 0x6f, 0, 0x23, 0, 0xfb, 27, 0x0b]],
    elems: [[5, 0x63, 0x6c, 1, 0x41, 1, 0xfb, 28, 0x0b]],
    funcs: [{ name: "run", type: 2, code: [0x23, 0, 0xfb, 2, 0, 0, 0x23, 1, 0x41, 2, 0xfb, 11, 1, 0x6a,
      0x23, 2, 0xfb, 29, 0x6a, 0x23, 3, 0x6a] }, { name: "probe", type: 2, code: [0x10, 0] }],
  },
  "every 0xFB opcode": {
    types: [[0x5f, 2, 0x7f, 1, 0x78, 1], [0x5e, 0x78, 1], [0x5e, 0x70, 1], [0x60, 0, 1, 0x7f]],
    sigs: [null, null, null, I32T],
    elems: [[1, 0, 1, 0]], data: [[1, 4, 1, 2, 3, 4]], want: 4,
    funcs: [{ name: "run", type: 3, locals: [[1, 0x63, 0], [1, 0x63, 1], [1, 0x63, 2], [1, 0x6e], [1, 0x7f]],
      code: ALL_GC },
      { name: "probe", type: 3, code: [0x10, 0] }],
  },
  "call_ref, return_call_ref, ref.eq, ref.as_non_null, br_on_null, br_on_non_null and a ref.func table initializer": {
    types: [[0x60, 1, 0x7f, 1, 0x7f], [0x60, 0, 1, 0x7f]], sigs: [FT(["i32"], ["i32"]), I32T], want: 28,
    elems: [[3, 0, 1, 0]], tables: [[0x40, 0, 0x64, 0, 0, 1, 0xd2, 0, 0x0b]],
    funcs: [{ name: "inc", type: 0, code: [0x20, 0, 0x41, 1, 0x6a] },
      { name: "tail", type: 0, code: [0x20, 0, 0xd2, 0, 0x15, 0] },
      { name: "run", type: 1, locals: [[1, 0x63, 0]], code: [0x41, 1, 0xd2, 0, 0x14, 0,
        0x41, 1, 0xfb, 28, 0x41, 1, 0xfb, 28, 0xd3, 0x6a, 0x02, 0x40, 0xd0, 0, 0xd5, 0, 0x1a, 0x0b,
        0x02, 0x64, 0, 0xd2, 0, 0xd6, 0, 0x00, 0x0b, 0xd4, 0x21, 0, 0x41, 10, 0x20, 0, 0x14, 0, 0x6a,
        0x41, 5, 0x10, 1, 0x6a, 0x41, 7, 0x41, 0, 0x25, 0, 0x14, 0, 0x6a] },
      { name: "probe", type: 1, code: [0x10, 2] }],
  },
  "legacy exception handling with a tag section": {
    types: [[0x60, 1, 0x7f, 0], [0x60, 0, 1, 0x7f]], sigs: [FT(["i32"], []), I32T], tags: [0], want: 14,
    funcs: [{ name: "run", type: 1, code: [0x06, 0x7f, 0x41, 7, 0x08, 0, 0x07, 0, 0x19, 0x41, 0, 0x0b,
      0x06, 0x7f, 0x06, 0x40, 0x41, 3, 0x08, 0, 0x18, 0, 0x41, 0, 0x07, 0, 0x0b, 0x6a,
      0x06, 0x7f, 0x06, 0x40, 0x41, 4, 0x08, 0, 0x19, 0x09, 0, 0x0b, 0x41, 0, 0x07, 0, 0x0b, 0x6a] },
      { name: "probe", type: 1, code: [0x10, 0] }],
  },
  "try_table and throw_ref": {
    types: [[0x60, 1, 0x7f, 0], [0x60, 0, 1, 0x7f], [0x60, 0, 2, 0x7f, 0x69]], tags: [0], want: 11,
    sigs: [FT(["i32"], []), I32T, FT([], ["i32", "exnref"])],
    funcs: [{ name: "run", type: 1, locals: [[1, 0x69]], code: [
      0x02, 0x7f, 0x1f, 0x40, 1, 0, 0, 0, 0x41, 5, 0x08, 0, 0x0b, 0x41, 0, 0x0b,
      0x02, 0x69, 0x1f, 0x40, 1, 3, 0, 0x41, 6, 0x08, 0, 0x0b, 0x00, 0x0b, 0x21, 0,
      0x02, 2, 0x1f, 0x40, 1, 1, 0, 0, 0x20, 0, 0x0a, 0x0b, 0x00, 0x0b, 0x1a, 0x6a,
      0x02, 0x40, 0x1f, 0x40, 1, 2, 0, 0x41, 1, 0x08, 0, 0x0b, 0x0b] }, { name: "probe", type: 1, code: [0x10, 0] }],
  },
};

for (const [name, c] of Object.entries(GC_CASES)) test(`WasmGC, typed refs and EH instrument: ${name}`, () => {
  const bytes = gcModule(c), I = page().ctx.cetusLib, orig = I.scan(bytes), imp = orig.funcImports, n = c.funcs.length;
  const tbl = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
  const env = { env: { id: x => x, tbl, ext: new WebAssembly.Global({ value: "externref" }, null) } };
  const run = (b, extra = {}) => new WebAssembly.Instance(new WebAssembly.Module(b), { ...env, ...extra }).exports;
  const cetus = { __cetus: { read: () => {}, write: () => {} } }, both = x => [x.run(), x.probe()];
  assert.ok(WebAssembly.validate(bytes), name);
  assert.deepEqual(plain(orig.types), plain(c.sigs));
  const o = run(bytes), sig = orig.funcs.map(t => c.sigs[t]), helper = FT(["i32", "i32", "f64"], []);
  assert.equal(o.probe(), c.want);
  const all = { precise: true, coverage: true, trace: sig.map((_, i) => i + 2) };
  all.globalWatch = orig.globals.map((_, i) => i);
  const moved = Object.entries(orig.fn).map(([i, f]) => [String(+i + (+i < imp ? 0 : 2)), f]);
  for (const opts of [{}, all]) {
    const meta = I.instrument(bytes, opts), out = I.scan(meta.bytes), fns = Object.entries(out.fn);
    assert.ok(WebAssembly.validate(meta.bytes), JSON.stringify(opts));
    assert.deepEqual(fns.filter(([, f]) => !f.startsWith("__cetus")), moved);
    assert.deepEqual(plain(out.types.slice(0, c.sigs.length)), plain(c.sigs));
    assert.ok(out.types.length > c.sigs.length && out.types.slice(c.sigs.length).every(t => t));
    assert.deepEqual(plain(meta.types), plain([...sig.slice(0, imp), helper, helper, ...sig.slice(imp)]));
    assert.deepEqual(both(run(meta.bytes, cetus)), both(o));
  }
  if (c.store) {
    const hits = [], meta = I.instrument(bytes), write = s => hits.push([s, new Error().stack]);
    const x = run(meta.bytes, { __cetus: { read: () => {}, write } });
    x.__cetus_watch(0, 256, 4, 1);
    x.probe();
    assert.equal(hits.length, 1);
    assert.equal(caller({ stack: hits[0][1] }, meta.helpers), imp + 2);
  }
  const add = [...c.funcs.at(-1).code, 0x41, ...L.leb.s32(1000), 0x6a, 0x0b];
  const patch = { index: imp + n - 1, bytes: add, space: "original" };
  assert.equal(run(I.instrument(bytes, { patches: [patch] }).bytes, cetus).probe(), c.want + 1000);
  for (const fail of [false, true]) {
    const processor = fail ? ["processor.addInstructionParser(0x0b, () => { throw new Error('bad'); })"] : [];
    const { ctx, regs } = page({ patches: [patch], callbacks: { processor, preinstantiate: [] } });
    const x = new ctx.WebAssembly.Instance(new ctx.WebAssembly.Module(bytes), env).exports;
    assert.deepEqual([regs[0].instrumented, x.probe(), !x.__cetus_watch], [!fail, c.want + 1000, fail]);
  }
});

test("fixture gc variant has a rec group, a tag and gcHeal storing through try_table", () => {
  const game = buildGame({ gc: true }), I = page().ctx.cetusLib;
  assert.ok(WebAssembly.validate(game));
  assert.deepEqual(plain(I.scan(game).types.slice(6)), [FT([], []), null, null, FT(["i32"], [])]);
  const { meta, x, hits } = instr({}, game);
  assert.equal(meta.names.functions[18], "gcHeal");
  x.__cetus_watch(0, GAME.HEALTH, 4, 1);
  x.gcHeal(42);
  assert.deepEqual([x.getHealth(), hitList(hits)], [42, [[0, "write"]]]);
});

const memops = (a = 0x41) => {
  const at0 = [a, 0x80, 2], b = [0x41, 0x80, 2], t = 0xc0 - a;
  return [
    ["fill", [0x60, 1, 0x7f, 0], [...at0, 0x20, 0, a, 4, 0xfc, 11, 0]],
    ["astore", [0x60, 1, 0x7f, 0], [...at0, 0x20, 0, 0xfe, 0x17, 2, 0]],
    ["rmw", [0x60, 1, 0x7f, 1, 0x7f], [...at0, 0x20, 0, 0xfe, 0x1e, 2, 0]],
    ["cmpx", [0x60, 2, 0x7f, 0x7f, 1, 0x7f], [...at0, 0x20, 0, 0x20, 1, 0xfe, 0x48, 2, 0]],
    ["lanestore", [0x60, 1, 0x7f, 0], [...at0, 0x20, 0, 0xfd, 0x11, 0xfd, 0x5a, 2, 0, 0]],
    ["init", [0x60, 0, 0], [...at0, 0x41, 0, 0x41, 4, 0xfc, 8, 0, 0]],
    ["copyIn", [0x60, 0, 0], [...at0, a, 0x80, 6, a, 4, 0xfc, 10, 0, 0]],
    ["later", [0x60, 1, 0x7f, 0], [a, 0, 0x20, 0, 0x36, 0, 0x80, 6]],
    ["aload", [0x60, 0, 1, 0x7f], [...at0, 0xfe, 0x10, 2, 0]],
    ["laneload", [0x60, 0, 1, 0x7f], [...at0, 0xfd, 0x0c, ...Array(16).fill(0), 0xfd, 0x56, 2, 0, 1, 0xfd, 0x1b, 1]],
    ["copyOut", [0x60, 0, 0], [a, 0x80, 6, ...at0, a, 4, 0xfc, 10, 0, 0]],
    ["wait", [0x60, 0, 1, 0x7f], [...at0, 0x41, 0x39, 0x42, 0, 0xfe, 1, 2, 0]],
    ["aload64", [0x60, 0, 1, 0x7e], [...at0, 0xfe, 0x11, 3, 0]],
    ["fill1", [0x60, 0, 0], [...b, 0x41, 9, 0x41, 4, 0xfc, 11, 1]],
    ["copyTo1", [0x60, 0, 0], [...b, ...at0, 0x41, 4, 0xfc, 10, 1, 0]],
    ["astore1", [0x60, 0, 0], [...b, 0x41, 3, 0xfe, 0x17, 0x42, 1, 0]],
    ["fillAt", [0x60, 2, t, t, 0], [0x20, 0, 0x41, 0, 0x20, 1, 0xfc, 11, 0]],
  ];
};
const MEMOPS = memops();
const memModule = (a = 0x41) => gcModule({ types: memops(a).map(o => o[1]), mems: [[a === 0x42 ? 7 : 3, 1, 1], [0, 1]], data: [[1, 4, 1, 2, 3, 4]],
  funcs: memops(a).map(([name, , code], type) => ({ name, type, code })) });
const memRuntime = (precise, a) => runtime(c => c.dispatchEvent(new c.CustomEvent("cetusMsgOut",
  { detail: L.encode({ type: "config", body: { instrumentOptions: { precise } } }) })), undefined, memModule(a));
const memRun = (opts, a) => {
  const meta = page().ctx.cetusLib.instrument(memModule(a), opts), hits = [];
  const log = kind => (op, a) => hits.push({ slot: op, kind, a, stack: new Error().stack });
  const x = new WebAssembly.Instance(new WebAssembly.Module(meta.bytes), { __cetus: { read: log("read"), write: log("write") } }).exports;
  const fn = name => MEMOPS.findIndex(o => o[0] === name) + 2;
  const who = () => hits.splice(0).map(h => [h.slot, h.kind, caller(h, meta.helpers)]);
  return { meta, x, hits, fn, who };
};

test("bulk-memory, atomic and lane writes hit write watches in the writing function", () => {
  assert.ok(WebAssembly.validate(memModule()));
  for (const precise of [false, true]) {
    const { meta, x, fn, who } = memRun({ precise }), plainX = new WebAssembly.Instance(new WebAssembly.Module(memModule())).exports;
    assert.ok(WebAssembly.validate(meta.bytes));
    x.__cetus_watch(0, 0x100, 4, precise ? 4 : 1);
    const writes = [["fill", 5], ["astore", 6], ["rmw", 1], ["cmpx", 7, 8], ["lanestore", 9], ["init"], ["later", 0x55], ["copyIn"]];
    for (const [name, ...args] of writes) {
      assert.deepEqual([x[name](...args), x.later(0x55)], [plainX[name](...args), plainX.later(0x55)], name);
      assert.deepEqual(who(), name === "later" ? [] : [[0, "write", fn(name)]], `${precise} ${name}`);
    }
    assert.deepEqual([x.aload64(), x.laneload()], [plainX.aload64(), plainX.laneload()]);
    x.fill(5);
    x.fill(5);
    assert.deepEqual(who(), precise ? [[0, "write", fn("fill")], [0, "write", fn("fill")]] : [[0, "write", fn("fill")]]);
    for (const name of ["fill1", "copyTo1", "astore1", "aload", "laneload", "copyOut", "wait"]) x[name]();
    assert.deepEqual(who(), [], `${precise} other memory and reads`);
    assert.throws(() => x.fillAt(0x100, 0x10000), /out of bounds/);
    assert.throws(() => x.fillAt(0x100, -1), /out of bounds/);
    assert.deepEqual([who(), x.aload()], [[], 0x05050505]);
    x.fillAt(0x102, 1);
    assert.deepEqual(who(), [[0, "write", fn("fillAt")]]);
  }
});

test("atomic, lane and memory.copy source reads hit read watches", () => {
  for (const precise of [false, true]) {
    const { x, fn, who } = memRun({ precise });
    x.fill(5);
    x.__cetus_watch(1, 0x100, 4, 2);
    for (const name of ["aload", "laneload", "copyOut", "wait", "rmw", "cmpx", "copyTo1"]) {
      x[name](0, 0);
      assert.deepEqual(who(), [[1, "read", fn(name)]], `${precise} ${name}`);
    }
    for (const name of ["fill", "astore", "lanestore", "init", "copyIn", "later", "fill1", "astore1"]) x[name](0);
    assert.deepEqual(who(), [], `${precise} writes`);
    x.__cetus_watch(1, 0x104, 4, 2);
    x.aload();
    x.copyOut();
    assert.deepEqual(who(), []);
  }
});

test("bulk, atomic and lane accesses get sites that report accessed addresses", () => {
  for (const precise of [false, true]) {
    const { meta, x, fn, hits } = memRun({ precise }), siteOf = name => meta.sites.findIndex(s => s.func === fn(name));
    assert.ok(meta.sites.every(s => meta.bytes[s.offset] === 0x10));
    const cases = [["copyOut", [], precise ? [0x300, 0x100] : [0x100]], ["aload", [], [0x100]], ["laneload", [], [0x100]],
      ["fill", [1], precise ? [0x100] : null]];
    for (const [name, args, want] of cases) {
      const site = siteOf(name);
      assert.equal(site >= 0, want != null, `${precise} ${name}`);
      if (site < 0) continue;
      x.__cetus_arm(0, site);
      x[name](...args);
      x.later(1);
      assert.deepEqual(hits.splice(0).map(h => [h.slot, h.a]), want.map(a => [-1, a]), `${precise} ${name}`);
      x.__cetus_arm(0, -1);
    }
  }
});

test("canonPatch strips bulk, atomic and lane instrumentation back to the original bodies", async () => {
  for (const precise of [false, true]) {
    const { call } = await memRuntime(precise);
    for (const [i, [name, , code]] of MEMOPS.entries()) {
      const f = await call("function", { index: i + 2 });
      if (!/1$/.test(name)) assert.notDeepEqual(f.bytes, [...code, 0x0b], `${precise} ${name}`);
      const c = await call("canonPatch", { index: i + 2, bytes: f.bytes });
      assert.deepEqual(c, { index: i, bytes: [...code, 0x0b] }, `${precise} ${name}`);
    }
  }
});

test("runtime watch hits name the memory.fill and atomic store functions, precise same-value fills included", async () => {
  for (const precise of [false, true]) {
    const { call, x } = await memRuntime(precise);
    await call("watch", { address: 0x100, size: 4, kind: "write", enabled: true });
    for (const f of [() => x.fill(5), () => x.fill(5), () => x.later(1), () => x.astore(6), () => x.later(2)]) f();
    await new Promise(r => setTimeout(r));
    const hits = (await call("state")).hits.map(h => [h.last.stack[0].name, h.count, h.last.new]).sort();
    assert.deepEqual(hits, [["astore", 1, 6], ["fill", precise ? 2 : 1, 0x05050505]], String(precise));
  }
});

test("breakpoints call a helper before the instruction and keep function indices", () => {
  const bps = [{ func: 4, offset: 11 }, { func: 4, offset: 11, break: true }, { func: 4, offset: 3 },
    { func: 99, offset: 0 }, { func: 4 }, null];
  const warnings = [], ops = [], base = page().ctx.cetusLib.instrument(buildGame(), {});
  const opts = { breakpoints: bps, precise: true, coverage: true, warnings };
  const meta = page().ctx.cetusLib.instrument(buildGame(), opts);
  assert.ok(WebAssembly.validate(meta.bytes));
  const kept = [{ func: 4, offset: 11, break: true }, { func: 4, offset: 3 }, { func: 99, offset: 0 }];
  assert.deepEqual(plain(meta.options.breakpoints), kept);
  assert.deepEqual(warnings, ["Breakpoint skipped: function 4 has no instruction at offset 3"]);
  assert.deepEqual(plain(meta.fexports), plain(base.fexports));
  assert.ok(meta.bpHelpers.every(f => meta.helpers.includes(f)) && meta.bpHelpers.length === 3);
  const w = (op, a) => ops.push([op, a]);
  const x = new WebAssembly.Instance(new WebAssembly.Module(meta.bytes), { __cetus: { read: w, write: w } }).exports;
  x.damage(3);
  x.getHealth();
  assert.deepEqual([ops, x.getHealth()], [[[-5, 0]], 97]);
});

test("breakpoint hits count per call with a damage stack, map lines and strip from patches", async () => {
  const breakpoints = [{ func: 4, offset: 11 }, { func: 16, offset: 0 }];
  const { call, x, events } = await optRuntime({ instrumentOptions: { breakpoints } });
  for (let i = 1; i <= 3; i++) {
    x.damage(1);
    const [h] = (await call("state")).bpHits;
    const top = h.last.stack[0];
    assert.deepEqual([h.func, h.offset, h.name, h.count, top.func, top.name], [4, 11, "damage", i, 4, "damage"]);
  }
  assert.equal(x.getHealth(), 97);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(events.filter(e => e.type === "hits").at(-1).body.bpHits[0].count, 3);
  const f = await call("function", { index: 4 }), d = disassemble(f.bytes).lines;
  const at = f.map.find(([, o]) => o === 11)[0];
  assert.equal(f.bpCalls.length, 1);
  const k = d.findIndex(l => l.offset === f.bpCalls[0]);
  assert.match(d[k].text, /^call \d+$/);
  assert.equal(d[k + 1].offset, at);
  assert.match(d[k + 1].text, /^i32\.store /);
  assert.deepEqual(f.map.map(([, o]) => o), [0, 2, 4, 8, 10, 11, 15]);
  assert.deepEqual((await call("canonPatch", { index: 4, bytes: f.bytes })).bytes, originalBody(2));
  const tail = await call("function", { index: 16 }), rows = (await call("xrefs", { func: 8 })).rows;
  assert.equal(tail.bpCalls[0], 0);
  assert.deepEqual(rows.slice(0, 2).map(r => tail.bytes[r.offset - tail.bodyOffset]), [0x10, 0x12]);
  x.magicTail();
  assert.deepEqual((await call("state")).bpHits.map(h => [h.name, h.count]), [["damage", 3], ["magicTail", 1]]);
  assert.deepEqual(await call("breakpoint", { func: 4, offset: 11, break: true }).then(r => r.bpHits.length), 2);
  await assert.rejects(call("breakpoint", { func: 4, offset: 11, break: 1 }), /Invalid break/);
  await assert.rejects(call("breakpoint", { func: -1, offset: 11, break: true }), /Invalid function index/);
  const plainRun = await runtime();
  plainRun.x.damage(1);
  assert.deepEqual((await plainRun.call("state")).bpHits, []);
  assert.deepEqual((await plainRun.call("function", { index: 4 })).bpCalls, []);
});

test("worker breakpoint hits reach the main context and break toggles sync", async () => {
  const pre = `globalThis.posted = []; globalThis.BroadcastChannel = class {
    constructor() { globalThis.chan = this; } postMessage(m) { posted.push(m); } };`;
  const [w, m] = [`globalThis.cetusLib = { worker: "t" }; ${pre}`, pre].map(p => loadPage(RUNTIME, { pre: p }));
  const cfg = L.encode({ type: "config", body: { instrumentOptions: { breakpoints: [{ func: 4, offset: 11 }] } } });
  for (const c of [w, m]) c.dispatchEvent(new c.CustomEvent("cetusMsgOut", { detail: cfg }));
  (await w.WebAssembly.instantiate(buildGame())).instance.exports.damage(1);
  const post = w.posted.find(p => p.t === "hit");
  assert.deepEqual([post.op, plain(post.bp), post.st[0].name], [-5, { func: 4, offset: 11 }, "damage"]);
  await m.WebAssembly.instantiate(buildGame());
  await m.cetusLib.handle("breakpoint", { func: 4, offset: 11, break: false });
  const sync = m.posted.findLast(p => p.t === "sync");
  assert.deepEqual(plain(sync.bps), [["4:11", false]]);
  m.chan.onmessage({ data: { ...post, tok: sync.tok } });
  const [h] = (await m.cetusLib.handle("state", {})).bpHits;
  assert.deepEqual([h.func, h.offset, h.name, h.count, h.last.stack[0].name], [4, 11, "damage", 1, "damage"]);
});

test("script onHit receives watch, access, global and breakpoint hits until stopped", async () => {
  const instrumentOptions = { breakpoints: [{ func: 4, offset: 11 }], globalWatch: [1] };
  const { call, x, events } = await optRuntime({ instrumentOptions });
  const code = "cetus.onHit(h => cetus.log(h.kind, h.func, h.offset, h.name, "
    + "h.slot ?? h.bp?.offset ?? h.global ?? h.last.address))";
  await call("script", { name: "hits", code, enabled: true });
  await call("watch", { address: GAME.HEALTH, size: 4, kind: "read", enabled: true });
  x.damage(1);
  const logs = () => events.filter(e => e.type === "scriptLog").splice(0).map(e => e.body.text);
  const read = (await call("state")).hits[0];
  assert.deepEqual(logs(), [`read 4 ${read.offset} damage 0`, "breakpoint 4 11 damage 11"]);
  events.length = 0;
  await call("accesses", { func: read.func, offset: read.offset, enabled: true });
  x.bumpLevel();
  x.damage(1);
  const gh = (await call("state")).globalHits[0];
  assert.deepEqual(logs(), [`global 17 ${gh.offset} bumpLevel 1`, `read 4 ${read.offset} damage 0`,
    `access 4 ${read.offset} damage ${GAME.HEALTH}`, "breakpoint 4 11 damage 11"]);
  events.length = 0;
  await call("script", { name: "hits", enabled: false });
  x.damage(1);
  assert.deepEqual(logs(), []);
  await call("script", { name: "bad", code: "cetus.onHit(() => { throw new Error('nope'); })", enabled: true });
  x.damage(1);
  x.damage(1);
  assert.deepEqual(events.filter(e => e.type === "scriptError").map(e => e.body.message), ["nope"]);
});

test("memCells splits a page into typed display cells", () => {
  const b = [0x64, 0, 0, 0, 0, 0, 0xc0, 0x3f, 0xde, 0xad, 0xbe, 0xef, 0xcd, 0xcc, 0xcc, 0x3d];
  assert.deepEqual(L.memCells(b, "u8").slice(0, 2).map(c => c.text), ["64", "00"]);
  assert.deepEqual(L.memCells(b, "i32").map(c => [c.offset, c.type, c.size, c.text]),
    [[0, "i32", 4, "100"], [4, "i32", 4, "1069547520"], [8, "i32", 4, "-272716322"], [12, "i32", 4, "1036831949"]]);
  assert.deepEqual(L.memCells(b, "f32").map(c => c.text), ["1.4e-43", "1.5", "-1.1802469e+29", "0.1"]);
  assert.deepEqual(L.memCells(b, "hex32").map(c => [c.type, c.text]).slice(2, 3), [["u32", "EFBEADDE"]]);
  assert.deepEqual(L.memCells(b, "u16").slice(0, 1).map(c => c.text), ["100"]);
  assert.deepEqual(L.memCells(b, "i16").slice(4, 5).map(c => c.text), ["-21026"]);
  assert.equal(L.memCells(b, "i64").length, 2);
  assert.equal(L.memCells(b, "f64")[0].text, String(new DataView(Uint8Array.from(b).buffer).getFloat64(0, true)));
  assert.equal(L.memCells(b.slice(0, 6), "i32").length, 1);
});

test("later configs refresh table and hotkeys for later instances without undoing hotkeys requests", async () => {
  const A = { combo: "Alt+A", action: "setSpeed", value: "2" }, B = { combo: "Alt+B", action: "setSpeed", value: "3" };
  const HP = { address: GAME.HEALTH, type: "i32" }, big = () => new WebAssembly.Memory({ initial: 3 });
  const body = (frozen, hotkeys) => ({ table: [{ ...HP, frozen, freezeValue: frozen ? "100" : null }], hotkeys });
  for (const again of [true, false]) {
    const { call, out, ctx } = await runtime(c => c.dispatchEvent(new c.CustomEvent("cetusMsgOut",
      { detail: L.encode({ type: "config", body: body(true, [A]) }) })));
    await tick(ctx);
    assert.deepEqual(plain((await call("state")).freezes.map(f => f.address)), [GAME.HEALTH]);
    await call("hotkeys", { bindings: [B] });
    await call("freeze", { ...HP, enabled: false });
    if (again) out({ type: "config", body: body(false, [B]) });
    await ctx.WebAssembly.instantiate(buildGame({ importMemory: true }), { env: { memory: big() } });
    await tick(ctx);
    const st = await call("state");
    assert.equal(st.active, st.instances[1].id);
    assert.deepEqual(plain(st.hotkeys), [B]);
    if (again) assert.ok(!st.freezes.some(f => f.address === GAME.HEALTH));
    await call("freeze", { ...HP, enabled: false });
  }
});

test("memory64: instrumented game validates, registers instrumented and reports write and read watches", async () => {
  const game = buildGame({ mem64: true }), I = page().ctx.cetusLib;
  assert.ok(WebAssembly.validate(game) && I.scan(game).mems[0].i64);
  for (const precise of [false, true]) {
    const meta = I.instrument(game, { precise, coverage: true, trace: [4], globalWatch: [1] });
    assert.ok(WebAssembly.validate(meta.bytes));
    assert.deepEqual(plain(meta.memory), { kind: "export", name: "memory", i64: true });
    assert.ok(meta.dataRanges.some(([a, b]) => a <= GAME.PTR && GAME.PTR + 8 <= b));
  }
  const { call, x } = await runtime(undefined, undefined, game), bytes = I.instrument(game).bytes, helpers = I.instrument(game).helpers;
  const st = await call("state");
  assert.deepEqual([st.instances[0].instrumented, st.instances[0].memory64, st.instances[0].memories[0].i64], [true, true, true]);
  await call("watch", { address: GAME.HEALTH, size: 4, kind: "write", enabled: true });
  x.damage(10);
  let [h] = (await call("state")).hits;
  assert.deepEqual([h.kind, h.func, h.name, h.last.old, h.last.new], ["write", 4, "damage", 100, 90]);
  assert.deepEqual([bytes[h.offset], bytes[h.offset + 1]], [0x10, helpers[1]]);
  await call("watch", { address: GAME.HEALTH, size: 4, kind: "write", enabled: false });
  await call("watch", { address: GAME.HEALTH, size: 4, kind: "read", enabled: true });
  x.getHealth();
  [h] = (await call("state")).hits;
  assert.deepEqual([h.kind, h.func, h.name, h.last.new], ["read", 2, "getHealth", 90]);
  assert.deepEqual([bytes[h.offset], bytes[h.offset + 1]], [0x10, helpers[0]]);
  x.getLives();
  x.readGold();
  assert.equal((await call("state")).hits[0].count, 1);
  const { rows } = await call("pointerScan", { address: GAME.HERO_HP, maxDepth: 2, maxOffset: 4096 });
  assert.ok(rows.some(p => p.base.kind === "static" && p.base.address === GAME.PTR && p.offsets.join() === "16"));
  const hp = async () => (await call("readValues", { items: [{ pointer: { base: { kind: "static", address: GAME.PTR }, offsets: [0x10] }, type: "i32" }] })).values[0];
  assert.equal(await hp(), 250);
  new DataView(x.memory.buffer).setUint32(GAME.PTR + 4, 1, true);
  assert.equal(await hp(), null);
  assert.ok(!(await call("pointerRescan", { address: GAME.HERO_HP })).rows.some(p => p.base.address === GAME.PTR));
});

test("memory64: bulk, atomic, lane and precise helpers take i64 addresses and hit watches and sites", () => {
  const plainX = new WebAssembly.Instance(new WebAssembly.Module(memModule(0x42))).exports;
  for (const precise of [false, true]) {
    const { meta, x, fn, who, hits } = memRun({ precise }, 0x42);
    assert.ok(WebAssembly.validate(meta.bytes));
    assert.deepEqual(plain(meta.memories.map(m => !!m.i64)), [true, false]);
    x.__cetus_watch(0, 0x100n, 4, precise ? 4 : 1);
    for (const [name, ...args] of [["fill", 5], ["astore", 6], ["rmw", 1], ["cmpx", 7, 8], ["lanestore", 9], ["init"], ["later", 0x55], ["copyIn"]]) {
      assert.deepEqual([x[name](...args), x.later(0x55)], [plainX[name](...args), plainX.later(0x55)], name);
      assert.deepEqual(who(), name === "later" ? [] : [[0, "write", fn(name)]], `${precise} ${name}`);
    }
    for (const name of ["fill1", "copyTo1", "astore1"]) x[name]();
    x.fill(5);
    assert.deepEqual(who(), [[0, "write", fn("fill")]]);
    assert.throws(() => x.fillAt(0x100n, 0x10000n), /out of bounds/);
    assert.throws(() => x.fillAt(0x100n, -1n), /out of bounds/);
    x.fillAt(0x102n, 1n);
    assert.deepEqual(who(), [[0, "write", fn("fillAt")]]);
    x.__cetus_watch(0, 0n, 0, 0);
    x.__cetus_watch(1, 0x100n, 4, 2);
    for (const name of ["aload", "laneload", "copyOut", "wait", "rmw", "cmpx", "copyTo1"]) {
      x[name](0, 0);
      assert.deepEqual(who(), [[1, "read", fn(name)]], `${precise} ${name}`);
    }
    x.__cetus_watch(1, 0n, 0, 0);
    const site = meta.sites.findIndex(s => s.func === fn("aload"));
    x.__cetus_arm(0, site);
    x.aload();
    assert.deepEqual(hits.splice(0).map(h => [h.slot, h.a]), [[-1, 0x100]]);
  }
});

test("memory64: canonPatch strips helper calls back to the original bodies", async () => {
  for (const precise of [false, true]) {
    const { call } = await memRuntime(precise, 0x42);
    for (const [i, [, , code]] of memops(0x42).entries()) {
      const f = await call("function", { index: i + 2 });
      assert.deepEqual(await call("canonPatch", { index: i + 2, bytes: f.bytes }), { index: i, bytes: [...code, 0x0b] });
    }
  }
});

test("watch and breakpoint conditions gate the break, and locals report params", async () => {
  const breakpoints = [{ func: 4, offset: 11, locals: true }];
  const { call, ctx, events, x } = await optRuntime({ instrumentOptions: { breakpoints } });
  const flag = "globalThis.broke = (globalThis.broke ?? 0) + 1";
  await call("watch", { address: GAME.HEALTH, size: 4, kind: "write", enabled: true, break: true,
    condition: `hit.new < 50 && (${flag}, true)` });
  assert.equal((await call("state")).watches[0].condition, `hit.new < 50 && (${flag}, true)`);
  x.damage(10);
  x.damage(45);
  const hitOf = async () => (await call("state")).hits[0];
  assert.deepEqual([(await hitOf()).count, ctx.broke], [2, 1]);
  assert.equal((await hitOf()).last.locals, undefined);
  const [bp] = (await call("state")).bpHits;
  assert.deepEqual([bp.func, bp.offset, bp.count, bp.last.locals], [4, 11, 2, [45]]);
  await call("watch", { address: GAME.HEALTH, size: 4, kind: "write", enabled: true, condition: "" });
  x.damage(1);
  assert.deepEqual([(await hitOf()).count, ctx.broke], [3, 1]);
  await call("breakpoint", { func: 4, offset: 11, break: true, condition: `hit.locals[0] === 7 && (globalThis.bp = hit.count, true)` });
  x.damage(1);
  assert.equal(ctx.bp, undefined);
  x.damage(7);
  assert.equal(ctx.bp, 2);
  await assert.rejects(call("breakpoint", { func: 4, offset: 11, break: true, condition: 5 }), /Invalid condition/);
});

test("a throwing break condition is reported once and never breaks", async () => {
  const { call, events, x } = await optRuntime({ instrumentOptions: { breakpoints: [{ func: 4, offset: 11 }] } });
  await call("breakpoint", { func: 4, offset: 11, break: true, condition: "nope()" });
  await call("watch", { address: GAME.HEALTH, size: 4, kind: "write", enabled: true, break: true, condition: "hit.new +" });
  x.damage(1);
  x.damage(1);
  const bad = events.filter(e => e.type === "scriptError");
  assert.deepEqual(bad.map(e => e.body.name), ["Condition 4:11", "Condition slot 0"]);
  assert.match(bad[0].body.message, /nope/);
  assert.deepEqual([(await call("state")).hits[0].count, (await call("state")).bpHits[0].count], [2, 2]);
});

test("step trace records the branches and calls of the last run of a function", async () => {
  const warnings = [];
  const meta = page().ctx.cetusLib.instrument(buildGame(), { stepTrace: [{ func: 16 }, { func: 11, max: 3 }, { func: 99 }], warnings });
  assert.ok(WebAssembly.validate(meta.bytes));
  assert.deepEqual(plain(meta.options.stepTrace), [{ func: 16, max: 1000 }, { func: 11, max: 3 }]);
  assert.deepEqual(warnings, ["Step trace skipped: no function 99"]);
  assert.ok(meta.helpers.length > page().ctx.cetusLib.instrument(buildGame(), {}).helpers.length);
  const stepTrace = [{ func: 16 }, { func: 11, max: 1 }];
  const { call, x } = await optRuntime({ instrumentOptions: { stepTrace } });
  assert.deepEqual(await call("stepTrace", { func: 16 }), { steps: [], truncated: false });
  x.magicTail();
  x.magicTail();
  assert.deepEqual(await call("stepTrace", { func: 16 }), { steps: [{ offset: 0 }, { offset: 3 }], truncated: false });
  x.callMagic();
  assert.deepEqual(await call("stepTrace", { func: 11 }), { steps: [{ offset: 2 }], truncated: true });
  const f = await call("function", { index: 16 });
  assert.deepEqual((await call("canonPatch", { index: 16, bytes: f.bytes })).bytes, originalBody(14));
  assert.deepEqual(f.map.map(([, o]) => o), [0, 2, 3, 5]);
  assert.equal(x.getHealth(), 100);
  await assert.rejects(call("stepTrace", { func: "x" }), /Invalid function index/);
});

test("step trace instruments GC, bulk, multi-memory and memory64 bodies", () => {
  const cases = [[{ gc: true }, 18, x => x.gcHeal(42), [[0, 18], [2, 18]]],
    [{ bulk: true }, 18, x => x.bulkFill(7), [[0, 18]]],
    [{ mem64: true }, 16, x => x.magicTail(), [[0, 16], [3, 16]]],
    [{ multimem: true }, 16, x => x.magicTail(), [[0, 16], [3, 16]]]];
  for (const [opts, func, run, want] of cases) {
    const ops = [], w = (op, a, b) => ops.push([op, a, b]);
    const meta = page().ctx.cetusLib.instrument(buildGame(opts), { stepTrace: [{ func }] });
    assert.ok(WebAssembly.validate(meta.bytes), JSON.stringify(opts));
    run(new WebAssembly.Instance(new WebAssembly.Module(meta.bytes), { __cetus: { read: w, write: w } }).exports);
    assert.deepEqual(ops.filter(o => o[0] === -7).map(o => o.slice(1)), want, JSON.stringify(opts));
  }
});
