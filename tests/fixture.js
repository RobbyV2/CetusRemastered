import http from "node:http";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const GAME = { HEALTH: 0x100, GOLD: 0x104, SPEED: 0x108, SCORE: 0x110, NEG: 0x118, NAME_UTF16: 0x200, NAME_ASCII: 0x220, SIG: 0x240, NAME_UTF8: 0x260, BE: 0x280,
  PTR: 0x300, HERO: 0x1000, HERO_HP: 0x1010, SIMD: 0x500 };

const uleb = n => { const o = []; do { const b = n & 0x7f; n >>>= 7; o.push(n ? b | 0x80 : b); } while (n); return o; };
const sleb = n => { const o = []; for (;;) { const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && b & 0x40)) return [...o, b]; o.push(b | 0x80); } };
const vec = items => [...uleb(items.length), ...items.flat()];
const str = s => vec([...Buffer.from(s)]);
const bytes = b => [...uleb(b.length), ...b];
const section = (id, b) => [id, ...bytes(b)];
const I32 = 0x7f, I64 = 0x7e, F32 = 0x7d, F64 = 0x7c;
const mem = off => [2, ...uleb(off)];

function gameData() {
  const u8 = new Uint8Array(0x208), dv = new DataView(u8.buffer), at = a => a - 0x100;
  dv.setInt32(at(GAME.HEALTH), 100, true);
  dv.setUint32(at(GAME.GOLD), 500, true);
  dv.setFloat32(at(GAME.SPEED), 1.5, true);
  dv.setBigInt64(at(GAME.SCORE), 1234567890123n, true);
  dv.setInt16(at(GAME.NEG), -5, true);
  u8.set(Buffer.from("Hero", "utf16le"), at(GAME.NAME_UTF16));
  u8.set(Buffer.from("PLAYER_ONE"), at(GAME.NAME_ASCII));
  u8.set([0xde, 0xad, 0xbe, 0xef, 0x13, 0x37], at(GAME.SIG));
  u8.set(Buffer.from("Héros"), at(GAME.NAME_UTF8));
  dv.setUint32(at(GAME.BE), 0x11223344);
  dv.setBigUint64(at(GAME.PTR), BigInt(GAME.HERO), true);
  return [...u8];
}

