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

const ui = {
    tabId: null,
    frameId: 0,
    memoryBytes: -1,
    worker: false,
    state: null,
    seq: 0,

    async request(type, body = {}) {
        const { tabId, frameId } = ui, msg = cetusLib.encode({ id: ++ui.seq, type, body });
        let r;
        try {
            r = chrome.tabs?.sendMessage ? await chrome.tabs.sendMessage(tabId, msg, { frameId }) : await chrome.runtime.sendMessage({ type: "relay", tabId, frameId, msg });
            if (typeof r !== "string") throw new Error(r?.relayError ?? "No response from the game frame");
        } catch (e) {
            ui.lock();
            throw e;
        }
        const m = cetusLib.decode(r);
        if (!m.ok) throw new Error(m.error);
        return m.body;
    },

    send(type, body) {
        return ui.request(type, body).catch(e => (ui.state && view.toast(e.message), null));
    },

    emit(type, detail = ui.state) {
        document.dispatchEvent(new CustomEvent(type, { detail }));
    },

    lock() {
        ui.state = null;
        view.render(null);
        ui.emit("cetus:reset");
    },

    async refresh() {
        const state = await ui.request("state").catch(() => null);
        if (!state?.instances.length) return ui.lock();
        ui.state = state;
        await ui.customTypes().catch(() => {});
        view.render(state);
        ui.emit("cetus:state");
    },

    site() {
        const a = ui.state?.instances.find(i => i.id === ui.state.active), url = a?.page ?? a?.url;
        return url ? cetusLib.siteKey(url) : null;
    },

    writes: Promise.resolve(),

    bySite(name, empty, update) {
        const run = async () => {
            const key = ui.site() ?? "", all = (await chrome.storage.local.get(name))[name] ?? {}, value = all[key] ?? empty;
            if (!update) return value;
            all[key] = await update(value);
            if (all[key] === undefined) delete all[key];
            await chrome.storage.local.set({ [name]: all });
            return all[key];
        };
        return update ? ui.writes = ui.writes.then(run, run) : run();
    },

    async table(update) {
        const list = await ui.bySite("cheatTables", [], update);
        if (update) ui.emit("cetus:table", list);
        return list;
    },

    options(update) {
        const d = { precise: false, trace: [], globalWatch: [], coverage: false, breakpoints: [], stepTrace: [] };
        return ui.bySite("instrumentOptions", d, update && (o => update({ ...d, ...o }))).then(o => ({ ...d, ...o }));
    },

    mem() {
        return ui.state?.instances.find(i => i.id === ui.state.active)?.memory ?? 0;
    },

    same(a, b) {
        return a.type === b.type && (a.memory ?? 0) === (b.memory ?? 0) && (a.pointer ? ui.canon(a.pointer) === ui.canon(b.pointer) : !b.pointer && a.address === b.address);
    },

    canon(v) {
        return JSON.stringify(v, (k, x) => x?.constructor === Object ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a < b ? -1 : 1)) : x);
    },

    globalFreezes(update) {
        return ui.bySite("globalFreezes", [], update);
    },

    async freezeGlobal(name, value, on) {
        const hash = ui.state?.instances.find(i => i.id === ui.state.active)?.hash ?? null, r = await ui.send("freeze", { global: name, value, enabled: on });
        if (!r) return null;
        ui.state.freezes = r.freezes;
        await ui.globalFreezes(l => [...l.filter(f => f.global !== name || on && f.hash !== hash), ...on ? [{ global: name, value, hash }] : []]);
        return r;
    },

    annotations(update) {
        return ui.bySite("annotations", { memory: [], code: [], structs: [] }, update);
    },

    async pointerScan(save) {
        const key = ui.site(), get = async () => (await chrome.storage.local.get("pointerScans")).pointerScans ?? {};
        if (key == null) return null;
        if (!save) return (s => s && { ...s, rows: s.rows.map(([b, ...offsets]) => ({ base: typeof b === "number" ? { kind: "static", address: b } : { kind: "global", name: b }, offsets })) })((await get())[key]);
        const run = async () => {
            let n = save.rows.length;
            const rows = save.rows.slice(0, 1e5).map(p => [p.base.kind === "static" ? p.base.address : p.base.name, ...p.offsets]);
            await chrome.storage.local.set({ pointerScans: { [key]: { ...save, rows }, ...Object.fromEntries(Object.entries(await get()).filter(([k, v]) => k !== key && (n += v.rows.length) <= 1e5)) } });
        };
        return ui.writes = ui.writes.then(run, run);
    },

    addEntries(entries, memory = ui.mem()) {
        const hash = ui.state?.instances.find(i => i.id === ui.state.active)?.hash;
        const at = ({ memory: m = memory, ...e }) => ({ ...e, ...e.pointer && { pointer: JSON.parse(ui.canon(e.pointer)) }, ...m && { memory: m } });
        if (hash) ui.bySite("tableHash", null, async h => (await ui.table()).length ? h : hash);
        return ui.table(l => entries.map(at).reduce((a, e) => a.some(x => ui.same(x, e)) ? a : [...a, e], l));
    },

    entry(e, patch) {
        return ui.table(l => l.map(x => ui.same(x, e) ? { ...x, ...patch } : x));
    },

    async hotkeys(update) {
        const list = await ui.bySite("hotkeys", [], update);
        if (update) await ui.send("hotkeys", { bindings: list, scripts: await ui.bySite("scripts", []) }), ui.emit("cetus:hotkeys", list);
        return list;
    },

    async scripts(update) {
        const list = await ui.bySite("scripts", [], update);
        if (update && ui.state) await ui.send("hotkeys", { bindings: await ui.bySite("hotkeys", []), scripts: list });
        if (update) ui.emit("cetus:scripts", list);
        return list;
    },

    async customTypes(update) {
        const check = async l => {
            const n = await update(l);
            try {
                cetusLib.customTypes(n);
                if (ui.state) await ui.request("customTypes", { types: n });
            } catch (e) { throw (cetusLib.customTypes(l), e); }
            return n;
        };
        const list = await ui.bySite("customTypes", [], update && check);
        cetusLib.customTypes(list);
        if (update) ui.emit("cetus:types", list);
        return list;
    },

    addEntry(entry) {
        return ui.addEntries([entry]);
    },

    patches(update) {
        const run = async () => {
            const { savedPatches = [] } = await chrome.storage.local.get("savedPatches");
            if (!update) return savedPatches;
            const list = update(savedPatches);
            await chrome.storage.local.set({ savedPatches: list });
            return list;
        };
        return update ? ui.writes = ui.writes.then(run, run) : run();
    },

    async savePatch(name, index, bytes, callbacks) {
        const url = ui.site();
        const c = await ui.request("canonPatch", { index, bytes: Array.from(bytes), locals: bytes.locals ?? [] });
        const fp = { index: c.index, bytes: Array.from(c.bytes), space: "original" };
        if (c.locals?.length) fp.locals = c.locals;
        const same = f => f.index === (f.space ? c.index : index);
        const withCb = p => callbacks ? ui.withCallbacks(p, callbacks) : p;
        return ui.patches(list => {
            const old = list.find(p => p.name === name && p.url === url);
            if (!old) return [...list, withCb({ name, url, enabled: true, version: 2, functionPatches: [fp] })];
            const { index: _, bytes: __, ...rest } = old;
            const legacy = { index: old.index, bytes: Object.values(old.bytes ?? []) };
            const prev = old.version ? old.functionPatches ?? [] : [legacy];
            const history = [...old.history ?? [], prev].slice(-10);
            const functionPatches = [...prev.filter(f => !same(f)), fp];
            return list.map(p => p === old ? withCb({ ...rest, version: 2, functionPatches, history }) : p);
        });
    },

    withCallbacks(p, callbacks) {
        const cb = Object.fromEntries(Object.entries(callbacks).filter(([, v]) => typeof v === "string" && v.trim()));
        const { callbacks: _, ...q } = p;
        return Object.keys(cb).length ? { ...q, callbacks: cb } : q;
    },

    saveCallbacks(name, url, callbacks) {
        return ui.patches(l => l.map(p => p.name === name && p.url === url ? ui.withCallbacks(p, callbacks) : p));
    },

    functionPatch(fp) {
        const space = fp?.space === "original" ? { space: "original" } : {};
        const ok = Array.isArray(fp?.locals) && fp.locals.length && fp.locals.every(t => typeof t === "string");
        const locals = ok ? { locals: [...fp.locals] } : {};
        return { index: fp?.index, bytes: Object.values(fp?.bytes ?? {}), ...space, ...locals };
    },

    revertPatch(p) {
        return ui.patches(l => l.map(q => q.name === p.name && q.url === p.url && q.history?.length ? { ...q, functionPatches: q.history.at(-1), history: q.history.slice(0, -1) } : q));
    },

    save(file, text, type) {
        const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type })), download: file });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },

    download(name, site, entries, patches, hotkeys = [], annotations, scripts, instrumentOptions, globalFreezes, customTypes = []) {
        const f = { format: "cetus-remastered", version: 2, site, entries, patches, hotkeys, annotations, scripts, instrumentOptions, globalFreezes,
            customTypes };
        ui.save(`${name}.cetus.json`, JSON.stringify(f, null, 2), "application/json");
    },

    fileName(site) {
        return site.replace(/[^\w.-]+/g, "_").replace(/_+$/, "") || "cetus";
    },

    async exportBundle() {
        const site = ui.site() ?? "";
        ui.download(ui.fileName(site), site, await ui.table(), (await ui.patches()).filter(p => p.url === site), await ui.hotkeys(), await ui.annotations(), await ui.scripts(), await ui.options(), await ui.globalFreezes(),
            await ui.customTypes());
    },

    async exportUserscript() {
        const site = ui.site() ?? "", [host, ...path] = site.split("/"), src = await chrome.runtime.sendMessage({ type: "src" });
        if (typeof src !== "string") throw new Error("Could not read the page scripts");
        const hotkeys = await ui.hotkeys(), scripts = await ui.scripts(), patches = (await ui.patches()).filter(p => p.url === site && p.enabled), cb = k => patches.map(p => p.callbacks?.[k]).filter(s => typeof s === "string");
        const table = await ui.table(), keys = f => hotkeys.filter(f).map(k => k.combo);
        const trainer = { title: `Cetus Remastered trainer for ${site}`,
            entries: table.map(({ description, address, pointer, type, length, group, options, mode, step, memory }) => ({ description, address, pointer, type,
                length, group, options, mode, step, memory, hotkeys: keys(k => [k.entry, ...k.entries ?? []].some(x => x && ui.same(x, { address, pointer, type, memory }))) })),
            scripts: scripts.map(({ name, code }) => ({ name, code, hotkeys: keys(k => k.action === "toggleScript" && k.script === name) })) };
        const body = { patches: patches.flatMap(p => (p.version ? p.functionPatches ?? [] : [p]).map(ui.functionPatch)),
            callbacks: { processor: cb("processor"), preinstantiate: cb("preinstantiate") }, instrumentOptions: await ui.options(),
            table: table.filter(e => e.frozen || e.watch?.length), hotkeys, scripts: scripts.filter(s => s.enabled), globals: await ui.globalFreezes(),
            hotkeyScripts: scripts.filter(s => hotkeys.some(k => k.action === "toggleScript" && k.script === s.name)),
            customTypes: await ui.customTypes(), trainer };
        const head = ["==UserScript==", `@name Cetus Remastered trainer for ${site}`, "@namespace cetus-remastered", "@version 1", `@match *://${host.replace(/:\d+$/, "")}/${path.join("/")}*`,
            "@run-at document-start", "@grant none", "==/UserScript=="].map(l => `// ${l}`).join("\n");
        const out = m => `dispatchEvent(new CustomEvent("cetusMsgOut", { detail: ${JSON.stringify(JSON.stringify(m))} }));\n`;
        ui.save(`${ui.fileName(site)}.user.js`, `${head}\n${src}\n;${out({ type: "config", body })}${out({ type: "workerSource", body: { src } })}`, "text/javascript");
    },

    async importBundle(text) {
        const f = JSON.parse(text), bundle = f?.format === "cetus-remastered";
        if (!bundle && (typeof f?.name !== "string" || typeof f.url !== "string")) throw new Error("Not a Cetus Remastered file");
        const arr = a => Array.isArray(a) ? a : [];
        const byte = b => Number.isInteger(b) && b >= 0 && b < 256;
        const patches = (bundle ? arr(f.patches) : [f]).filter(p => typeof p?.name === "string" && typeof p.url === "string")
            .map(({ name, url, enabled, callbacks, history, ...p }) => ({ name, url, enabled: !!enabled, version: 2,
                functionPatches: p.version ? arr(p.functionPatches).map(ui.functionPatch) : [ui.functionPatch(p)],
                ...callbacks && { callbacks }, ...history && { history } }))
            .filter(p => p.functionPatches.every(fp => Number.isInteger(fp.index) && fp.index >= 0 && fp.bytes.every(byte)));
        const old = cetusLib.customTypes(), okType = c => { try { return !!cetusLib.customTypes([c]).length; } catch { return false; } };
        const types = [...new Map((bundle ? arr(f.customTypes) : []).filter(okType)
            .map(({ name, size, decode, encode }) => [name, { name, size, decode, encode }])).values()];
        cetusLib.customTypes(old);
        const KEEP = ["group", "hex", "options", "frozen", "freezeValue", "mode", "step", "pointer", "memory"];
        const kinds = w => [...new Set([].concat(w))].filter(k => k === "write" || k === "read");
        const entries = (bundle ? arr(f.entries) : [])
            .filter(e => Number.isInteger(e?.address) && e.address >= 0 && (e.memory == null || Number.isInteger(e.memory) && e.memory >= 0))
            .filter(e => cetusLib.isType(e.type) || types.some(c => c.name === e.type))
            .map(({ description, address, type, length, ...e }) => ({ description: String(description ?? ""), address, type, ...(Number.isInteger(length) && length > 0 && { length }),
                ...Object.fromEntries(KEEP.filter(k => e[k] != null).map(k => [k, e[k]])), ...e.watch != null && { watch: kinds(e.watch) } }));
        const hotkeys = (bundle ? arr(f.hotkeys) : []).filter(h => typeof h?.combo === "string" && typeof h.action === "string");
        const scripts = (bundle ? arr(f.scripts) : []).filter(s => typeof s?.name === "string" && typeof s.code === "string").map(({ name, code, enabled }) => ({ name, code, enabled: !!enabled }));
        const globals = (bundle ? arr(f.globalFreezes) : []).filter(g => typeof g?.global === "string" && typeof g.value === "string")
            .map(({ global, value, hash, mode, step }) => ({ global, value, hash: typeof hash === "string" ? hash : null, ...typeof mode === "string" && { mode }, ...typeof step === "string" && { step } }));
        if ((scripts.length || types.length || patches.some(p => p.callbacks?.processor || p.callbacks?.preinstantiate)) && !confirm("This file contains JavaScript that will run on the game page. Import it?")) return;
        const same = (a, b) => a.name === b.name && a.url === b.url;
        if (types.length) await ui.customTypes(l => [...l.filter(c => !types.some(x => x.name === c.name)), ...types]);
        if (patches.length) await ui.patches(l => [...l.filter(q => !patches.some(p => same(p, q))), ...patches]);
        await ui.addEntries(entries, 0);
        if (hotkeys.length) await ui.hotkeys(l => [...l.filter(h => !hotkeys.some(k => k.combo === h.combo)), ...hotkeys]);
        if (globals.length) await ui.globalFreezes(l => [...l.filter(g => !globals.some(x => x.global === g.global && x.hash === g.hash)), ...globals]);
        if (scripts.length) await ui.scripts(l => [...l.filter(s => !scripts.some(x => x.name === s.name)), ...scripts]);
        const io = bundle && f.instrumentOptions;
        const ints = a => arr(a).filter(Number.isInteger);
        const bpOk = b => Number.isInteger(b?.func) && Number.isInteger(b.offset) && b.offset >= 0;
        const bps = arr(io?.breakpoints).filter(bpOk)
            .map(({ func, offset, break: k, locals: lo, condition: c }) => ({ func, offset, ...k === true && { break: true },
                ...lo === true && { locals: true }, ...typeof c === "string" && c.trim() && { condition: c.trim() } }));
        const opts = { precise: !!io?.precise, trace: ints(io?.trace), globalWatch: ints(io?.globalWatch) };
        const sps = arr(io?.stepTrace).filter(s => Number.isInteger(s?.func))
            .map(s => ({ func: s.func, max: Math.min(Math.max(Number.isInteger(s.max) ? s.max : 1000, 1), 10000) }));
        if (io) await ui.options(() => ({ ...opts, coverage: !!io.coverage, breakpoints: bps, stepTrace: sps }));
        const n = bundle && f.annotations, keys = { memory: m => `${m.memory ?? 0}:${m.address}`, code: c => `${c.func}:${c.offset}`, structs: s => s.name };
        if (n) await ui.annotations(o => Object.fromEntries(Object.entries(keys).map(([k, id]) => [k, [...arr(o[k]).filter(x => !arr(n[k]).some(y => id(y) === id(x))), ...arr(n[k])]])));
    },

    async open() {
        const q = new URLSearchParams(location.search);
        ui.tabId = Number(q.get("tabId")) || chrome.devtools?.inspectedWindow.tabId || (await chrome.tabs?.query({ active: true, currentWindow: true }))?.[0]?.id;
        const key = `frame:${ui.tabId}`, f = (await chrome.storage.session.get(key))[key];
        if (f) [ui.frameId, ui.memoryBytes, ui.worker] = [f.frameId, f.memoryBytes, !!f.worker];
        await ui.refresh();
    },
};