export function buildGame({ importMemory = false, shared = false, multimem = false, gc = false, bulk = false, mem64 = false } = {}) {
  const A = mem64 ? 0x42 : 0x41, types = [[[], [I32]], [[I32], []], [[F32], [I32]], [[], [I32, I32]], [[I32, I64, F32, F64], [F64]], [[I32], [I32]], [[], []]];
  const funcs = [
    ["getHealth", 0, [A, 0, 0x28, ...mem(GAME.HEALTH)]],
    ["setHealth", 1, [A, 0, 0x20, 0, 0x36, ...mem(GAME.HEALTH)]],
    ["damage", 1, [A, 0, A, 0, 0x28, ...mem(GAME.HEALTH), 0x20, 0, 0x6b, 0x36, ...mem(GAME.HEALTH)]],
    ["addGold", 1, [A, 0, A, 0, 0x28, ...mem(GAME.GOLD), 0x20, 0, 0x6a, 0x36, ...mem(GAME.GOLD)]],
    ["readGold", 0, [A, 0, 0x28, ...mem(GAME.GOLD)]],
    ["getLives", 0, [0x23, 0]],
    ["magic", 0, [0x41, ...sleb(0xf0), 0xc0]],
    ["truncSat", 2, [0x20, 0, 0xfc, 0x00]],
    ["pair", 3, [0x41, 1, 0x41, 2]],
    ["callMagic", 0, [0x41, 0, 0x11, 0, 0]],
    ["mix", 4, [0x20, 0, 0xb7, 0x20, 1, 0xb9, 0xa0, 0x20, 2, 0xbb, 0xa0, 0x20, 3, 0xa0]],
    ["sameStore", 6, [A, 0, A, 0, 0x28, ...mem(GAME.HEALTH), 0x36, ...mem(GAME.HEALTH)]],
    ["simdSet", 1, [A, 0, 0x20, 0, 0xfd, 0x11, 0xfd, 0x0b, 4, ...uleb(GAME.SIMD)]],
    ["secretBonus", 5, [0x20, 0, 0x41, ...sleb(1000), 0x6a], true],
    ["magicTail", 0, [0x10, 6, 0x1a, 0x12, 6]],
    ["bumpLevel", 6, [0x23, 1, 0x41, 1, 0x6a, 0x24, 1]],
    ...multimem ? [["peek2", 0, [0x41, 0, 0x28, 0x42, 1, ...uleb(GAME.HEALTH)]], ["poke2", 1, [0x41, 0, 0x20, 0, 0x36, 0x42, 1, ...uleb(GAME.HEALTH)]]] : [],
    ...gc ? [["gcHeal", 9, [A, 0, 0x02, I32, 0x1f, 0x40, 1, 0, 0, 0,
      0x20, 0, 0xfb, 0, 7, 0xfb, 2, 7, 0, 0x08, 0, 0x0b, 0x00, 0x0b, 0x36, ...mem(GAME.HEALTH)]]] : [],
    ...bulk ? [["bulkFill", 1, [A, ...sleb(GAME.HEALTH), 0x20, 0, A, 4, 0xfc, 11, 0]],
      ["atomicSet", 1, [A, 0, 0x20, 0, 0xfe, 0x17, 2, ...uleb(GAME.HEALTH)]]] : [],
    ["hiddenCalc", 5, [0x20, 0, 0x41, 3, 0x6c, 0x41, 7, 0x6a], true],
  ];
  const rec = gc ? [[0x4e, 3, 0x5f, 1, I32, 1, 0x5e, 0x78, 1, 0x60, 1, I32, 0]] : [];
  const memType = shared ? [mem64 ? 7 : 3, 1, 1] : [mem64 ? 4 : 0, 1], hero = new Uint8Array(0x20);
  new DataView(hero.buffer).setInt32(GAME.HERO_HP - GAME.HERO, 250, true);
  const out = [0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, vec([...types.map(([p, r]) => [0x60, ...vec(p), ...vec(r)]), ...rec])),
    ...(importMemory ? section(2, vec([[...str("env"), ...str("memory"), 2, ...memType]])) : []),
    ...section(3, vec(funcs.map(f => [f[1]]))),
    ...section(4, vec([[0x70, 0, 2]])),
    ...(importMemory && !multimem ? [] : section(5, vec([...importMemory ? [] : [memType], ...multimem ? [[0, 1]] : []]))),
    ...(gc ? section(13, vec([[0, 1]])) : []),
    ...section(6, vec([[I32, 1, 0x41, 3, 0x0b], [I32, 1, 0x41, 3, 0x0b], [F32, 1, 0x43, ...Buffer.from(new Float32Array([100]).buffer), 0x0b],
      [0x7b, 1, 0xfd, 0x0c, ...Array.from({ length: 16 }, (_, i) => i + 1), 0x0b], [0x70, 0, 0xd2, 13, 0x0b], [F64, 0, 0x44, ...Buffer.from(new Float64Array([9.5]).buffer), 0x0b]])),
    ...section(7, vec([
      ...funcs.flatMap(([name, , , hidden], i) => hidden ? [] : [[...str(name), 0, i]]),
      [...str("level"), 3, 1],
      [...str("ratio"), 3, 2],
      [...str("gravity"), 3, 5],
      [...str("tbl"), 1, 0],
      ...(importMemory ? [] : [[...str("memory"), 2, 0]]),
    ])),
    ...section(9, vec([[0, 0x41, 0, 0x0b, ...vec([[6], [13]])]])),
    ...section(12, uleb(multimem ? 4 : 3)),
    ...section(10, vec(funcs.map(f => bytes([0, ...f[2], 0x0b])))),
    ...section(11, vec([[0, A, ...sleb(GAME.HEALTH), 0x0b, ...bytes(gameData())], [0, A, ...sleb(GAME.HERO), 0x0b, ...bytes([...hero])], [1, ...str("cetus")], ...multimem ? [[2, 1, 0x41, ...sleb(GAME.HEALTH), 0x0b, ...bytes([0x2a])]] : []])),
    ...section(0, [...str("name"), ...section(1, vec(funcs.map(([name], i) => [...uleb(i), ...str(name)]))), ...section(7, vec([[0, ...str("lives")], [3, ...str("vec")]]))]),
  ];
  return new Uint8Array(out);
}

export const buildSecond = () => new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...section(5, vec([[0, 1]])), ...section(7, vec([[...str("memory"), 2, 0]])),
  ...section(11, vec([[0, 0x41, ...sleb(0x100), 0x0b, ...bytes([0x2a])]]))]);

const GAME_JS = `(() => {
  const q = new URLSearchParams(location.search), mode = q.get("load") || "instantiateStreaming", shared = location.pathname === "/threads";
  const env = shared || q.get("memory") === "import" ? { memory: new WebAssembly.Memory({ initial: 1, maximum: 1, shared }) } : {};
  const imports = { env }, start = performance.now(), flags = ["multimem", "gc", "bulk", "mem64"].map(k => q.get(k) ? "&" + k + "=1" : "").join("");
  const url = "/game.wasm?memory=" + (shared ? "shared" : q.get("memory") ?? "") + flags;
  const buf = () => fetch(url).then(r => r.arrayBuffer());
  const load = {
    instantiateStreaming: async () => (await WebAssembly.instantiateStreaming(fetch(url), imports)).instance,
    instantiate: async () => (await WebAssembly.instantiate(await buf(), imports)).instance,
    instantiateModule: async () => WebAssembly.instantiate(await WebAssembly.compile(await buf()), imports),
    compile: async () => new WebAssembly.Instance(await WebAssembly.compile(await buf()), imports),
    compileStreaming: async () => WebAssembly.instantiate(await WebAssembly.compileStreaming(fetch(url)), imports),
    module: async () => new WebAssembly.Instance(new WebAssembly.Module(await buf()), imports),
  }[mode];
  const game = window.game = { elapsed: () => performance.now() - start, js: { player: { hp: 77 } }, jsHit: n => game.js.player.hp -= n };
  const kind = q.get("worker") || "classic", spawn = () => kind === "worklet" ? (game.audio = new AudioContext()).audioWorklet.addModule("/worklet.js")
    : kind === "shared" ? new SharedWorker("/worker.js", "game").port : new Worker({ module: "/worker.mjs", nested: "/nest.js" }[kind] ?? "/worker.js", { type: kind === "module" ? "module" : "classic" });
  const workerDamage = n => new Promise(r => { game.worker.onmessage = e => r(e.data); game.worker.postMessage(n); });
  if (q.get("early")) game.early = spawn();
  if (q.get("interval")) game.ticks = 0, setInterval(() => game.ticks++, 20);
  game.workerNow = () => new Promise(r => {
    const w = game.early, f = e => typeof e.data === "number" && (w.removeEventListener("message", f), r(e.data));
    w.addEventListener("message", f);
    w.postMessage("now");
  });
  if (q.get("bare")) {
    game.worker = spawn();
    game.worker.postMessage({ url: "game.wasm" });
    const respawn = () => (game.worker.terminate(), game.worker = spawn(), game.worker.postMessage({ url: "game.wasm" }));
    return void Object.assign(game, { workerDamage, readHealth: () => workerDamage(0), respawn });
  }
  if (game.early?.postMessage) game.pong = new Promise(r => (game.early.addEventListener("message", e => e.data === "pong" && r(true)), game.early.start?.(), game.early.postMessage("ping")));
  game.ready = load().then(async inst => {
    const x = inst.exports, dv = () => new DataView((env.memory ?? x.memory).buffer);
    Object.assign(game, { raw: inst, readHealth: x.getHealth, setHealth: x.setHealth, damage: x.damage, addGold: x.addGold,
      readGold: x.readGold, getLives: x.getLives, level: () => x.level.value, ratio: () => x.ratio.value, magic: x.magic, mix: x.mix, bumpLevel: x.bumpLevel, peek2: x.peek2, poke2: x.poke2, sameStore: x.sameStore, simdSet: x.simdSet,
      gcHeal: x.gcHeal, bulkFill: x.bulkFill, atomicSet: x.atomicSet,
      relocate: () => { new Uint8Array(dv().buffer).copyWithin(0x2000, 0x1000, 0x1020); dv().setUint32(0x300, 0x2000, true); },
      readHeroHp: () => dv().getInt32(dv().getUint32(0x300, true) + 0x10, true),
      startWorker: async () => {
        const module = await WebAssembly.compileStreaming(fetch(url)), memory = env.memory;
        if (kind === "worklet") return void (await (game.early ?? spawn()), game.worker = new AudioWorkletNode(game.audio, "game", { processorOptions: { module, memory } }).port);
        game.worker = game.early ?? spawn();
        game.worker.postMessage(q.get("own") ? { url: "game.wasm" } : { module, memory });
      },
      workerDamage });
    if (q.get("second")) await WebAssembly.instantiate(await (await fetch("/second.wasm")).arrayBuffer());
    const loop = () => { x.getHealth(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    return game;
  });
})();`;