chrome.runtime.onMessage.addListener((msg, sender) => {
    let m;
    try { m = cetusLib.decode(msg); } catch { return; }
    if (sender.tab?.id !== ui.tabId) return;
    if (m.type === "init") {
        const w = !!m.body?.instance?.worker, mem = m.body?.instance?.memoryBytes ?? 0, here = sender.frameId === ui.frameId;
        if (here && (w || !ui.worker)) ui.memoryBytes = Math.max(ui.memoryBytes, mem);
        else if (here || (w ? ui.memoryBytes < 0 || ui.worker && !ui.state : ui.worker || mem >= ui.memoryBytes || !ui.state)) {
            [ui.frameId, ui.memoryBytes, ui.worker] = [sender.frameId, mem, w];
        } else return;
        ui.refresh();
    } else if (sender.frameId !== ui.frameId) return;
    else if ((m.type === "hits" || m.type === "accesses") && ui.state) {
        ui.state[m.type] = m.body[m.type];
        if (m.type === "hits") [ui.state.globalHits, ui.state.bpHits] = [m.body.globalHits ?? [], m.body.bpHits ?? []];
        ui.emit(`cetus:${m.type}`);
    } else if (m.type === "traces") ui.emit("cetus:traces", m.body.calls);
    else if (m.type === "hotkey" && m.body?.error != null) ui.emit("cetus:hotkeyError", m.body);
    else if (m.type === "hotkey" && typeof m.body?.script === "string") ui.scripts(l => l.map(s => s.name === m.body.script ? { ...s, enabled: !!m.body.enabled } : s)).then(ui.refresh);
    else if (m.type === "hotkey" && m.body?.count != null)
        ui.refresh().then(() => ui.state?.scan && ui.emit("cetus:scanHotkey"));
    else if (m.type === "hotkey" || m.type === "command" || m.type === "instances") ui.refresh();
    else if (m.type === "scriptLog" || m.type === "scriptError") ui.emit(`cetus:${m.type}`, m.body);
    else if (m.type === "reset") {
        [ui.memoryBytes, ui.worker] = [-1, false];
        ui.lock();
    }
});

ui.open();