const WORKER_JS = `let ready, out = d => postMessage(d);
const on = ({ data }) => data === "ping" ? out("pong") : data === "now" ? out(performance.now()) : data === "close" ? close() : data?.module ? ready = WebAssembly.instantiate(data.module, { env: { memory: data.memory } }).then(i => i.exports)
  : data?.url ? ready = WebAssembly.instantiateStreaming(fetch(data.url)).then(r => r.instance.exports)
  : ready.then(x => { x.damage(data); out(x.getHealth()); });
self.onmessage = on;
self.onconnect = e => { const p = e.ports[0]; out = d => p.postMessage(d); p.onmessage = on; };`;

const NEST_JS = `const w = new Worker("worker.js");
onmessage = e => w.postMessage(e.data);
w.onmessage = e => postMessage(e.data);`;

const WORKLET_JS = `registerProcessor("game", class extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const { module, memory } = o.processorOptions, x = new WebAssembly.Instance(module, { env: { memory } }).exports;
    this.port.onmessage = ({ data }) => { x.damage(data); this.port.postMessage(x.getHealth()); };
  }
  process() { return true; }
});`;

const page = body => `<!doctype html><html><head><meta charset="utf-8"><title>Cetus Fixture</title></head><body>${body}</body></html>`;

export function serve(port = 0) {
  const wasm = q => (m => buildGame({ importMemory: ["import", "shared"].includes(m), shared: m === "shared",
    multimem: !!q.get("multimem"), gc: !!q.get("gc"), bulk: !!q.get("bulk"), mem64: !!q.get("mem64") }))(q.get("memory"));
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x"), send = (type, body, headers = {}) => { res.writeHead(200, { "Content-Type": type, ...headers }); res.end(body); };
    const game = page(`<h1>Fixture</h1><script src="/game.js"></script>`);
    if (u.pathname === "/") send("text/html", game);
    else if (u.pathname === "/csp") send("text/html", game, { "Content-Security-Policy": "script-src 'self' 'wasm-unsafe-eval'" });
    else if (u.pathname === "/threads") send("text/html", game, { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" });
    else if (u.pathname === "/worker.js") send("text/javascript", WORKER_JS);
    else if (u.pathname === "/worker.mjs") send("text/javascript", `${WORKER_JS}\nexport {};`);
    else if (u.pathname === "/nest.js") send("text/javascript", NEST_JS);
    else if (u.pathname === "/worklet.js") send("text/javascript", WORKLET_JS);
    else if (u.pathname === "/second.wasm") send("application/wasm", buildSecond());
    else if (u.pathname === "/plain") send("text/html", page("<h1>Plain</h1>"));
    else if (u.pathname === "/mixed") send("text/html", page(`<script src="/game.js"></script><iframe src="/?bare=1"></iframe>`));
    else if (u.pathname === "/frame") send("text/html", page(`<iframe src="/${u.search}"></iframe>`));
    else if (u.pathname === "/game.js") send("text/javascript", GAME_JS);
    else if (u.pathname === "/game.wasm") send("application/wasm", wasm(u.searchParams));
    else { res.writeHead(404); res.end(); }
  });
  return new Promise(resolve => server.listen(port, () => resolve({
    url: `http://localhost:${server.address().port}`,
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }),
  })));
}

export function loadPage(files, { url = "http://localhost/", pre = "" } = {}) {
  const et = new EventTarget();
  const ctx = vm.createContext({
    addEventListener: et.addEventListener.bind(et), removeEventListener: et.removeEventListener.bind(et), dispatchEvent: et.dispatchEvent.bind(et),
    CustomEvent, Event, EventTarget, location: new URL(url), console, performance, setTimeout, clearTimeout, setInterval, clearInterval,
    TextEncoder, TextDecoder, URL, URLSearchParams, fetch, Response,
    requestAnimationFrame: cb => setTimeout(() => cb(performance.now()), 16), cancelAnimationFrame: clearTimeout,
  });
  vm.runInContext("globalThis.window = globalThis.self = globalThis; globalThis.WebAssembly = WebAssembly", ctx);
  vm.runInContext(pre, ctx);
  for (const f of files) vm.runInContext(readFileSync(f, "utf8"), ctx, { filename: f });
  return ctx;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) serve(8765).then(s => console.log(s.url));
