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

const el = id => document.getElementById(id), L = cetusLib;
const OPS = { eq: "Equal to", ne: "Not equal to", lt: "Less than", lte: "Less or equal", gt: "Greater than", gte: "Greater or equal",
    unknown: "Unknown initial value", changed: "Changed", unchanged: "Unchanged", increased: "Increased", decreased: "Decreased", between: "Between",
    incBy: "Increased by", decBy: "Decreased by", incPct: "Increased by at least %", decPct: "Decreased by at least %" };
const HK_ENTRY = ["toggleFreeze", "set", "inc", "dec", "freeze", "unfreeze"], TEXT = ["ascii", "utf16", "utf8", "aob", "binary"], VALUED = ["eq", "ne", "lt", "lte", "gt", "gte", "between", "incBy", "decBy", "incPct", "decPct"];
const commit = (input, f) => {
    let seen;
    const run = () => (seen = input.value, f());
    return Object.assign(input, { onchange: run, onfocus: () => seen = input.value, onkeydown: e => void (e.key === "Enter" && input.value === seen && run()) });
};
const fmt = (v, t, hex = false) => v == null ? "?" : L.formatValue(v, t, hex).replace(/^0x0+(?=.)/, "0x");
const types = () => [...L.TYPES, ...L.customTypes().map(c => c.name)], nums = () => types().filter(L.isNum);
const NUM = L.TYPES.slice(0, 10), hx = n => fmt(n, "u32", true), addr = v => /^(0x[0-9a-f]+|\d+)$/i.test(v.trim()) ? Number(v) : null;
const chain = p => p.offsets.reduce((s, o, i) => `${i ? `[${s}]` : s} ${o < 0 ? "-" : "+"} ${hx(Math.abs(o))}`, p.base.kind === "static" ? `[${hx(p.base.address)}]` : p.base.name);
const unchain = s => {
    const m = /^(.+?)\s*([+-])\s*(0x[0-9a-f]+|\d+)$/i.exec(s.trim()), b = m && /^\[(.+)\]$/.exec(m[1].trim())?.[1].trim();
    if (!m || b == null && (addr(m[1]) != null || /[[\]]/.test(m[1]))) throw new RangeError("Invalid address or pointer");
    const p = b == null ? { base: { kind: "global", name: m[1].trim() }, offsets: [] } : addr(b) != null ? { base: { kind: "static", address: addr(b) }, offsets: [] } : unchain(b);
    p.offsets.push(Number(m[3]) * (m[2] === "-" ? -1 : 1));
    return p;
};
const hexBytes = s => (h => /^([0-9a-f]{2})+$/i.test(h) ? h.match(/../g).map(x => parseInt(x, 16)) : null)(s.replace(/0x|[\s,]/gi, ""));
const locate = s => (a => a != null ? { address: a } : { pointer: unchain(s) })(addr(s));
const key = e => JSON.stringify([e.pointer ?? e.address, e.type, e.memory ?? 0]);
const loc = e => ({ address: e.address, pointer: e.pointer, type: e.type, memory: e.memory ?? 0 });
const ident = x => ({ ...x.pointer ? { pointer: x.pointer } : { address: x.address }, type: x.type, ...x.memory && { memory: x.memory } });
const frozenIn = e => !!ui.state?.freezes.some(f => ui.same(f, e));
const watching = (e, kind) => !e.memory && !!ui.state?.watches.some(w => w.kind === kind && (e.pointer ? JSON.stringify(w.pointer) === JSON.stringify(e.pointer) : !w.pointer && w.address === e.address));
const MODS = ["Ctrl", "Alt", "Shift", "Meta"], mod = x => MODS.find(k => k.toLowerCase() === x.toLowerCase());
const where = e => e.pointer ? chain(e.pointer) : L.toHex(e.address), memNote = e => e.memory ? `, memory ${e.memory}` : "";
const norm = s => (p => [...MODS.filter(k => p.some(x => mod(x) === k)), ...p.filter(x => !mod(x)).map(x => x.length === 1 ? x.toUpperCase() : x)].join("+"))(s.split("+").map(x => x.trim()).filter(Boolean));
const ptrType = () => (a => a?.memories?.find(m => m.index === a.memory)?.i64 ? "u64" : "u32")(ui.state?.instances.find(i => i.id === ui.state.active));
const STR = ["ascii", "utf16", "utf8"], width = f => f.type === "ptr" ? L.sizeOf(ptrType()) : STR.includes(f.type) ? f.length ?? 4 : L.sizeOf(f.type);
const len = (t, v) => t === "ascii" ? v.length : t === "utf16" ? v.length * 2 : t === "utf8" ? L.toBytes(v, t).length : t === "aob" || t === "binary" ? v.split(" ").length : undefined;
const num = (s, what) => {
    if (!s.trim()) return undefined;
    if (Number.isFinite(+s) && +s >= 0) return +s;
    throw new RangeError(`Invalid ${what}`);
};
const readAll = list => Promise.all(Array.from({ length: Math.ceil(list.length / 500) }, (_, i) => list.slice(i * 500, i * 500 + 500))
    .map(c => ui.request("readValues", { items: c }).then(r => r.values, () => c.map(() => undefined)))).then(r => r.flat());
const kindsOf = e => [...new Set([].concat(e.watch ?? []))];
const tableEdit = () => el("table").querySelector("input:not([type=checkbox]):focus, select:focus");

const view = {
    toastTimer: null,
    errTimer: null,
    scanning: false,
    fn: null,

    toast(message) {
        const t = el("errorToast");
        t.textContent = message;
        t.hidden = false;
        clearTimeout(view.toastTimer);
        view.toastTimer = setTimeout(() => t.hidden = true, 5000);
    },

    render(state) {
        const a = state?.instances.find(i => i.id === state.active), sel = el("instanceSelect"), list = state?.instances ?? [];
        sel.replaceChildren(...list.map(i => new Option(`${i.worker ? "Worker" : "Instance"} ${i.id}: ${i.url} (${i.memoryBytes / 1024} KiB)`, i.id)));
        Object.assign(sel, { value: a?.id ?? "", hidden: list.length < 2 });
        const ms = a?.memories ?? [], mem = el("memorySelect");
        mem.replaceChildren(...ms.map(m => new Option(`Memory ${m.index} (${m.bytes / 1024} KiB${m.shared ? ", shared" : ""})`, m.index)));
        Object.assign(mem, { value: a?.memory ?? "", hidden: ms.length < 2 });
        el("lockOverlay").hidden = !!a;
        el("instanceHeader").textContent = !a ? "No WebAssembly instance" :
            `${a.worker ? "Worker instance" : "Instance"} ${a.id} of ${state.instances.length}, ${a.memoryBytes / 1024} KiB memory, ` + (a.instrumented ? "instrumented" : `not instrumented: ${a.error}`);
    },

    fillCompare() {
        const t = el("searchType").value, c = el("searchCompare"), old = c.value, keys = Object.keys(OPS);
        const ops = t === "group" ? view.scanning ? ["eq", "changed", "unchanged"] : ["eq"] : TEXT.includes(t) ? ["eq"] : view.scanning ? keys.filter(k => k !== "unknown") : [...keys.slice(0, t === "all" ? 6 : 7), "between"];
        c.replaceChildren(...ops.map(o => new Option(OPS[o], o)));
        c.value = ops.includes(old) ? old : "eq";
        view.syncSearch();
    },

    syncSearch() {
        const op = el("searchCompare").value, t = el("searchType").value;
        el("searchToleranceField").hidden = el("searchRoundingField").hidden = !L.isFloat(t);
        el("searchParam").disabled = !VALUED.includes(op);
        el("searchValue2Field").hidden = op !== "between";
        el("searchBaseField").hidden = !view.scanning;
        el("searchCaseField").hidden = !STR.includes(t);
        el("searchGroupHint").hidden = t !== "group";
        el("scanUndo").disabled = el("scanSave").disabled = !view.scanning;
        el("scanSaveRow").hidden = !view.scanning;
        el("searchType").disabled = view.scanning;
        el("searchButton").textContent = view.scanning ? "Next Scan" : "First Scan";
        el("restartBtn").disabled = !view.scanning;
    },

    clearScan() {
        view.scanning = false;
        el("resultsTitle").textContent = "";
        el("results").replaceChildren();
        view.selectable("results", 0);
        view.pager("results", 0, 0, 0);
        view.savedBase([]);
        view.fillCompare();
    },

    savedBase(names) {
        const b = el("searchBase"), old = b.value;
        b.replaceChildren(new Option("Previous scan", "previous"), new Option("First scan", "first"), ...names.map(n => new Option(`Saved: ${n}`, `saved:${n}`)));
        b.value = [...b.options].some(o => o.value === old) ? old : "previous";
    },

    pager(id, offset, n, count) {
        view[`${id}Offset`] = offset;
        el(`${id}Page`).textContent = count ? `${offset + 1}-${offset + n} of ${count}` : "";
        el(`${id}Prev`).disabled = offset <= 0;
        el(`${id}Next`).disabled = offset + n >= count;
    },

    scanPage(r, offset) {
        const type = el("searchType").value;
        el("resultsTitle").textContent = `Found ${r.count}`;
        view.pager("results", offset, r.rows.length, r.count);
        view.results("results", ["Address", ...type === "all" ? ["Type"] : [], "Value", "Previous"], r.rows.map(row => (({ address, value, previous, type: t = type }) =>
            ({ address, type: t, length: len(t, previous), live: 1 + (type === "all"), cells: [...type === "all" ? [t] : [], fmt(value, t), fmt(previous, t)], ...row.elements && { group: row.group, entries: view.groupEntries(row) } }))(row)));
    },

    groupEntries({ address, group, elements }) {
        return elements.map(({ offset, type, size }) => ({ description: `+${hx(offset)}`, address: address + offset, type, group: `${group} @ ${hx(address)}`, ...TEXT.includes(type) && { length: size } }));
    },

    pick(entry) {
        const cb = Object.assign(document.createElement("input"), { type: "checkbox", className: "select-row", title: "Select" });
        view.picks.set(cb, entry);
        return cb;
    },

    picks: new WeakMap(),

    selectable(id, n) {
        const all = Object.assign(document.createElement("input"), { type: "checkbox", className: "select-all", title: "Select all" });
        all.onchange = () => { for (const cb of el(id).querySelectorAll(".select-row")) cb.checked = all.checked; };
        el(id).querySelector("thead tr")?.cells[0].replaceChildren(all);
        for (const b of ["AddSelected", "AddAll"]) el(`${id === "stringResults" ? "strResults" : id}${b}`).disabled = !n;
    },

    async addRows(entries) {
        if (!entries?.length) return view.toast("No rows to add");
        await ui.addEntries(entries.flat().map(({ address, type, length, pointer, group, memory, description = "" }) => pointer ? view.ptrEntry(pointer) : { description, address, type, ...length && { length }, ...group && { group }, ...memory != null && { memory } }));
    },

    async allRows(id) {
        if (id === "ptrResults") return view.ptrFiltered().slice(0, 500).map(pointer => ({ pointer }));
        if (id === "results") {
            const r = await ui.send("scanRows", { offset: 0, limit: 500 }), type = el("searchType").value;
            return r?.rows.map(row => row.elements ? view.groupEntries(row) : (({ address, previous, type: t = type }) => ({ address, type: t, length: len(t, previous) }))(row));
        }
        const out = [], enc = view.strBody?.encoding, memory = view.strBody?.memory;
        for (let r; view.strBody && out.length < 500 && (r = await ui.send("strings", { ...view.strBody, offset: out.length })) && r.rows.length;)
            out.push(...r.rows.slice(0, 500 - out.length).map(({ address, text }) => ({ address, type: enc, length: len(enc, text), memory })));
        return out;
    },

    async scanBusy(f) {
        for (const id of ["searchButton", "restartBtn", "scanUndo", "scanSave", "searchType"]) el(id).disabled = true;
        try { return await f(); } finally { el("searchButton").disabled = false; view.syncSearch(); }
    },

    async scanRows(offset) {
        const r = await ui.send("scanRows", { offset: Math.max(0, offset), limit: 100 });
        if (r) view.scanPage(r, Math.max(0, offset));
    },

    strBody: null,

    async strings(offset) {
        const r = view.strBody && await ui.send("strings", { ...view.strBody, offset: Math.max(0, offset) }), enc = view.strBody?.encoding;
        if (!r) return;
        el("strResultsTitle").textContent = `Found ${r.count}${view.strBody.memory ? ` in memory ${view.strBody.memory}` : ""}`;
        view.pager("strResults", Math.max(0, offset), r.rows.length, r.count);
        view.results("stringResults", ["Address", "Text"], r.rows.map(({ address, text }) => ({ address, type: enc, length: len(enc, text), memory: view.strBody.memory, cells: [text] })));
    },

    results(id, head, rows) {
        const table = document.createElement("table");
        table.createTHead().insertRow().append(...["", ...head, ""].map(h => Object.assign(document.createElement("td"), { textContent: h })));
        const body = table.createTBody();
        for (const r of rows) {
            const tr = body.insertRow(), entry = r.entries ?? { description: "", address: r.address, type: r.type, ...(r.length && { length: r.length }), ...r.memory != null && { memory: r.memory } };
            Object.assign(tr.dataset, { address: r.address, type: r.type, length: r.length ?? "", ...r.group && { groupText: r.group }, ...r.memory != null && { memory: r.memory } });
            tr.insertCell().append(view.pick(entry));
            [L.toHex(r.address), ...r.cells].forEach((c, i) => Object.assign(tr.insertCell(), { textContent: c, className: i === (r.live ?? 1) ? "live" : "" }));
            const b = Object.assign(document.createElement("button"), { className: "add-entry", textContent: "+", title: "Add to table" });
            b.onclick = () => view.addRows([entry]);
            tr.insertCell().append(b);
        }
        el(id).replaceChildren(table);
        view.selectable(id, rows.length);
    },

    async openFunction(index, moduleOffset, exact, orig) {
        changeTab("Patch");
        const [r, notes] = await Promise.all([ui.send("function", { index }), ui.annotations()]);
        if (!r) return;
        let d;
        try { d = L.disassemble(r.bytes, r.added ?? []); } catch (err) { return view.toast(err.message); }
        if (r.added === null) view.toast("Original bytes unavailable: scratch locals hidden, re-saving drops them");
        const f = view.fns.find(x => x.index === index), cm = new Map((notes.code ?? []).filter(c => c.func === index).map(c => [c.offset, c.comment]));
        [view.fn, view.fnLines, view.fnRun, view.fnMap] = [r, d.lines, d.lines, d.lines.map((_, k) => k)];
        el("functionInput").value = index;
        const locals = (r.locals ?? []).map(([c, t]) => c > 1 ? `${t} x${c}` : t).join(", ");
        const title = `Function ${index}${f?.name ? `: ${f.name}` : ""}${f ? ` ${view.sig(f)}` : ""}`;
        el("functionTitle").textContent = title + (locals ? ` [locals: ${locals}]` : "");
        const opts = await ui.options();
        Object.assign(document.querySelector(".fn-trace"), { disabled: false, checked: opts.trace.includes(index) });
        Object.assign(document.querySelector(".fn-steptrace"),
            { disabled: false, checked: opts.stepTrace.some(s => s.func === index) });
        el("asmError").hidden = true;
        const at = !orig ? moduleOffset - r.bodyOffset
            : r.map ? r.map.find(([, o]) => o === moduleOffset)?.[0] ?? -1 : moduleOffset;
        const ls = d.lines, x = ls.findIndex(l => l.offset === at);
        const mem = /\.(load|store)|memory\.(fill|copy|init)|atomic\.(rmw|wait)/, call = x > 0 && /^\s*call /.test(ls[x].text) && /^\s*i32\.const/.test(ls[x - 1].text);
        const line = x >= 0 && r.bpCalls?.includes(at) ? x + 1
            : exact ? ls.findLastIndex(l => l.offset <= at)
            : call ? x + mem.test(ls[x + 1]?.text)
            : ls.findLastIndex(l => mem.test(l.text) && l.offset <= at);
        view.setCode(ls.map(l => cm.has(l.offset) ? `${l.text} ;; ${cm.get(l.offset)}` : l.text).join("\n"), line);
        el("xrefsButton").disabled = false;
        view.codeAccesses();
        view.stepLog();
        return true;
    },

    back: [],

    async jump(index, offset, exact, from) {
        const cur = view.fn && { index: view.fn.index, offset: from };
        if (await view.openFunction(index, offset, exact) && cur) view.back.push(cur);
        el("codeBack").disabled = !view.back.length;
    },

    async xrefs(body, label) {
        changeTab("Patch");
        const r = await ui.send("xrefs", body);
        if (!r) return;
        el("xrefResultsTitle").textContent = `${label}: ${r.rows.length} reference${r.rows.length === 1 ? "" : "s"}`;
        const rows = view.grid("xrefResults", ["Function", "Name", "Offset", "Reference"], r.rows.map(x => ({ data: x.func == null ? {} : { func: x.func, offset: x.offset },
            cells: [["", x.func ?? ""], ["", x.name ?? ""], ["", x.offset == null ? "" : L.toHex(x.offset)], ["", x.text]] })));
        [...rows.rows].forEach((tr, i) => r.rows[i].func != null && (tr.onclick = () => view.jump(r.rows[i].func, r.rows[i].offset, true)));
    },

    setCode(text, line = -1) {
        const ta = el("codeDisassembly"), live = Prism.Live?.all.get(ta);
        ta.value = text;
        for (const n of [ta, live?.pre]) if (n) line < 0 ? delete n.dataset.line : n.dataset.line = line + 1;
        live?.update();
    },

    fns: [],
    fnLines: [],
    fnRun: [],
    fnMap: [],
    runLine: i => view.fnRun[view.fnMap[i] ?? -1],
    searching: null,

    sig(f) {
        return `(${f.params.join(", ")}) -> (${f.results.join(", ")})`;
    },

    async functions() {
        view.fns = (ui.state && (await ui.request("functions").catch(() => null))?.functions) ?? [];
        view.fnList();
        view.exportList();
    },

    fnList() {
        const q = el("functionFilter").value.trim().toLowerCase(), list = view.fns.filter(f => !q || String(f.index) === q || f.name?.toLowerCase().includes(q)).slice(0, 500);
        const body = view.grid("functionList", ["Index", "Name", "Signature", "Exported"], list.map(f => ({ data: { index: f.index },
            cells: [["", f.index], ["fn-name", f.name ?? ""], ["", view.sig(f)], ["", f.exported ? "yes" : f.imported ? "import" : ""]] })));
        [...body.rows].forEach((tr, i) => tr.onclick = () => view.openFunction(list[i].index));
    },

    exportList() {
        const q = el("exportsFilter").value.trim().toLowerCase(), list = view.fns.filter(f => !f.imported && (!q || String(f.index) === q || f.name?.toLowerCase().includes(q))).slice(0, 500);
        view.grid("exports", ["Index", "Name", "", "Arguments", "", "Result"], list.map(f => {
            const args = document.createElement("span"), res = document.createElement("span");
            args.append(...f.params.map(t => Object.assign(document.createElement("input"), { type: "text", placeholder: t })));
            const call = async () => {
                const vals = [...args.children].map(i => i.value.trim());
                try { vals.forEach((v, i) => NUM.includes(f.params[i]) && L.parseValue(v, f.params[i])); } catch (err) { return view.toast(err.message); }
                const r = await ui.send("call", { index: f.index, args: vals });
                if (r) res.textContent = r.results.map((v, i) => fmt(v, f.results[i])).join(", ") || "Done";
            };
            const btn = Object.assign(document.createElement("button"), { className: "fn-call", textContent: "Call" });
            btn.onclick = call;
            const cells = [["", f.index], ["", f.name ?? ""], ["fn-kind", f.internal ? "internal" : ""]];
            return { data: { index: f.index }, cells: [...cells, ["fn-args", args], ["", btn], ["fn-result", res]] };
        }));
    },

    async codeSearch() {
        if (view.searching) return view.searching = null;
        const q = el("codeSearchQuery").value.trim(), btn = el("codeSearchButton"), rows = [], names = new Map(view.fns.map(f => [f.index, f.name])), token = {};
        let re, count = 0;
        if (!q) return view.toast("Enter a search query");
        try { el("codeSearchMode").value === "aob" ? L.parseAob(q) : re = new RegExp(q, "i"); } catch (err) { return view.toast(err.message); }
        if (!re) return (r => r && view.codeResults(r.rows.map(x => ({ ...x, text: "" })), r.count))(await ui.send("codeSearch", { aob: q }));
        view.searching = token;
        btn.textContent = "Cancel";
        for (let from = 0, max = Math.max(-1, ...view.fns.map(f => f.index)); from <= max && view.searching === token; from += 200) {
            const r = await ui.send("functionBodies", { from, count: 200 });
            if (!r) break;
            for (const b of r.bodies) {
                let d;
                try { d = L.disassemble(b.bytes); } catch { continue; }
                for (const l of d.lines) if (re.test(l.text) && ++count <= 500) rows.push({ func: b.index, name: names.get(b.index), offset: b.bodyOffset + l.offset, text: l.text.trim() });
            }
            el("codeResultsTitle").textContent = `Searching, found ${count}`;
        }
        view.searching = null;
        btn.textContent = "Search code";
        view.codeResults(rows, count);
    },

    codeResults(rows, count) {
        el("codeResultsTitle").textContent = `Found ${count}`;
        const body = view.grid("codeResults", ["Function", "Name", "Offset", "Instruction"], rows.map(r => ({ data: { func: r.func, offset: r.offset },
            cells: [["", r.func], ["", r.name ?? ""], ["", L.toHex(r.offset)], ["", r.text]] })));
        [...body.rows].forEach((tr, i) => tr.onclick = () => view.openFunction(rows[i].func, rows[i].offset, true));
    },

    async template(kind) {
        const fn = view.fn, f = view.fns.find(x => x.index === fn?.index), v = kind === "return" ? el("patchTemplateValue").value.trim() || "0" : "0";
        if (!fn) return view.toast("Open a function first");
        if (kind === "original") {
            const r = await ui.send("function", { index: fn.index, original: true });
            try { return r && view.setCode(L.disassemble(r.bytes).text); } catch (err) { return view.toast(err.message); }
        }
        if (!f) return view.toast("Function signature is unknown");
        let consts;
        try { consts = f.results.map(t => NUM.includes(t) ? `${t}.const ${L.formatValue(L.parseValue(v, t), t)}` : (() => { throw 0; })()); } catch { return view.toast("Invalid value for this function"); }
        view.setCode([...consts, "end"].join("\n"));
    },

    modal(id, show) {
        el(id).classList.toggle("modal-hidden", !show);
    },

    async showPatches() {
        const site = ui.site(), list = (await ui.patches()).filter(p => !site || p.url === site), table = el("loadedPatchesTable");
        table.replaceChildren();
        table.createTHead().insertRow().append(...["On", "Name", "Functions", "", "", ""].map(h => Object.assign(document.createElement("th"), { textContent: h })));
        const body = table.createTBody(), same = (a, b) => a.name === b.name && a.url === b.url;
        const btn = (className, textContent, title, onclick) => Object.assign(document.createElement("button"), { className, textContent, title, onclick });
        for (const p of list) {
            const tr = body.insertRow(), cb = Object.assign(document.createElement("input"), { type: "checkbox", className: "patch-enable", checked: !!p.enabled });
            tr.dataset.name = p.name;
            tr.title = p.url;
            cb.onchange = () => ui.patches(l => l.map(q => same(q, p) ? { ...q, enabled: cb.checked } : q));
            tr.insertCell().append(cb);
            const name = Object.assign(tr.insertCell(), { textContent: p.name, className: "patch-name" });
            Object.assign(name, { title: "Edit callbacks", onclick: () => view.editPatch(p) });
            tr.insertCell().textContent = (p.version ? p.functionPatches ?? [] : [p]).map(f => f.index).join(", ");
            tr.insertCell().append(btn("patch-download", "\u2193", "Download", () => ui.download(p.name, p.url, [], [p])));
            tr.insertCell().append(Object.assign(btn("patch-revert", "\u21b6", "Revert to the previous version", async () => (await ui.revertPatch(p), view.showPatches())), { disabled: !p.history?.length }));
            tr.insertCell().append(btn("patch-remove", "\u00d7", "Remove", async () => (await ui.patches(l => l.filter(q => !same(q, p))), view.showPatches())));
        }
        view.modal("loadPatchModal", true);
    },

    editing: null,
    cbFrom: null,

    async savePatch() {
        if (view.cbFrom && el("patchName").value.trim() !== view.cbFrom) await view.patchCallbacks(true);
        const name = el("patchName").value.trim(), ed = view.editing;
        const callbacks = { processor: el("patchProcessor").value, preinstantiate: el("patchPreinstantiate").value };
        if (ed?.name === name) {
            await ui.saveCallbacks(name, ed.url, callbacks);
            return view.modal("savePatchModal", false);
        }
        if (!view.fn) return view.toast("Open a function first");
        if (!name) return view.toast("Enter a patch name");
        let bytes;
        try {
            bytes = L.assemble(el("codeDisassembly").value);
        } catch (err) {
            view.modal("savePatchModal", false);
            return Object.assign(el("asmError"), { hidden: false, textContent: err.line ? `Line ${err.line}: ${err.message}` : err.message });
        }
        el("asmError").hidden = true;
        try {
            await ui.savePatch(name, view.fn.index, bytes, callbacks);
        } catch (err) {
            return view.toast(err.message);
        }
        view.modal("savePatchModal", false);
    },

    async patchCallbacks(keep) {
        const p = (await ui.patches()).find(q => q.name === el("patchName").value.trim() && q.url === ui.site());
        if (!p && keep && !view.cbFrom) return;
        view.cbFrom = p?.name;
        el("patchProcessor").value = p?.callbacks?.processor ?? "";
        el("patchPreinstantiate").value = p?.callbacks?.preinstantiate ?? "";
    },

    async editPatch(p) {
        view.editing = p;
        el("patchName").value = p.name;
        await view.patchCallbacks();
        view.modal("loadPatchModal", false);
        view.modal("savePatchModal", true);
    },

    async nop() {
        const ta = el("codeDisassembly"), fn = view.fn, src = ta.value.split("\n"), code = s => s.replace(/;;.*/, "").trim();
        const i = ta.dataset.line ? ta.dataset.line - 1 : ta.value.slice(0, ta.selectionStart).split("\n").length - 1;
        if (!fn || !code(src[i] ?? "")) return view.toast("Open a function and select an instruction");
        const rep = L.nop(src[i], fn.env), text = rep && [...src.slice(0, i), rep, ...src.slice(i + 1)].join("\n");
        if (!rep) return view.toast("Cannot replace this instruction");
        let lines, bytes;
        try { [lines, bytes] = [L.disassemble(L.assemble(ta.value)).lines, L.assemble(text)]; } catch (err) { return view.toast(err.message); }
        const name = `nop ${fn.index}@${L.toHex(fn.bodyOffset + lines[src.slice(0, i).filter(code).length].offset)}`;
        try { await ui.savePatch(name, fn.index, bytes); } catch (err) { return view.toast(err.message); }
        view.fnLines = L.disassemble(bytes).lines;
        view.fnMap = [...view.fnMap.slice(0, i), ...rep.split("\n").map(() => -1), ...view.fnMap.slice(i + 1)];
        view.setCode(text, i);
        view.toast("Reload the game to apply");
    },

    collapsed: new Set(),
    tableDue: false,
    picked: new Set(),

    async stop(e) {
        const kinds = ["write", "read"].filter(k => watching(e, k));
        if (frozenIn(e)) (r => r && (ui.state.freezes = r.freezes))(await ui.send("freeze", { ...loc(e), enabled: false }));
        for (const kind of kinds) (r => r && (ui.state.watches = r.watches))(await ui.send("watch", { ...loc(e), size: L.sizeOf(e.type), kind, enabled: false }));
        return kinds;
    },

    async drop(list) {
        for (const e of list) (await view.stop(e), view.picked.delete(key(e)));
        const left = await ui.table(l => l.filter(x => !list.some(e => ui.same(x, e))));
        if (!left.length) await ui.bySite("tableHash", null, () => undefined), view.table();
    },

    async move(e, patch) {
        const n = { ...e, ...patch }, num = !TEXT.includes(n.type), id = ident;
        for (const k of Object.keys(n)) if (n[k] === undefined) delete n[k];
        if (ui.same(e, n) && e.length === n.length) return view.table();
        if (!ui.same(e, n) && (await ui.table()).some(x => ui.same(x, n))) return (view.toast("That entry is already in the table"), view.table());
        const was = frozenIn(e), kinds = await view.stop(e);
        if (view.picked.delete(key(e))) view.picked.add(key(n));
        await ui.table(l => l.map(x => ui.same(x, e) ? { ...n, frozen: false, freezeValue: null, watch: num && !kinds.length ? kindsOf(e) : [] } : x));
        const hit = h => [h.entry, ...h.entries ?? []].some(x => x && ui.same(x, e));
        if (!ui.same(e, n) && (await ui.hotkeys()).some(hit)) await ui.hotkeys(l => l.map(h => hit(h) ? { ...h, ...h.entry && ui.same(h.entry, e) && { entry: id(n) }, ...h.entries && { entries: h.entries.map(x => ui.same(x, e) ? id(n) : x) } } : h));
        if (was && num) {
            let v = e.freezeValue ?? undefined;
            try { if (v != null) L.parseValue(String(v), n.type); } catch { v = undefined; }
            await view.setFreeze(n, true, v);
        }
        const armed = [], brk = !!e.watchBreak, cnd = e.watchCondition ?? null;
        for (const kind of num ? kinds : []) {
            const r = await ui.send("watch", { ...loc(n), size: L.sizeOf(n.type), kind, enabled: true, break: brk, condition: cnd ?? "" });
            if (r) (ui.state.watches = r.watches, armed.push(kind));
        }
        if (armed.length) await ui.entry(n, { watch: armed, watchBreak: brk, watchCondition: cnd });
    },

    async bulk(what) {
        const list = (await ui.table()).filter(e => view.picked.has(key(e))), value = el("tableBulkValue").value.trim(), nums = list.filter(e => !TEXT.includes(e.type)), all = nums.every(frozenIn);
        if (!list.length) return view.toast("Select entries first");
        if (what === "remove") return view.drop(list);
        if (what === "set" && !value) return view.toast("Enter a value");
        if (what === "freeze" && !nums.length) return view.toast("Select numeric entries to freeze");
        try { if (value) for (const e of nums) L.parseValue(value, e.type); } catch (err) { return view.toast(err.message); }
        if (what === "set") for (const e of list) await ui.send("write", { ...loc(e), value }) && frozenIn(e) && await view.setFreeze(e, true, value);
        else for (const e of nums) all && !value ? await view.setFreeze(e, false) : (value || !frozenIn(e)) && await view.setFreeze(e, true, value || undefined);
        view.live();
    },

    async setFreeze(e, on, value) {
        if (on && value == null) {
            const r = await ui.send("readValues", { items: [loc(e)] });
            if (!r) return view.table();
            value = fmt(r.values[0], e.type);
        }
        const r = await ui.send("freeze", { ...loc(e), value, enabled: on, mode: e.mode ?? "exact", ...e.mode === "step" && { step: e.step ?? "1" } });
        if (!r) return view.table();
        ui.state.freezes = r.freezes;
        await ui.entry(e, { frozen: on, freezeValue: on ? value : null });
    },

    async table() {
        const [list, keys, hash] = await Promise.all([ui.table(), ui.hotkeys(), ui.bySite("tableHash", null)]), st = ui.state, t = document.createElement("table");
        const a = st?.instances.find(i => i.id === st.active), numeric = e => !TEXT.includes(e.type), sel = el("hotkeyEntry"), old = sel.value;
        el("tableHashWarning").hidden = !a?.hash || !hash || hash === a.hash;
        sel.replaceChildren(...list.filter(numeric).map(e => new Option(`${e.description || where(e)} (${e.type}${memNote(e)})`,
            e.pointer ? `p:${JSON.stringify(ident(e))}` : `${e.address}:${e.type}${e.memory ? `:${e.memory}` : ""}`)));
        if (old) sel.value = old;
        view.choices("hotkeyGroup", list.filter(e => e.group && numeric(e)).map(e => e.group));
        if (tableEdit()) return void (view.tableDue = true);
        view.tableDue = false;
        t.createTHead().insertRow().append(...["", "Description", "Address", "Type", "Length", "Value", "Options", "Mode", "Freeze", "Writes", "Reads", "Condition", "Group", "Hex", "Keys", ""].map(h => Object.assign(document.createElement("th"), { textContent: h })));
        const body = t.createTBody();
        for (const g of [null, ...new Set(list.map(e => e.group).filter(Boolean))]) {
            const members = list.filter(e => (e.group || null) === g), shut = g && view.collapsed.has(g);
            if (g) {
                const tr = body.insertRow(), nums = members.filter(numeric);
                Object.assign(tr, { className: "group", onclick: () => (shut ? view.collapsed.delete(g) : view.collapsed.add(g), view.table()) }).dataset.group = g;
                Object.assign(tr.insertCell(), { colSpan: 8, textContent: `${shut ? "\u25b8" : "\u25be"} ${g}` });
                const cb = tr.insertCell().appendChild(Object.assign(document.createElement("input"), { type: "checkbox", className: "group-freeze", checked: nums.length > 0 && nums.every(frozenIn), onclick: ev => ev.stopPropagation() }));
                tr.insertCell().colSpan = 7;
                cb.onchange = async () => { for (const e of nums) if (frozenIn(e) !== cb.checked) await view.setFreeze(e, cb.checked); };
            }
            for (const e of members) {
                const tr = body.insertRow(), cell = n => tr.insertCell().appendChild(n), on = !numeric(e);
                const node = (tag, className, props) => cell(Object.assign(document.createElement(tag), { className, ...props }));
                const check = (className, checked, off = on) => node("input", className, { type: "checkbox", checked, disabled: off });
                const wide = !!e.memory;
                const save = patch => ui.entry(e, patch);
                if (shut) tr.className = "collapsed-member";
                Object.assign(tr.dataset, { address: e.address, type: e.type, length: e.length ?? "", hex: !!e.hex, memory: e.memory ?? 0, ...e.pointer && { pointer: JSON.stringify(e.pointer) } });
                check("entry-select", view.picked.has(key(e)), false).onchange = ev => view.picked[ev.target.checked ? "add" : "delete"](key(e));
                node("input", "entry-desc", { type: "text", value: e.description }).onchange = ev => save({ description: ev.target.value });
                const place = node("input", "entry-address", { type: "text", value: where(e) });
                if (e.memory) place.after(Object.assign(document.createElement("span"), { className: "entry-memory", textContent: `memory ${e.memory}` }));
                place.onchange = ev => {
                    let loc;
                    try { loc = locate(ev.target.value); } catch (err) { return (ev.target.value = where(e), view.toast(err.message)); }
                    view.move(e, { pointer: loc.pointer, ...loc.address != null && { address: loc.address } });
                };
                const ts = node("select", "entry-type");
                ts.append(...types().map(t => new Option(t, t)));
                ts.value = e.type;
                ts.onchange = () => view.move(e, { type: ts.value, length: TEXT.includes(ts.value) ? e.length ?? 16 : undefined });
                node("input", "entry-length", { type: "number", min: 1, max: 4096, value: e.length ?? "", disabled: !on }).onchange = ev => {
                    const n = Number(ev.target.value);
                    if (!Number.isInteger(n) || n < 1 || n > 4096) return (ev.target.value = e.length ?? "", view.toast("Length must be 1 to 4096"));
                    view.move(e, { length: n });
                };
                const opts = !on && Array.isArray(e.options) && e.options.length > 0;
                const value = opts ? node("select", "entry-value live") : node("input", "entry-value live", { type: "text" });
                if (opts) value.append(...e.options.map(o => new Option(o.label ?? o.value, o.value)));
                const write = async () => {
                    if (await ui.send("write", { ...loc(e), value: value.value }) && frozenIn(e)) await view.setFreeze(e, true, value.value);
                    value.blur();
                };
                opts ? value.onchange = write : commit(value, write);
                const shown = (e.options ?? []).map(o => `${o.value}=${o.label ?? o.value}`).join("; ");
                node("input", "entry-options", { type: "text", placeholder: "value=Label; value=Label", value: shown, disabled: on }).onchange = ev => {
                    const list = ev.target.value.split(";").map(x => x.trim()).filter(Boolean).map(x => (i => i < 0 ? { value: x, label: x } : { value: x.slice(0, i).trim(), label: x.slice(i + 1).trim() || x.slice(0, i).trim() })(x.indexOf("=")));
                    const bad = list.find(o => { try { L.parseValue(o.value, e.type); } catch { return true; } });
                    if (bad) return (ev.target.value = shown, view.toast(`Invalid option value: ${bad.value || "(empty)"}`));
                    save({ options: list.length ? list : null });
                };
                const mode = tr.insertCell(), ms = mode.appendChild(Object.assign(document.createElement("select"), { className: "entry-mode", disabled: on }));
                ms.append(...[["exact", "Exact"], ["noDecrease", "No decrease"], ["noIncrease", "No increase"], ["step", "Step"]].map(([v, l]) => new Option(l, v)));
                ms.value = e.mode ?? "exact";
                ms.onchange = async () => (await save({ mode: ms.value }), frozenIn(e) && view.setFreeze({ ...e, mode: ms.value }, true));
                if (e.mode === "step") mode.appendChild(Object.assign(document.createElement("input"), { type: "text", className: "entry-step", value: e.step ?? "1",
                    onchange: async ev => (await save({ step: ev.target.value }), frozenIn(e) && view.setFreeze({ ...e, step: ev.target.value }, true)) }));
                check("entry-freeze", frozenIn(e)).onchange = ev => view.setFreeze(e, ev.target.checked);
                for (const kind of ["write", "read"]) {
                    const cb = check(`entry-watch-${kind}`, watching(e, kind), on || wide);
                    if (e.pointer || wide) cb.title = wide ? "Watches only work on memory 0" : "The watch follows the address at enable time";
                    cb.onchange = async () => {
                        const r = await ui.send("watch", { ...loc(e), size: L.sizeOf(e.type), kind, enabled: cb.checked,
                            ...cb.checked && { break: el("watchBreak").checked, condition: e.watchCondition ?? "" } });
                        if (!r) return cb.checked = !cb.checked;
                        ui.state.watches = r.watches;
                        const brk = cb.checked && { watchBreak: el("watchBreak").checked };
                        await ui.table(l => l.map(x => ui.same(x, e) ? { ...x, ...brk,
                            watch: [...kindsOf(x).filter(k => k !== kind), ...cb.checked ? [kind] : []] } : x));
                    };
                }
                node("input", "entry-watch-condition", { type: "text", value: e.watchCondition ?? "", disabled: on || wide,
                    placeholder: "hit.new < 50", title: "JS expression on hit {count, old, new, address, locals}; break only when it is true" })
                    .onchange = async ev => {
                        const c = ev.target.value.trim();
                        await save({ watchCondition: c || null });
                        for (const kind of kindsOf(e)) await ui.send("watch", { ...loc(e), size: L.sizeOf(e.type), kind, enabled: true, condition: c });
                    };
                node("input", "entry-group", { type: "text", value: e.group ?? "" }).onchange = ev => save({ group: ev.target.value.trim() || null });
                check("entry-hex", !!e.hex).onchange = ev => save({ hex: ev.target.checked });
                node("span", "entry-hotkey", { textContent: keys.filter(k => [k.entry, ...k.entries ?? []].some(x => x && ui.same(x, e))).map(k => k.combo).join(", ") });
                node("button", "entry-remove", { textContent: "\u00d7", title: "Remove", onclick: () => view.drop([e]) });
            }
        }
        el("table").replaceChildren(t);
        view.live();
    },

    choices(id, names) {
        const sel = el(id), old = sel.value;
        sel.replaceChildren(...[...new Set(names)].map(n => new Option(n, n)));
        if (old) sel.value = old;
    },

    hotkeyForm() {
        const a = el("hotkeyAction").value;
        el("hotkeyEntry").parentElement.hidden = !HK_ENTRY.includes(a);
        el("hotkeyGroup").parentElement.hidden = a !== "toggleGroup";
        el("hotkeyScript").parentElement.hidden = a !== "toggleScript";
        el("hotkeyCompare").parentElement.hidden = a !== "nextScan";
    },

    hotkeyList(list) {
        view.grid("hotkeys", ["Keys", "Action", "Entry", "Value", ""], list.map(h => ({ data: { combo: h.combo }, cells: [["", h.combo], ["", h.action],
            ["", h.entry ? `${where(h.entry)} ${h.entry.type}${memNote(h.entry)}` : h.group != null ? `Group ${h.group}` : h.script != null ? `Script ${h.script}` : OPS[h.compare] ?? ""],
            ["", h.value ?? ""],
            ["", Object.assign(document.createElement("button"), { className: "hotkey-remove", textContent: "\u00d7", title: "Remove", onclick: () => ui.hotkeys(l => l.filter(k => k.combo !== h.combo)) })]] })));
    },

    async undo() {
        const r = await ui.send("undo");
        if (!r) return;
        if (!r.undone) return view.toast("Nothing to undo");
        view.live();
        view.memPoll();
        if (!el("tabGlobals").hidden) view.globals();
    },

    grid(id, head, rows, keep = false) {
        const t = document.createElement("table");
        t.createTHead().insertRow().append(...head.map(h => Object.assign(document.createElement("th"), { textContent: h })));
        const body = t.createTBody();
        for (const { data, cells } of rows) {
            const tr = body.insertRow();
            Object.assign(tr.dataset, data);
            for (const [className, c] of cells) Object.assign(tr.insertCell(), { className }).append(c);
        }
        el(id).replaceChildren(...rows.length || keep ? [t] : []);
        return body;
    },

    hits() {
        const on = h => ui.state?.accesses?.some(a => a.func === h.func && a.offset === h.offset);
        const key = h => `${h.slot}:${h.kind}:${h.func}:${h.offset}`, hits = ui.state?.hits ?? [], btn = (className, textContent, onclick) =>
            Object.assign(document.createElement("button"), { className, textContent, onclick: e => (e.stopPropagation(), onclick()) });
        const head = ["Slot", "Kind", "Function", "Name", "Offset", "Count", "Last", "", "", ""];
        const body = view.grid("hits", head, hits.map(h => ({ data: { func: h.func, offset: h.offset },
            cells: [["", h.slot], ["", h.kind], ["", h.func], ["hit-name", h.name ?? ""], ["", L.toHex(h.offset)], ["hit-count", h.count],
                ["hit-last", h.last ? `${h.last.old ?? "?"} -> ${h.last.new ?? "?"}` : ""],
                ["", btn("hit-stack", "Stack", () => (view.stacked = key(h), view.hits()))],
                ["", btn("hit-nop", "NOP", async () => await view.openFunction(h.func, h.offset)
                    && (el("codeDisassembly").dataset.line ? view.nop() : view.toast("Cannot replace this instruction")))],
                ["", btn("hit-accesses", on(h) ? "Stop" : "Accesses", () => view.access(h, !on(h)))]] })), true);
        [...body.rows].forEach((tr, i) => tr.onclick = () => view.openFunction(hits[i].func, hits[i].offset));
        const stack = hits.find(h => key(h) === view.stacked)?.last?.stack ?? [];
        const rows = view.grid("hitStack", ["Frame", "Function", "Name", "Offset"], stack.map((f, i) => ({ data: { func: f.func, offset: f.offset },
            cells: [["", i], ["", f.func], ["", f.name ?? ""], ["", L.toHex(f.offset)]] })));
        [...rows.rows].forEach((tr, i) => tr.onclick = () => view.openFunction(stack[i].func, stack[i].offset, true));
        el("hitLocals").replaceChildren(view.locals(hits.find(h => key(h) === view.stacked)?.last?.locals));
        view.accesses();
    },

    shown: null,
    stacked: null,

    async access(h, enabled) {
        const f = enabled && await ui.request("function", { index: h.func }).catch(() => null);
        let lines = null;
        try { lines = f && L.disassemble(f.bytes, f.added ?? []).lines; } catch { lines = null; }
        const r = await ui.send("accesses", { func: h.func, offset: h.offset, enabled });
        if (!r) return;
        const type = lines ? view.siteType(f, lines, h.offset - f.bodyOffset) : { type: "u32" };
        view.shown = enabled ? { ...h, ...type } : null;
        ui.state.accesses = r.accesses;
        view.hits();
    },

    accessRows(id, s, head) {
        const a = s && ui.state?.accesses?.find(x => x.func === s.func && x.offset === s.offset);
        const add = address => Object.assign(document.createElement("button"), {
            className: "add-entry", textContent: "+", title: "Add to table",
            onclick: () => view.addRows([{ address, type: s.type, length: s.length, memory: 0 }]) });
        view.grid(id, [head, "Count", ""], (a?.addresses ?? []).map(({ address, count }) => ({ data: { address },
            cells: [["", L.toHex(address)], ["access-count", count], ["", add(address)]] })));
    },

    accesses() {
        view.accessRows("accesses", view.shown, "Accessed address");
        view.codeAccesses();
    },

    storeOps: ["i32.store", "i64.store", "f32.store", "f64.store",
        "i32.store8", "i32.store16", "i64.store8", "i64.store16", "i64.store32"],

    accessType(m) {
        const w = /^memory\.atomic\.wait(\d+)/.exec(m);
        const n = /^(?:i32|i64|v128)\.(?:atomic\.)?(?:load|store|rmw)(\d+)(x?)[^_\s]*(_s)?/.exec(m);
        if (w) return { type: `i${w[1]}` };
        if (n) return { type: n[2] ? "u64" : `${n[3] ? "i" : "u"}${n[1]}` };
        const t = /^(i32|i64|f32|f64)\./.exec(m);
        return t ? { type: t[1] } : /^v128\./.test(m) ? { type: "aob", length: 16 } : { type: "u8" };
    },

    siteType(f, lines, at) {
        const op = f.sites?.find(([o]) => o === at)?.[1], k = lines.findIndex(l => l.offset === at);
        const store = op === 0xfd ? "v128.store" : view.storeOps[op - 0x36];
        return view.accessType(op ? store : lines[k + 1]?.text.trim() ?? "");
    },

    codeSite() {
        const ta = el("codeDisassembly"), fn = view.fn;
        const i = ta.dataset.line ? ta.dataset.line - 1 : ta.value.slice(0, ta.selectionStart).split("\n").length - 1;
        const shown = ta.value.split("\n").map(s => s.replace(/\s*;;.*$/, "")).join("\n");
        if (!fn || shown !== view.fnLines.map(l => l.text).join("\n")) return null;
        const at = new Set((fn.sites ?? []).map(([o]) => o)), l = [i, i - 1].map(view.runLine).find(l => at.has(l?.offset));
        return l ? { func: fn.index, offset: fn.bodyOffset + l.offset, ...view.siteType(fn, view.fnRun, l.offset) } : null;
    },

    armed: s => !!s && !!ui.state?.accesses?.some(a => a.func === s.func && a.offset === s.offset),
    traced: null,

    codeAccesses() {
        if (!view.armed(view.traced)) view.traced = null;
        el("codeAccesses").textContent = view.armed(view.codeSite()) ? "Stop" : "Accesses";
        view.accessRows("codeAccessResults", view.traced, "Address");
    },

    globalHits() {
        const hits = ui.state?.globalHits ?? [];
        const head = ["Global", "Function", "Name", "Offset", "Count", "Last value"];
        const body = view.grid("globalHits", head, hits.map(h => ({ data: { func: h.func, offset: h.offset },
            cells: [["", h.globalName], ["", h.func], ["hit-name", h.name ?? ""], ["", L.toHex(h.offset)],
                ["hit-count", h.count], ["hit-last", h.last]] })));
        [...body.rows].forEach((tr, i) => tr.onclick = () => view.openFunction(hits[i].func, hits[i].offset - 1, true));
    },

    async breakpoints() {
        const list = (await ui.options()).breakpoints;
        const hits = ui.state?.bpHits ?? [];
        const hit = b => hits.find(h => h.func === b.func && h.offset === b.offset);
        const head = ["Function", "Name", "Offset", "Count", "Locals", "Break", "Condition", "Capture", ""];
        const body = view.grid("breakpoints", head, list.map(b => {
            const brk = Object.assign(document.createElement("input"), {
                type: "checkbox", className: "bp-break", checked: !!b.break, title: "Pause in the debugger on each hit",
                onclick: e => e.stopPropagation(), onchange: e => view.bpBreak(b, e.target.checked) });
            const loc = Object.assign(document.createElement("input"), {
                type: "checkbox", className: "bp-locals", checked: !!b.locals, title: "Report the function's numeric params and locals on each hit",
                onclick: e => e.stopPropagation(), onchange: e => view.bpSet(b, { locals: e.target.checked || undefined }, true) });
            const cnd = Object.assign(document.createElement("input"), {
                type: "text", className: "bp-condition", value: b.condition ?? "", placeholder: "hit.locals[0] === 7",
                title: "JS expression on hit {count, old, new, address, locals}; break only when it is true",
                onclick: e => e.stopPropagation(), onchange: e => view.bpSet(b, { condition: e.target.value.trim() || undefined }) });
            const rm = Object.assign(document.createElement("button"), {
                className: "bp-remove", textContent: "Remove",
                onclick: e => (e.stopPropagation(), view.bpToggle(b.func, b.offset)) });
            const name = view.fns.find(f => f.index === b.func)?.name ?? hit(b)?.name ?? "";
            const cells = [["", b.func], ["", name], ["", L.toHex(b.offset)]];
            cells.push(["bp-count", hit(b)?.count ?? 0], ["bp-locals-value", view.locals(hit(b)?.last?.locals)],
                ["", brk], ["", cnd], ["", loc], ["", rm]);
            return { data: { func: b.func, offset: b.offset }, cells };
        }));
        const go = b => view.openFunction(b.func, b.offset, true, true);
        [...body.rows].forEach((tr, i) => tr.onclick = () => go(list[i]));
    },

    async bpToggle(func, offset) {
        const same = b => b.func === func && b.offset === offset;
        await ui.options(o => {
            const bs = o.breakpoints;
            return { ...o, breakpoints: bs.some(same) ? bs.filter(b => !same(b)) : [...bs, { func, offset }] };
        });
        el("breakpointNote").hidden = false;
        await view.breakpoints();
    },

    async bpBreak({ func, offset }, on) {
        const set = ({ break: _, ...b }) => on ? { ...b, break: true } : b;
        const pick = b => b.func === func && b.offset === offset ? set(b) : b;
        await ui.options(o => ({ ...o, breakpoints: o.breakpoints.map(pick) }));
        if (ui.state) await ui.send("breakpoint", { func, offset, break: on });
    },

    locals(ls) {
        const box = document.createElement("span");
        box.append(...(ls ?? []).flatMap((v, i) => v == null ? []
            : [Object.assign(document.createElement("div"), { textContent: `local${i}=${v}` })]));
        return box;
    },

    async bpSet({ func, offset }, patch, reload) {
        const pick = b => {
            if (b.func !== func || b.offset !== offset) return b;
            const n = { ...b, ...patch };
            for (const k of Object.keys(n)) if (n[k] === undefined) delete n[k];
            return n;
        };
        const list = (await ui.options(o => ({ ...o, breakpoints: o.breakpoints.map(pick) }))).breakpoints;
        const b = list.find(x => x.func === func && x.offset === offset);
        if (reload) el("breakpointNote").hidden = false;
        if (ui.state && !reload) await ui.send("breakpoint", { func, offset, break: !!b?.break, condition: b?.condition ?? "" });
        await view.breakpoints();
    },

    async codeFilter(op) {
        const r = await ui.send("codeFilter", { op });
        if (!r) return;
        const more = r.count > r.rows.length ? `, showing ${r.rows.length}` : "";
        el("codeFilterCount").textContent = op === "reset" ? "" : `${r.count} function${r.count === 1 ? "" : "s"}${more}`;
        const body = view.grid("codeFilterResults", ["Function", "Name", "Calls"], r.rows.map(f => ({ data: { func: f.func },
            cells: [["", f.func], ["cf-name", f.name ?? ""], ["cf-calls", f.calls]] })));
        [...body.rows].forEach((tr, i) => tr.onclick = () => view.openFunction(r.rows[i].func));
    },

    stepLine(off) {
        const r = view.fn, at = r?.map ? r.map.find(([, o]) => o === off)?.[0] ?? -1 : off;
        return view.fnLines.findIndex(l => l.offset === at);
    },

    stepGo(off) {
        const i = view.stepLine(off);
        if (i >= 0) view.setCode(el("codeDisassembly").value, i);
    },

    async stepLog() {
        const index = view.fn?.index, on = index != null && (await ui.options()).stepTrace.some(s => s.func === index);
        if (!on || !ui.state) return void view.grid("stepTrace", [], []);
        const r = await ui.send("stepTrace", { func: index });
        if (!r) return;
        const text = off => (l => l >= 0 ? view.fnLines[l].text.trim() : "")(view.stepLine(off));
        const rows = r.steps.map((s, k) => ({ data: { offset: s.offset },
            cells: [["", k + 1], ["step-offset", L.toHex(s.offset)], ["step-text", text(s.offset)]] }));
        const body = view.grid("stepTrace", [`Step${r.truncated ? " (truncated)" : ""}`, "Offset", "Instruction"], rows);
        [...body.rows].forEach((tr, k) => tr.onclick = () => view.stepGo(r.steps[k].offset));
    },

    traceLog(calls) {
        view.grid("traceLog", ["Function", "Name", "Calls", "Last arguments"], calls.map(c => ({ data: { func: c.func },
            cells: [["", c.func], ["", c.name ?? ""], ["trace-count", c.count], ["trace-args", c.lastArgs.map(v => v ?? "?").join(", ")]] })));
    },

    async live() {
        const pane = ["tabSearch", "tabStrings", "tabTable"].map(el).find(p => !p.hidden), trs = [...pane?.querySelectorAll("tr[data-address][data-type]") ?? []];
        if (!trs.length || !ui.state || document.hidden || pane.querySelector("tr input[type=text]:focus")) return;
        const items = trs.map(({ dataset: d }) => ({ address: +d.address, type: d.type, ...(d.length && { length: +d.length }), ...(d.memory && { memory: +d.memory }), ...(d.pointer && { pointer: JSON.parse(d.pointer) }), ...(d.groupText && { group: d.groupText }) }));
        const r = await readAll(items);
        if (pane.querySelector("tr input[type=text]:focus")) return;
        r.forEach((v, i) => {
            const c = trs[i].querySelector(".live");
            if (v === undefined) return;
            c["value" in c ? "value" : "textContent"] = fmt(v, trs[i].dataset.type, trs[i].dataset.hex === "true");
        });
    },

    memStart: 0,
    memSize: 512,
    memSel: null,
    memExt: null,
    memType: "i32",
    memDisp: "u8",
    memBytes: null,
    memSeen: new Map(),
    memBack: [],
    marks: [],

    memWidth: () => L.memCells(new Uint8Array(8), view.memDisp)[0].size,

    memRange() {
        const s = view.memSel, e = view.memExt?.anchor === s ? view.memExt.end : s, n = view.memWidth();
        const down = x => x - ((x - view.memStart) % n + n) % n;
        return s == null ? null : [down(Math.min(s, e)), down(Math.max(s, e)) + n - 1];
    },

    memPick(address, end = address) {
        view.memSel = address;
        view.memExt = { anchor: address, end };
    },

    async memWrite(type, body) {
        const r = await ui.send(type, body);
        view.memPoll(true);
        return r;
    },

    snapshots() {
        const btn = (className, textContent, op, name) => Object.assign(document.createElement("button"), { className, textContent, title: op === "delete" ? "Remove" : "Restore", onclick: () => view.snap(op, name) });
        const head = ["Snapshot (lost on reload)", "Instance", "Memory", "Size", "Globals", "", ""];
        view.grid("snapshots", head, (ui.state?.snapshots ?? []).map(s => ({ data: { name: s.name },
            cells: [["", s.name], ["", s.instance], ["", s.memory ?? 0], ["", `${Math.ceil(s.bytes / 1024)} KiB`], ["", s.globals], ["", btn("snap-restore", "Restore", "restore", s.name)], ["", btn("snap-remove", "\u00d7", "delete", s.name)]] })));
    },

    async snap(op, name) {
        const r = await ui.send("snapshot", { op, name });
        if (!r) return;
        ui.state.snapshots = r.snapshots;
        view.snapshots();
        if (op === "restore") (view.memPoll(true), view.live(), el("tabGlobals").hidden || view.globals());
        return r;
    },

    async memLoad(file) {
        const a = addr(el("memLoadAddress").value), CHUNK = 2 ** 23;
        if (a == null) return view.toast("Invalid load address");
        if (!file.size) return view.toast("File is empty");
        if (a + file.size > view.memMax()) return view.toast("File does not fit in memory at that address");
        for (let o = 0; o < file.size; o += CHUNK) {
            const u8 = new Uint8Array(await file.slice(o, o + CHUNK).arrayBuffer());
            let bin = "";
            if (!u8.toBase64) for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
            if (!await ui.send("load", { address: a + o, bytes: u8.toBase64?.() ?? btoa(bin) })) return view.memPoll(true);
        }
        view.toast(`Loaded ${file.size} bytes at ${hx(a)}`);
        view.memPoll(true);
        view.live();
    },

    async memFind(next) {
        const t = el("memFindType").value, value = el("memFindQuery").value;
        const r = await ui.send("find", { from: next ? (view.memSel ?? -1) + 1 : 0, type: t, value });
        if (!r) return;
        if (r.address == null) return view.toast("Not found");
        view.memPick(r.address, r.address + (L.isNum(t) ? L.sizeOf(t) : L.toBytes(value, t).length) - 1);
        view.memGo(r.address);
    },

    async memCopy() {
        const r = view.memRange();
        if (!r) return view.toast("Select bytes first");
        if (r[1] - r[0] >= 2 ** 20) return view.toast("Select at most 1 MiB");
        const out = [];
        for (let a = r[0]; a <= r[1]; a += 4096) {
            const x = await ui.send("read", { address: a, length: Math.min(4096, r[1] + 1 - a) });
            if (!x) return;
            out.push(...x.bytes);
        }
        const text = out.map(b => b.toString(16).padStart(2, "0").toUpperCase()).join(" ");
        await navigator.clipboard.writeText(text).then(() => view.toast(`Copied ${out.length} bytes`), e => view.toast(e.message));
    },

    memMax() {
        const a = ui.state?.instances.find(i => i.id === ui.state.active);
        return a?.memories?.find(m => m.index === a.memory)?.bytes ?? a?.memoryBytes ?? 0;
    },

    memGrown(size) {
        const a = ui.state.instances.find(i => i.id === ui.state.active), m = a?.memories?.find(x => x.index === a.memory);
        if (!a) return;
        if (m) m.bytes = size;
        if (!a.memory) a.memoryBytes = size;
        view.render(ui.state);
        el("memViewPageCount").textContent = `of ${Math.ceil(view.memMax() / view.memSize)}`;
    },

    memGo(address) {
        const n = view.memSize;
        view.memStart = Math.max(0, Math.min(address, view.memMax() - n));
        el("memViewStartAddress").value = L.toHex(view.memStart);
        el("memViewPage").value = Math.floor(view.memStart / n) + 1;
        el("memViewPageCount").textContent = `of ${Math.ceil(view.memMax() / n)}`;
        el("memViewBack").disabled = !view.memBack.length;
        view.memPoll(true);
    },

    async memPoll(force) {
        if (!force && (el("tabMemView").hidden || document.hidden) || !ui.state || el("memViewByteInput")) return;
        const start = view.memStart, sel = view.memSel, [lo, hi] = view.memRange() ?? [], r = await ui.request("read", { address: start, length: view.memSize }).catch(e => (force && view.toast(e.message), null));
        const ins = sel == null ? null : await ui.request("readValues", { items: NUM.map(type => ({ address: sel, type })) }).catch(() => null);
        if (!r || start !== view.memStart || el("memViewByteInput")) return;
        if (r.size != null && r.size !== view.memMax()) view.memGrown(r.size);
        const g = el("memViewGrid"), b = r.bytes, rows = Math.ceil(b.length / 16), now = Date.now(), d = view.memDisp, cells = L.memCells(b, d);
        const div = (className, textContent = "") => Object.assign(document.createElement("div"), { className, textContent });
        const same = g.dataset.start === String(start) && view.memBytes?.length === b.length, old = same ? view.memBytes : null;
        if (!same) view.memSeen.clear();
        if (!same || g.dataset.disp !== d || g.children.length !== rows) {
            Object.assign(g.dataset, { start, disp: d });
            g.replaceChildren(...Array.from({ length: rows }, (_, i) => {
                const row = div("mem-row");
                row.append(div("mem-addr", L.toHex(start + i * 16)), ...cells.filter(c => c.offset >> 4 === i).map(c => {
                    const s = document.createElement("span");
                    Object.assign(s.dataset, { address: start + c.offset, type: c.type });
                    s.style.gridColumn = `span ${c.size}`;
                    return s;
                }), div("mem-ascii"));
                return row;
            }));
        }
        view.memBytes = b;
        if (old) b.forEach((x, k) => old[k] !== x && view.memSeen.set(k, now));
        g.querySelectorAll("span[data-address]").forEach((s, i) => {
            const c = cells[i], a = start + c.offset, end = a + c.size - 1, mark = view.marks.find(m => m.address >= a && m.address <= end);
            const hot = Array.from({ length: c.size }, (_, k) => now - (view.memSeen.get(c.offset + k) ?? -1e4) < 1000);
            s.textContent = c.text;
            s.title = mark?.label ?? "";
            s.classList.toggle("changed", hot.some(Boolean));
            s.classList.toggle("selected", a <= hi && end >= lo);
            s.classList.toggle("bookmarked", !!mark);
        });
        g.querySelectorAll(".mem-ascii").forEach((a, i) => a.textContent = String.fromCharCode(...b.slice(i * 16, i * 16 + 16).map(c => c >= 32 && c < 127 ? c : 46)));
        el("memViewTitle").textContent = view.marks.filter(m => m.address >= start && m.address < start + b.length).map(m => `${m.label} (${hx(m.address)})`).join(", ");
        const box = el("memViewInspector"), head = sel == null ? "Type" : `Type at ${hx(sel)}`, inputs = [...box.querySelectorAll("input.inspect-value")];
        if (ins && inputs.length === NUM.length && box.querySelector("th").textContent === head) inputs.forEach((x, i) => x === document.activeElement || (x.value = fmt(ins.values[i], NUM[i])));
        else view.grid("memViewInspector", [head, "Value"], ins ? NUM.map((t, i) => ({ data: { type: t }, cells: [["", t], ["", (x => commit(x, () => view.memWrite("write", { address: sel, type: t, value: x.value.trim() })))(
            Object.assign(document.createElement("input"), { type: "text", className: "inspect-value", value: fmt(ins.values[i], t) }))]] })) : []);
        box.querySelectorAll("tr[data-type]").forEach(tr => (tr.classList.toggle("selected", tr.dataset.type === view.memType), tr.onclick = () => (view.memType = tr.dataset.type,
            box.querySelectorAll("tr[data-type]").forEach(x => x.classList.toggle("selected", x === tr)))));
    },

    async bookmarks() {
        view.marks = ((await ui.annotations()).memory ?? []).filter(m => (m.memory ?? 0) === ui.mem());
        const body = view.grid("memViewBookmarks", ["Bookmark", "Address", ""], view.marks.map(m => ({ data: { address: m.address }, cells: [["", m.label], ["", hx(m.address)],
            ["", Object.assign(document.createElement("button"), { className: "entry-remove", textContent: "\u00d7", title: "Remove", onclick: async e => (e.stopPropagation(),
                await ui.annotations(n => ({ ...n, memory: n.memory.filter(x => x.address !== m.address || (x.memory ?? 0) !== (m.memory ?? 0)) })),
                view.bookmarks()) })]] })));
        [...body.rows].forEach(tr => tr.onclick = () => (view.memPick(+tr.dataset.address), view.memGo(+tr.dataset.address)));
    },

    struct: { layout: { name: "", size: 64, fields: new Map(), open: new Map() } },

    structLayout(lay, bytes, max) {
        const end = Math.min(lay.size, bytes.length), keys = [...lay.fields.keys()].sort((x, y) => x - y), dv = new DataView(Uint8Array.from(bytes).buffer), rows = [];
        const fits = (o, lim) => ptrType() === "u32" || o + 8 <= lim && !dv.getUint32(o + 4, true);
        const guess = (o, lim) => (v => Math.abs(v | 0) < 0x1000 ? "i32" : v % 4 === 0 && v < max && fits(o, lim) ? "ptr"
            : bytes.slice(o, o + 4).every(b => b >= 0x20 && b < 0x7F) ? "ascii" : Math.abs((v >>> 23 & 0xFF) - 127) < 20 ? "f32" : "i32")(dv.getUint32(o, true));
        for (let o = 0; o < end; o += width(rows.at(-1))) {
            const lim = Math.min(keys.find(k => k > o) ?? Infinity, end), n = Math.min(4, lim - o), t = n === 4 ? guess(o, lim) : n > 1 ? "i16" : "u8";
            rows.push({ ...lay.fields.get(o) ?? { offset: o, type: t, name: "", ...t === "ascii" && { length: 4 } } });
        }
        return rows;
    },

    structLoad(list, name, deep, seen = []) {
        const st = list.find(x => x.name === name), lay = { name, size: 64, fields: new Map(), open: new Map() };
        if (!st) return lay;
        for (const f of st.fields) {
            lay.fields.set(f.offset, { offset: f.offset, type: f.type, name: f.name ?? "", ...STR.includes(f.type) && { length: f.length ?? f.size ?? 4 }, ...f.struct && { struct: f.struct } });
            if (deep && f.type === "ptr" && f.struct && seen.length < 4 && !seen.includes(f.struct) && f.struct !== name) lay.open.set(f.offset, view.structLoad(list, f.struct, true, [...seen, name]));
        }
        lay.size = Math.max(4, ...st.fields.map(f => f.offset + (f.size ?? width(f))));
        return lay;
    },

    structPack(lay, name, out = []) {
        const entry = { name, fields: [] };
        out.push(entry);
        entry.fields = (lay.rows ?? []).map(x => {
            const r = { ...x, ...lay.fields.get(x.offset) }, c = r.type === "ptr" && lay.open.get(r.offset);
            if (c) c.name ||= `${name}.${r.name || hx(r.offset)}`;
            if (c?.rows && !out.some(x => x.name === c.name)) view.structPack(c, c.name, out);
            return { offset: r.offset, type: r.type, name: r.name, size: width(r), ...STR.includes(r.type) && { length: r.length }, ...c ? { struct: c.name } : r.struct && { struct: r.struct } };
        });
        return out;
    },

    async structGo() {
        const a = addr(el("structAddress").value), c = el("structCompareAddress").value.trim() ? addr(el("structCompareAddress").value) : undefined, size = Math.ceil(+el("structSize").value / 4) * 4;
        if (a == null || c === null) return view.toast("Invalid address");
        if (!(size >= 4 && size <= 1024)) return view.toast("Size must be 4 to 1024");
        Object.assign(view.struct, { address: a, compare: c });
        view.struct.layout.size = size;
        return view.structDraw();
    },

    async structDraw() {
        const s = view.struct, max = view.memMax(), rows = [], token = s.token = {};
        const walk = async (lay, at, path, depth, seen) => {
            const r = await ui.send("read", { address: at, length: Math.min(lay.size, 4096) });
            if (!r || token !== s.token) return false;
            lay.rows = view.structLayout(lay, r.bytes, max);
            for (const f of lay.rows) {
                const row = { ...f, path: [...path, f.offset], depth, at: at + f.offset, lay }, child = f.type === "ptr" && lay.open.get(f.offset);
                rows.push(row);
                if (!child) continue;
                const n = width(f), dv = new DataView(Uint8Array.from(r.bytes.slice(f.offset, f.offset + n)).buffer);
                const to = f.offset + n <= r.bytes.length ? Number(L.read(dv, 0, ptrType())) : max;
                const why = to >= max ? "Pointer is outside memory" : seen.includes(to) ? "Pointer cycle" : depth >= 4 ? "Maximum depth reached" : "";
                if (why) (lay.open.delete(f.offset), view.toast(`${why} at ${hx(at + f.offset)}`));
                else if (row.open = true, !await walk(child, to, row.path, depth + 1, [...seen, to])) return false;
            }
            return true;
        };
        if (!await walk(s.layout, s.address, [], 0, [s.address]) || token !== s.token) return;
        s.rows = rows;
        const c = s.compare, node = (...n) => (x => (x.append(...n), x))(document.createElement("span"));
        const redraw = row => (row.lay.fields.set(row.offset, { offset: row.offset, type: row.type, name: row.name, ...STR.includes(row.type) && { length: row.length }, ...row.struct && { struct: row.struct } }), view.structDraw());
        const body = view.grid("structRows", ["Offset", "Type", "Name", "Value", ...c == null ? [] : [`At ${hx(c)}`], ""], rows.map(row => {
            const type = Object.assign(document.createElement("select"), { className: "struct-type", onchange: () => {
                row.type = type.value;
                if (STR.includes(row.type)) row.length ??= 16; else delete row.length;
                if (row.type !== "ptr") row.lay.open.delete(row.offset);
                redraw(row);
            } });
            type.append(...[...nums(), "ptr", ...STR].map(t => new Option(t, t)));
            type.value = row.type;
            const length = STR.includes(row.type) && Object.assign(document.createElement("input"), { type: "text", className: "struct-length", value: row.length, title: "Length in bytes", onchange: () => {
                const n = Number(length.value);
                if (!Number.isInteger(n) || n < 1 || n > 4096) return (length.value = row.length, view.toast("Length must be 1 to 4096"));
                row.length = n;
                redraw(row);
            } });
            const name = Object.assign(document.createElement("input"), { type: "text", className: "struct-name", value: row.name, onchange: () => (row.name = name.value, row.lay.fields.set(row.offset, (({ path, depth, at, lay, open, ...f }) => f)(row))) });
            const expand = row.type === "ptr" && row.depth < 4 && Object.assign(document.createElement("button"), { type: "button", className: "struct-expand", textContent: row.open ? "−" : "▸",
                title: row.open ? "Collapse" : "Expand", onclick: e => {
                    e.stopPropagation();
                    if (row.open) row.lay.open.delete(row.offset);
                    else row.lay.open.set(row.offset, row.struct ? view.structLoad(view.structSaved ?? [], row.struct, false) : { name: "", size: 64, fields: new Map(), open: new Map() });
                    view.structDraw();
                } });
            const child = row.open && row.lay.open.get(row.offset), nested = child && Object.assign(document.createElement("input"), { type: "text", className: "struct-nested", placeholder: "Nested struct",
                value: child.name, onchange: () => child.name = nested.value.trim() });
            const add = Object.assign(document.createElement("button"), { type: "button", className: "struct-add", textContent: "+", title: "Add to table", onclick: e => (e.stopPropagation(), ui.addEntry(view.structEntry(row))) });
            return { data: { offset: row.offset, path: row.path.join("."), depth: row.depth }, cells: [["", `+${hx(row.offset)}`], ["", node(type, ...length ? [length] : [])], ["", name], ["struct-value", ""],
                ...c == null ? [] : [["struct-compare", ""]], ["", node(...[expand, nested, add].filter(Boolean))]] };
        }));
        [...body.rows].forEach((tr, i) => (tr.style.setProperty("--depth", rows[i].depth), tr.classList.toggle("struct-child", rows[i].depth > 0),
            tr.ondblclick = () => (view.memPick(rows[i].at), changeTab("MemView"), view.memGo(view.memSel))));
        view.structPoll();
    },

    structAt(base, path) {
        return path.length === 1 ? { address: base + path[0] } : { pointer: { base: { kind: "static", address: base + path[0] }, offsets: path.slice(1) } };
    },

    structEntry(row) {
        const at = view.structAt(view.struct.address, row.path);
        return { description: row.name || `+${hx(row.offset)}`, address: at.address ?? 0, ...at.pointer && { pointer: at.pointer }, type: row.type === "ptr" ? ptrType() : row.type, ...STR.includes(row.type) && { length: row.length } };
    },

    async structPoll() {
        const s = view.struct, rows = s.rows, trs = [...el("structRows").querySelectorAll("tr[data-offset]")];
        if (s.address == null || !rows || trs.length !== rows.length || !ui.state) return;
        const items = base => rows.map(r => ({ ...view.structAt(base, r.path), type: r.type === "ptr" ? ptrType() : r.type, ...STR.includes(r.type) && { length: r.length } }));
        const show = (v, t) => t === "ptr" ? v == null ? "?" : fmt(v, ptrType(), true) : STR.includes(t) ? v ?? "?" : fmt(v, t);
        const [x, y] = await Promise.all([s.address, s.compare].map(b => b == null ? null : readAll(items(b))));
        if (!x || rows !== s.rows) return;
        trs.forEach((tr, i) => {
            const t = rows[i].type, a = show(x[i], t), b = y && show(y[i], t);
            tr.querySelector(".struct-value").textContent = a;
            if (y) tr.querySelector(".struct-compare").textContent = b;
            tr.classList.toggle("diff", !!y && a !== b);
        });
    },

    async structList() {
        const list = view.structSaved = (await ui.annotations()).structs ?? [], sel = el("structLoad");
        sel.replaceChildren(new Option("Load structure", ""), ...list.map(x => new Option(x.name, x.name)));
    },

    ptrShow(rows, save = true) {
        view.ptrAll = rows;
        el("ptrRescan").disabled = !rows.length;
        if (save) ui.pointerScan({ target: view.ptrTarget, type: el("ptrType").value, memory: view.ptrMem, rows });
        view.ptrList(0);
    },

    ptrAll: [],
    ptrMem: 0,

    ptrFiltered() {
        const max = Number(el("ptrMaxLevel").value) || Infinity, kind = el("ptrBaseFilter").value;
        return view.ptrAll.filter(p => p.offsets.length <= max && (!kind || p.base.kind === kind));
    },

    ptrList(offset) {
        const list = view.ptrFiltered(), o = Math.max(0, Math.min(offset, (Math.ceil(list.length / 100) - 1) * 100)), rows = list.slice(o, o + 100);
        el("ptrCount").textContent = `Found ${view.ptrAll.length}${list.length < view.ptrAll.length ? `, ${list.length} match the filters` : ""}${view.ptrMem ? ` in memory ${view.ptrMem}` : ""}`;
        view.pager("ptr", o, rows.length, list.length);
        view.grid("ptrResults", ["", "Pointer", ""], rows.map(p => ({ data: { chain: chain(p) }, cells: [["", view.pick({ pointer: p })], ["", chain(p)],
            ["", Object.assign(document.createElement("button"), { className: "add-entry", textContent: "+", title: "Add to table", onclick: () => ui.addEntry(view.ptrEntry(p)) })]] })));
        view.selectable("ptrResults", rows.length);
        el("ptrAddAll").disabled = !rows.length;
    },

    async ptrRestore() {
        const site = ui.site(), all = view.ptrAll;
        if (!site || site === view.ptrSite) return;
        view.ptrSite = site;
        const s = await ui.pointerScan();
        if (view.ptrSite !== site || view.ptrAll !== all || !s && !all.length) return;
        [view.ptrTarget, view.ptrMem] = [s?.target, s?.memory ?? 0];
        el("ptrAddress").value = s ? hx(s.target) : "";
        if (L.isNum(s?.type)) el("ptrType").value = s.type;
        view.ptrShow(s?.rows ?? [], false);
    },

    ptrEntry(pointer) {
        return { description: "", address: view.ptrTarget, type: el("ptrType").value, pointer, memory: view.ptrMem };
    },

    memEdit(e) {
        const s = e.target.closest("span[data-address]"), t = s?.dataset.type, hex = ["u8", "hex32"].includes(view.memDisp);
        if (!s || el("memViewByteInput")) return;
        const input = Object.assign(document.createElement("input"), { id: "memViewByteInput", value: s.textContent, onblur: () => input.remove() });
        if (hex) input.maxLength = L.sizeOf(t) * 2;
        input.onkeydown = async ev => {
            if (ev.key !== "Enter" && ev.key !== "Escape") return;
            const v = input.value.trim(), value = hex ? `0x${v}` : v;
            input.onblur = null;
            input.remove();
            const ok = ev.key === "Enter" && (() => {
                try {
                    return (!hex || /^[0-9a-f]+$/i.test(v)) && (L.parseValue(value, t), true);
                } catch {
                    return false;
                }
            })();
            if (ok) await ui.send("write", { address: +s.dataset.address, type: t, value });
            else if (ev.key === "Enter") view.toast(t === "u8" ? "Invalid byte" : `Invalid ${t} value`);
            view.memPoll(true);
        };
        s.replaceChildren(input);
        input.select();
    },

    async globals() {
        const editing = () => el("globals").querySelector("input.global-value:focus");
        if (editing()) return;
        const [r, saved, o] = await Promise.all([ui.state && ui.send("globals"), ui.globalFreezes(), ui.options()]), t = document.createElement("table"), hash = ui.state?.instances.find(i => i.id === ui.state.active)?.hash;
        const stale = [...new Set(saved.filter(f => hash && f.hash !== hash && !saved.some(x => x.global === f.global && x.hash === hash)).map(f => f.global))], warn = el("globalsHashWarning");
        Object.assign(warn, { hidden: !r || !stale.length, textContent: `Frozen ${stale.join(", ")} saved for a different build of the game. Values may be wrong.` });
        t.createTHead().insertRow().append(...["Name", "Type", "Value", "Freeze", "Watch", ""].map(h => Object.assign(document.createElement("th"), { textContent: h })));
        const body = t.createTBody();
        for (const g of r?.globals ?? []) {
            const tr = body.insertRow();
            tr.dataset.name = g.name;
            tr.insertCell().textContent = g.name;
            Object.assign(tr.insertCell(), { className: "global-type", textContent: g.mutable ? g.type : `${g.type} const` });
            const input = tr.insertCell().appendChild(Object.assign(document.createElement("input"), { type: "text", className: "global-value", value: typeof g.value === "string" ? g.value : fmt(g.value, g.type), disabled: !g.mutable || g.value == null }));
            const cb = tr.insertCell().appendChild(Object.assign(document.createElement("input"), { type: "checkbox", className: "global-freeze", disabled: !g.mutable || g.value == null || !NUM.includes(g.type), checked: !!ui.state?.freezes.some(f => f.global === g.name) }));
            commit(input, async () => (input.blur(), await ui.send("setGlobal", { name: g.name, value: input.value }) && cb.checked && await ui.freezeGlobal(g.name, input.value, true), view.globals()));
            cb.onchange = async () => (await ui.freezeGlobal(g.name, input.value, cb.checked), view.globals());
            const wb = tr.insertCell().appendChild(Object.assign(document.createElement("input"), {
                type: "checkbox", className: "global-watch", title: "Report writes (applies after a reload)", checked: o.globalWatch.includes(g.index),
                disabled: !g.mutable || g.index == null || !["i32", "i64", "f32", "f64"].includes(g.type) }));
            const watch = l => wb.checked ? [...new Set([...l, g.index])] : l.filter(i => i !== g.index);
            wb.onchange = async () => (await ui.options(x => ({ ...x, globalWatch: watch(x.globalWatch) })), el("globalWatchNote").hidden = false);
            const xb = Object.assign(document.createElement("button"), { className: "global-xrefs", textContent: "Uses", title: "List reads and writes" });
            xb.onclick = () => view.xrefs({ global: g.name }, `Global ${g.name}`);
            tr.insertCell().append(xb);
        }
        if (!editing()) el("globals").replaceChildren(t);
    },

    typeSelects() {
        const fill = (id, list) => {
            const s = el(id), old = s.value;
            s.replaceChildren(...list.map(t => new Option(t, t)));
            if (list.includes(old)) s.value = old;
        };
        fill("searchType", [...types(), "all", "group"]);
        fill("tableAddType", types());
        fill("memFindType", ["aob", ...STR, ...nums()]);
        fill("ptrType", nums());
    },

    async typeList() {
        const list = await ui.customTypes().catch(() => []), sig = JSON.stringify(list);
        const rm = c => Object.assign(document.createElement("button"), { className: "custom-type-remove", textContent: "\u00d7", title: "Remove",
            onclick: () => view.typeSave(list.filter(x => x.name !== c.name)) });
        const rows = list.map(c => ({ data: { name: c.name }, cells: [["", c.name], ["", String(c.size)], ["", rm(c)]] }));
        const body = view.grid("customTypes", ["Name", "Size", ""], rows);
        [...body.rows].forEach((tr, i) => tr.onclick = e => void (e.target.tagName === "TD" && ["Name", "Size", "Decode", "Encode"]
            .forEach(k => el(`customType${k}`).value = list[i][k.toLowerCase()])));
        if (sig !== view.typeSig) (view.typeSig = sig, view.typeSelects(), view.fillCompare(), ui.state && view.table());
    },

    typeSave(list) {
        return ui.customTypes(() => list).catch(err => view.toast(err.message));
    },

    async scriptList() {
        const list = await ui.scripts(), st = new Map((ui.state?.scripts ?? []).map(x => [x.name, x])), node = (tag, props) => Object.assign(document.createElement(tag), props);
        view.choices("hotkeyScript", list.map(x => x.name));
        const body = view.grid("scripts", ["On", "Name", "Status", ""], list.map(x => ({ data: { name: x.name }, cells: [
            ["", node("input", { type: "checkbox", className: "script-enable", checked: !!x.enabled, onchange: e => view.scriptSet(x, e.target.checked) })], ["", x.name],
            ["", st.get(x.name)?.error ?? (st.get(x.name)?.running ? "Running" : "")],
            ["", node("button", { className: "script-remove", textContent: "\u00d7", title: "Remove", onclick: async () => (await ui.scripts(l => l.filter(y => y.name !== x.name)), view.scriptSet(x, false, false)) })]] })));
        [...body.rows].forEach((tr, i) => tr.onclick = e => void (e.target.tagName === "TD" && view.setScript(list[i])));
    },

    setScript({ name, code }) {
        const ta = el("scriptCode");
        el("scriptName").value = name;
        ta.value = code;
        Prism.Live?.all.get(ta)?.update();
    },

    async scriptSet(x, enabled, keep = true) {
        if (keep) await ui.scripts(l => l.map(y => y.name === x.name ? { ...y, enabled } : y));
        const r = ui.state && await ui.send("script", { name: x.name, code: x.code, enabled });
        r ? await ui.refresh() : view.scriptList();
    },

    scriptLog(text, error) {
        const log = el("scriptLog");
        log.append(Object.assign(document.createElement("div"), { textContent: text, className: error ? "error" : "" }));
        while (log.childElementCount > 500) log.firstElementChild.remove();
        log.scrollTop = log.scrollHeight;
    },

    jsRow(path, value, frozen) {
        const input = commit(Object.assign(document.createElement("input"), { type: "text", className: "js-value", value }), async () => await ui.send("jsWrite", { path, value: input.value }) && cb.checked && ui.refresh());
        const cb = Object.assign(document.createElement("input"), { type: "checkbox", className: "js-freeze", checked: frozen, onchange: async () => await ui.send("jsFreeze", { path, value: input.value, enabled: cb.checked }) ? ui.refresh() : cb.checked = !cb.checked });
        return { data: { path }, cells: [["", path], ["", input], ["", cb]] };
    },

    jsShow(r) {
        if (!r) return;
        el("jsCount").textContent = `Found ${r.count}`;
        view.grid("jsResults", ["Path", "Value", "Freeze"], r.rows.map(({ path, value, frozen }) => view.jsRow(path, value, frozen)));
    },

    jsFrozen() {
        const list = ui.state?.jsFreezes ?? [], on = new Set(list.map(f => f.path));
        for (const cb of el("jsResults").querySelectorAll(".js-freeze")) cb.checked = on.has(cb.closest("tr").dataset.path);
        const key = JSON.stringify(list), same = key === view.jsFrozenKey;
        view.jsFrozenKey = key;
        if (!same && !el("jsFrozen").querySelector("input[type=text]:focus")) view.grid("jsFrozen", ["Frozen path", "Value", "Freeze"], list.map(({ path, value }) => view.jsRow(path, value, true)));
    },

    gauge() {
        const v = +el("shRange").value, k = v * 10 / +el("shRange").max, n = Math.floor(k * 22);
        el("arrow").style.transform = `translate(0px, -157px) rotate(${Math.floor((k - 5) * 22)}deg)`;
        el("slider-round").style.transform = `translate(${n * 1.75}px, -50%)`;
        el("slider-item-fill").style.transform = `translateX(${k * 10 - 100}%)`;
        document.querySelectorAll(".speedometer .paint").forEach((p, i) => p.style.fill = i <= n / 3.5 ? "#5352ED" : "#2A303E");
        document.querySelectorAll(".speedometer .paint-bold").forEach((p, i) => p.style.fill = i <= n / 20 ? "#5352ED" : "#2A303E");
        el("shValue").textContent = `${v}x`;
    },

    speedOn(on) {
        el("toggleSpeedhack").setAttribute("enabled", on);
        el("toggleSpeedhack").textContent = on ? "Disable" : "Enable";
    },

    async speed(on) {
        const r = await ui.send("speed", { multiplier: on ? +el("shRange").value : 1 });
        if (r) view.speedOn(on);
    },
};

document.body.classList.toggle("devtools", new URLSearchParams(location.search).get("devtools") === "1");
el("openTab").hidden = document.body.classList.contains("devtools") || new URLSearchParams(location.search).has("tabId");
el("openTab").onclick = async () => (await chrome.tabs.create({ url: chrome.runtime.getURL(`extension/popupview.html?tabId=${ui.tabId}`) }), window.close());
view.render(null);
view.typeSelects();
el("searchType").value = "i32";
el("searchType").onchange = view.fillCompare;
el("searchCompare").onchange = view.syncSearch;
el("searchParam").oninput = e => el("searchTolerance").value = 5 / 10 ** ((/\.(\d*)/.exec(e.target.value)?.[1].length ?? 0) + 1);
el("restartBtn").onclick = () => view.scanBusy(async () => await ui.send("scanReset") && view.clearScan());
el("searchForm").onsubmit = async e => {
    e.preventDefault();
    const type = el("searchType").value, text = el("searchParam").value, compare = el("searchCompare").value;
    const body = { type, compare, aligned: el("searchAligned").checked, not: el("searchNot").checked, pause: el("searchPause").checked, ...view.scanning && { base: el("searchBase").value } };
    const check = v => {
        if (type === "all" || type === "group" || TEXT.includes(type)) {
            if (!v.trim()) throw new RangeError("Missing search value");
            if (type === "aob") L.parseAob(v); else if (type === "binary") L.parseBits(v); else if (type === "group") L.parseGroup(v);
        } else L.parseValue(v, type);
        return v;
    };
    try {
        if (!el("searchParam").disabled) body.value = check(text);
        if (compare === "between") body.value2 = check(el("searchValue2").value);
        if (STR.includes(type)) body.caseSensitive = el("searchCaseSensitive").checked;
        if (L.isFloat(type)) Object.assign(body, { tolerance: num(el("searchTolerance").value, "tolerance"), rounding: el("searchRounding").value, decimals: /\.(\d*)/.exec(text)?.[1].length ?? 0 });
        [body.lower, body.upper] = [num(el("searchLower").value, "range"), num(el("searchUpper").value, "range")];
    } catch (err) {
        return view.toast(err.message);
    }
    const r = await view.scanBusy(() => ui.send("scan", body));
    if (!r) return;
    view.scanning = true;
    view.fillCompare();
    view.scanPage(r, 0);
};
el("resultsPrev").onclick = () => view.scanRows(view.resultsOffset - 100);
el("resultsNext").onclick = () => view.scanRows(view.resultsOffset + 100);
el("scanUndo").onclick = () => view.scanBusy(async () => await ui.send("scanUndo") && view.scanRows(0));
el("scanSave").onclick = () => {
    const name = el("scanSaveName").value.trim();
    if (!name) return view.toast("Enter a name for the saved scan");
    view.scanBusy(async () => (r => r && view.savedBase(r.saved))(await ui.send("scanSave", { name })));
};
el("stringForm").onsubmit = e => {
    e.preventDefault();
    try {
        view.strBody = { encoding: el("strEncoding").value, minLength: num(el("strMinLength").value, "minimum length") ?? 4, lower: num(el("strSearchLower").value, "range"), upper: num(el("strSearchUpper").value, "range"), memory: ui.mem() };
    } catch (err) {
        return view.toast(err.message);
    }
    view.strings(0);
};
for (const id of ["results", "stringResults", "ptrResults"]) {
    const b = id === "stringResults" ? "strResults" : id;
    el(`${b}AddSelected`).onclick = () => view.addRows([...el(id).querySelectorAll(".select-row:checked")].map(cb => view.picks.get(cb)));
    el(`${b}AddAll`).onclick = async () => view.addRows(await view.allRows(id));
}
el("strResultsPrev").onclick = () => view.strings(view.strResultsOffset - 100);
el("strResultsNext").onclick = () => view.strings(view.strResultsOffset + 100);
document.addEventListener("cetus:state", ({ detail: { scan } }) => {
    if (!scan) return view.scanning && view.clearScan();
    view.scanning = true;
    el("searchType").value = scan.type;
    el("resultsTitle").textContent = `Found ${scan.count}`;
    view.savedBase(scan.saved ?? []);
    view.fillCompare();
    if (!el("results").childElementCount) view.scanRows(0);
});
document.addEventListener("cetus:reset", view.clearScan);
document.addEventListener("cetus:scanHotkey", () => view.scanRows(0));
document.addEventListener("cetus:state", ({ detail: { instances, active } }) => {
    const a = instances.find(i => i.id === active);
    const lines = [...a && !a.instrumented ? [`This instance is not instrumented, so saved patches were not applied: ${a.error}`] : [], ...(a?.warnings ?? []).map(w => `Patch callback failed: ${w}`)];
    Object.assign(el("patchNotice"), { hidden: !lines.length, textContent: lines.join("\n") });
});
el("functionFormSearch").onsubmit = e => {
    e.preventDefault();
    const v = el("functionInput").value.trim();
    if (!/^(0x[0-9a-f]+|\d+)$/i.test(v)) return view.toast("Invalid function index");
    view.openFunction(Number(v));
};
el("functionFilter").oninput = view.fnList;
el("exportsFilter").oninput = view.exportList;
el("codeSearchForm").onsubmit = e => (e.preventDefault(), view.codeSearch());
el("xrefsButton").onclick = () => view.fn && view.xrefs({ func: view.fn.index }, el("functionTitle").textContent.replace(/^Function/, "Callers of function"));
el("codeBack").onclick = () => {
    const b = view.back.pop();
    el("codeBack").disabled = !view.back.length;
    if (b) view.openFunction(b.index, b.offset, b.offset != null);
};
el("codeDisassembly").ondblclick = () => {
    const ta = el("codeDisassembly"), i = ta.value.slice(0, ta.selectionStart).split("\n").length - 1, l = view.runLine(i);
    const m = /^\s*(?:return_)?call\s+(\d+)\b/.exec(ta.value.split("\n")[i]);
    if (m && view.fn) view.jump(Number(m[1]), undefined, false, l && view.fn.bodyOffset + l.offset);
};
el("codeNop").onclick = () => view.nop();
el("codeAccesses").onclick = async () => {
    const s = view.codeSite();
    if (!s) return view.toast(view.fn ? "Instruction is not traceable" : "Open a function and select a line");
    const on = view.armed(s), r = await ui.send("accesses", { func: s.func, offset: s.offset, enabled: !on });
    if (!r) return;
    ui.state.accesses = r.accesses;
    if (!on) view.traced = s;
    view.hits();
};
for (const ev of ["click", "keyup"]) el("codeDisassembly").addEventListener(ev, () => view.codeAccesses());
el("codeBreakpoint").onclick = () => {
    const ta = el("codeDisassembly"), fn = view.fn;
    const i = ta.dataset.line ? ta.dataset.line - 1 : ta.value.slice(0, ta.selectionStart).split("\n").length - 1;
    const l = view.runLine(i);
    if (!fn || !l || l.offset < 0) return view.toast("Open a function and select a line");
    if (!fn.map) return view.toast("Breakpoints need an instrumented game: reload the page with Cetus Remastered active");
    const shown = ta.value.split("\n").map(s => s.replace(/\s*;;.*$/, "")).join("\n");
    if (shown !== view.fnLines.map(l => l.text).join("\n")) {
        return view.toast("Save or reopen the function before setting a breakpoint");
    }
    const offset = fn.map.find(([p]) => p >= l.offset)?.[1];
    if (offset == null) return view.toast("Cannot map this line to the original code");
    view.bpToggle(fn.index, offset);
};
el("patchTemplate").onchange = e => (view.template(e.target.value), e.target.value = "");
el("codeComment").onclick = async () => {
    const ta = el("codeDisassembly"), fn = view.fn, text = el("codeCommentText").value.trim(), i = ta.dataset.line ? ta.dataset.line - 1 : ta.value.slice(0, ta.selectionStart).split("\n").length - 1, l = view.runLine(i);
    if (!fn || !l || l.offset < 0) return view.toast("Open a function and select a line");
    if (ta.value.split("\n").map(s => s.replace(/\s*;;.*$/, "")).join("\n") !== view.fnLines.map(l => l.text).join("\n")) return view.toast("Save or reopen the function before commenting");
    await ui.annotations(n => ({ ...n, code: [...(n.code ?? []).filter(c => c.func !== fn.index || c.offset !== l.offset), ...text ? [{ func: fn.index, offset: l.offset, comment: text }] : []] }));
    const lines = ta.value.split("\n");
    lines[i] = text ? `${l.text} ;; ${text}` : l.text;
    view.setCode(lines.join("\n"), ta.dataset.line ? i : -1);
    el("codeCommentText").value = "";
};
for (const what of ["Original", "Instrumented"]) el(`dump${what}`).onclick = () => ui.send("dump", { what: what.toLowerCase() });
for (const ev of ["cetus:state", "cetus:reset"]) document.addEventListener(ev, () => {
    const a = ui.state?.instances.find(i => i.id === ui.state.active), k = a && `${a.id}:${a.hash}:${a.instrumented}`;
    if (ev === "cetus:reset" || k !== view.fnKey) (view.fnKey = k, view.functions());
});
el("openSavePatchModalButton").onclick = async () => {
    if (!view.fn) return view.toast("Open a function first");
    view.editing = null;
    await view.patchCallbacks();
    view.modal("savePatchModal", true);
};
el("closeSavePatchModalButton").onclick = () => view.modal("savePatchModal", false);
el("savePatchButton").onclick = view.savePatch;
el("patchName").onkeydown = e => e.key === "Enter" && view.savePatch();
el("patchName").onchange = () => view.patchCallbacks(true);
for (const b of ["openLoadPatchModalButton", "overlayLoadPatchModalButton"]) el(b).onclick = view.showPatches;
el("closeLoadPatchModalButton").onclick = () => view.modal("loadPatchModal", false);
for (const m of ["savePatchModal", "loadPatchModal"]) el(m).querySelector(".modal-overlay").onclick = () => view.modal(m, false);
view.fillCompare();
el("tableAddType").value = "i32";
el("tableAddType").onchange = e => el("tableAddLength").parentElement.hidden = !TEXT.includes(e.target.value);
el("tableAddForm").onsubmit = e => {
    e.preventDefault();
    const type = el("tableAddType").value, length = Number(el("tableAddLength").value);
    let loc;
    try { loc = locate(el("tableAddAddress").value); } catch (err) { return view.toast(err.message); }
    if (TEXT.includes(type) && !(Number.isInteger(length) && length > 0 && length <= 4096)) return view.toast("Length must be 1 to 4096");
    ui.addEntry({ description: "", address: loc.address ?? 0, ...loc.pointer && { pointer: loc.pointer }, type, ...TEXT.includes(type) && { length } });
};
el("tableBulkForm").onsubmit = e => (e.preventDefault(), view.bulk("set"));
el("tableBulkFreeze").onclick = () => view.bulk("freeze");
el("tableBulkRemove").onclick = () => view.bulk("remove");
el("tableExport").onclick = () => ui.exportBundle();
el("tableExportUserscript").onclick = () => ui.exportUserscript().catch(err => view.toast(err.message));
el("scriptForm").onsubmit = async e => {
    e.preventDefault();
    const name = el("scriptName").value.trim(), code = el("scriptCode").value, old = (await ui.scripts()).find(x => x.name === name);
    if (!name) return view.toast("Enter a script name");
    await ui.scripts(l => old ? l.map(x => x.name === name ? { ...x, code } : x) : [...l, { name, code, enabled: false }]);
    if (old?.enabled) view.scriptSet({ name, code }, true);
};
for (const ev of ["cetus:state", "cetus:scripts"]) document.addEventListener(ev, () => view.scriptList());
for (const ev of ["cetus:state", "cetus:types"]) document.addEventListener(ev, () => view.typeList());
el("customTypeForm").onsubmit = async e => {
    e.preventDefault();
    const c = { name: el("customTypeName").value.trim(), size: Number(el("customTypeSize").value),
        decode: el("customTypeDecode").value, encode: el("customTypeEncode").value };
    const list = await ui.customTypes();
    view.typeSave(list.some(x => x.name === c.name) ? list.map(x => x.name === c.name ? c : x) : [...list, c]);
};
document.addEventListener("cetus:scriptLog", ({ detail: d }) => view.scriptLog(`${d.name}: ${d.text}`));
document.addEventListener("cetus:scriptError", ({ detail: d }) => {
    view.scriptLog(`${d.name}: ${d.message}`, true);
    view.errTimer ??= setTimeout(() => (view.errTimer = null, ui.state && ui.refresh()), 250);
});
document.addEventListener("cetus:hotkeyError", ({ detail: d }) => view.toast(`Hotkey ${d.combo}: ${d.error}`));
el("jsCompare").append(...["eq", "ne", "lt", "lte", "gt", "gte", "unknown", "changed", "unchanged", "increased", "decreased"].map(o => new Option(OPS[o], o)));
el("jsForm").onsubmit = async e => {
    e.preventDefault();
    const compare = el("jsCompare").value, value = el("jsValue").value.trim();
    if (VALUED.includes(compare) && value) try { L.parseValue(value, "f64"); } catch (err) { return view.toast(err.message); }
    view.jsShow(await ui.send("jsScan", { compare, ...value && { value } }));
};
document.addEventListener("cetus:state", () => view.jsFrozen());
el("jsResetButton").onclick = async () => await ui.send("jsScanReset") && (el("jsCount").textContent = "", el("jsResults").replaceChildren());
el("hotkeyCombo").onkeydown = e => {
    if (!(e.ctrlKey || e.altKey || e.metaKey) || /^(Control|Alt|Shift|Meta)$/.test(e.key)) return;
    e.preventDefault();
    e.target.value = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta", e.code.replace(/^(Key|Digit)/, "")].filter(Boolean).join("+");
};
el("hotkeyAction").onchange = view.hotkeyForm;
const NEXT = Object.keys(OPS).filter(o => !["unknown", "between"].includes(o));
el("hotkeyCompare").append(...NEXT.map(o => new Option(OPS[o], o)));
el("hotkeyForm").onsubmit = async e => {
    e.preventDefault();
    const combo = norm(el("hotkeyCombo").value), action = el("hotkeyAction").value, raw = el("hotkeyEntry").value, value = el("hotkeyValue").value.trim();
    const needs = HK_ENTRY.includes(action), [address, type, m] = raw.split(":");
    const entry = raw.startsWith("p:") ? JSON.parse(raw.slice(2)) : type && { address: +address, type, ...m && { memory: +m } };
    const group = el("hotkeyGroup").value, script = el("hotkeyScript").value, speed = Number(value);
    const compare = el("hotkeyCompare").value, scanValued = action === "nextScan" && VALUED.includes(compare);
    const valued = ["set", "inc", "dec", "freeze", "setSpeed"].includes(action) || scanValued;
    const entries = (await ui.table()).filter(e => group && e.group === group && !TEXT.includes(e.type)).map(ident);
    if (!combo) return view.toast("Enter a key combination");
    if (needs && !entry) return view.toast("Add a numeric entry first");
    if (action === "set" && !value) return view.toast("Enter a value");
    if (needs && value && ["set", "inc", "dec", "freeze"].includes(action)) try { L.parseValue(value, entry.type); } catch (err) { return view.toast(err.message); }
    if (action === "setSpeed" && !(value && speed > 0 && speed <= 16)) return view.toast("Enter a speed above 0 and at most 16");
    if (action === "toggleGroup" && !entries.length) return view.toast("Choose a group with numeric entries");
    if (action === "toggleScript" && !script) return view.toast("Save a script first");
    if (scanValued && !value) return view.toast("Enter a value");
    if (action === "nextScan" && value) try { L.parseValue(value, "f64"); } catch (err) { return view.toast(err.message); }
    const extra = action === "toggleGroup" ? { group, entries } : action === "toggleScript" ? { script }
        : action === "nextScan" ? { compare } : needs ? { entry } : {};
    await ui.hotkeys(l => [...l.filter(h => h.combo !== combo), { combo, action, ...extra, ...value && valued && { value } }]);
    el("hotkeyCombo").value = "";
};
for (const ev of ["cetus:state", "cetus:hotkeys"]) document.addEventListener(ev, () => ui.hotkeys().then(l => (view.hotkeyList(l), ev === "cetus:hotkeys" && view.table())));
el("undoButton").onclick = view.undo;
document.addEventListener("keydown", e => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z" || e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    e.preventDefault();
    view.undo();
});
el("tableImport").onchange = async e => {
    const f = e.target.files[0];
    e.target.value = "";
    try { if (f) await ui.importBundle(await f.text()); } catch (err) { view.toast(err.message); }
    if (!el("tabGlobals").hidden) view.globals();
};
for (const ev of ["cetus:state", "cetus:table", "cetus:reset"]) document.addEventListener(ev, () => view.table());
el("table").addEventListener("change", e => e.target.type === "checkbox" || e.target.blur());
el("table").addEventListener("focusout", () => setTimeout(() => view.tableDue && !tableEdit() && view.table()));
for (const ev of ["cetus:state", "cetus:reset"]) document.addEventListener(ev, ({ detail }) => el("freezesSuspended").hidden = !detail?.freezesSuspended);
el("pauseButton").onclick = async () => (await ui.send("command", { name: "toggle-pause" }), ui.refresh());
document.addEventListener("cetus:state", ({ detail }) => el("pauseButton").textContent = detail?.speed === 0 ? "Resume" : "Pause");
el("tableHashAccept").onclick = async () => {
    const hash = ui.state?.instances.find(i => i.id === ui.state.active)?.hash;
    if (hash) await ui.bySite("tableHash", null, () => hash);
    view.table();
};
el("resumeFreezes").onclick = async () => (await ui.send("command", { name: "toggle-freezes" }), ui.refresh());
for (const ev of ["cetus:state", "cetus:hits", "cetus:reset"]) document.addEventListener(ev, view.hits);
for (const ev of ["cetus:state", "cetus:hits", "cetus:reset"]) document.addEventListener(ev, view.globalHits);
for (const ev of ["cetus:state", "cetus:hits", "cetus:reset"]) document.addEventListener(ev, () => view.breakpoints());
document.addEventListener("cetus:accesses", view.accesses);
document.addEventListener("cetus:state", () => {
    ui.options().then(o => (el("watchPrecise").checked = o.precise, el("coverageOn").checked = o.coverage));
    ui.request("traces").then(r => view.traceLog(r.calls), () => {});
});
document.addEventListener("cetus:traces", e => (view.traceLog(e.detail), view.stepLog()));
document.addEventListener("cetus:reset", () => (view.traceLog([]), view.grid("stepTrace", [], [])));
document.addEventListener("cetus:reset", () => (view.grid("codeFilterResults", [], []), el("codeFilterCount").textContent = ""));
el("coverageOn").onchange = async e => (await ui.options(o => ({ ...o, coverage: e.target.checked })), el("coverageNote").hidden = false);
for (const op of ["Start", "Executed", "NotExecuted", "Reset"]) el(`codeFilter${op}`).onclick = () => view.codeFilter(op[0].toLowerCase() + op.slice(1));
el("watchPrecise").onchange = async e => (await ui.options(o => ({ ...o, precise: e.target.checked })), el("watchPreciseNote").hidden = false);
document.querySelector(".fn-trace").onchange = async e => {
    const i = view.fn?.index;
    await ui.options(o => ({ ...o, trace: e.target.checked ? [...new Set([...o.trace, i])] : o.trace.filter(x => x !== i) }));
};
document.querySelector(".fn-steptrace").onchange = async e => {
    const i = view.fn?.index;
    const off = o => o.stepTrace.filter(s => s.func !== i);
    await ui.options(o => ({ ...o, stepTrace: e.target.checked ? [...off(o), { func: i, max: 1000 }] : off(o) }));
};
el("instanceSelect").onchange = async e => (await ui.send("select", { id: +e.target.value })) ? ui.refresh() : view.render(ui.state);
el("memorySelect").onchange = async e => {
    if (!await ui.send("selectMemory", { index: +e.target.value })) return view.render(ui.state);
    [view.memSel, view.memExt, view.memBack] = [null, null, []];
    await ui.refresh();
    view.memGo(0);
};
setInterval(view.live, 500);
el("memViewForm").onsubmit = e => {
    e.preventDefault();
    const v = addr(el("memViewStartAddress").value);
    if (v == null || v >= view.memMax()) return view.toast("Invalid address");
    view.memGo(v);
};
el("memViewPrevPage").onclick = () => view.memGo(view.memStart - view.memSize);
el("memViewNextPage").onclick = () => view.memGo(view.memStart + view.memSize);
el("memViewPageSize").onchange = e => (view.memSize = +e.target.value, view.memGo(view.memStart));
el("memViewDisplay").onchange = e => (view.memDisp = e.target.value, view.memPoll(true));
el("memViewPageForm").onsubmit = e => (e.preventDefault(), view.memGo((Math.max(1, Math.floor(+el("memViewPage").value) || 1) - 1) * view.memSize));
el("memViewPage").onchange = () => el("memViewPageForm").requestSubmit();
el("memViewGrid").ondblclick = view.memEdit;
el("memViewGrid").onclick = e => (s => s && !el("memViewByteInput") && (e.shiftKey && view.memSel != null ? view.memExt = { anchor: view.memSel, end: +s.dataset.address } : view.memPick(+s.dataset.address), view.memPoll(true)))(e.target.closest("span[data-address]"));
el("memViewGrid").onkeydown = e => {
    const k = e.target === e.currentTarget && (e.ctrlKey || e.metaKey) && e.key.toLowerCase();
    if (k === "c") e.preventDefault(), view.memCopy();
    if (k === "v") el("memPasteSink").value = "", el("memPasteSink").focus();
};
el("memPasteSink").onpaste = e => {
    const b = hexBytes(e.clipboardData.getData("text")), a = view.memRange()?.[0];
    e.preventDefault();
    el("memViewGrid").focus();
    if (a == null) return view.toast("Select a byte first");
    if (!b || b.length > 2 ** 20) return view.toast("Clipboard is not hex bytes (at most 1 MiB)");
    view.memWrite("writeBytes", { address: a, bytes: b });
};
el("memFindForm").onsubmit = e => (e.preventDefault(), view.memFind(false));
el("memFindNext").onclick = () => view.memFind(true);
el("memFillForm").onsubmit = e => {
    e.preventDefault();
    const n = addr(el("memFillLength").value), b = hexBytes(el("memFillBytes").value);
    if (!(n >= 1 && n <= 2 ** 20)) return view.toast("Length must be 1 to 1048576");
    if (!b) return view.toast("Invalid fill bytes");
    view.memWrite("writeBytes", { address: view.memSel ?? view.memStart, bytes: Array.from({ length: n }, (_, i) => b[i % b.length]) });
};
el("memViewFollow").onclick = async () => {
    const r = await ui.send("readValues", { items: [{ address: view.memSel ?? view.memStart, type: ptrType() }] });
    const v = r && r.values[0] != null ? Number(r.values[0]) : null;
    if (!r) return;
    if (v == null || v >= view.memMax()) return view.toast("Pointer is outside memory");
    view.memBack.push(view.memStart);
    view.memPick(v);
    view.memGo(v);
};
el("memViewBack").onclick = () => view.memBack.length && view.memGo(view.memBack.pop());
el("memViewAddEntry").onclick = () => ui.addEntry({ description: "", address: view.memSel ?? view.memStart, type: view.memType });
el("memViewBookmark").onclick = async () => {
    const address = view.memSel ?? view.memStart, label = el("memViewBookmarkLabel").value.trim() || hx(address), memory = ui.mem();
    const keep = m => m.address !== address || (m.memory ?? 0) !== memory;
    await ui.annotations(n => ({ ...n, memory: [...(n.memory ?? []).filter(keep), { address, label, ...memory && { memory } }] }));
    el("memViewBookmarkLabel").value = "";
    await view.bookmarks();
    view.memPoll(true);
};
el("memDump").onclick = () => ui.send("dump", { what: "memory", ...el("memDumpRange").value === "page" && { lower: view.memStart, upper: view.memStart + view.memSize } });
el("memSnapForm").onsubmit = e => {
    e.preventDefault();
    const name = el("snapName").value.trim();
    if (!name) return view.toast("Enter a snapshot name");
    view.snap("save", name).then(r => r && (el("snapName").value = ""));
};
el("memLoadFile").onchange = e => (f => (e.target.value = "", f && view.memLoad(f)))(e.target.files[0]);
document.addEventListener("cetus:state", () => (view.bookmarks(), view.structList(), view.snapshots(), el("memViewPageCount").textContent = `of ${Math.ceil(view.memMax() / view.memSize)}`));
el("structForm").onsubmit = e => (e.preventDefault(), view.structGo());
el("structSave").onclick = async () => {
    const name = el("structName").value.trim(), lay = view.struct.layout;
    if (!name) return view.toast("Enter a structure name");
    if (!view.struct.rows) return view.toast("Dissect an address first");
    const packed = view.structPack(lay, lay.name = name);
    await ui.annotations(n => ({ ...n, structs: [...(n.structs ?? []).filter(x => !packed.some(p => p.name === x.name)), ...packed] }));
    await view.structList();
    view.structDraw();
};
el("structLoad").onchange = async e => {
    const list = (await ui.annotations()).structs ?? [], name = e.target.value;
    e.target.value = "";
    if (!list.some(x => x.name === name)) return;
    view.struct.layout = view.structLoad(list, name, true);
    el("structName").value = name;
    el("structSize").value = Math.min(1024, Math.ceil(view.struct.layout.size / 4) * 4);
    if (addr(el("structAddress").value) != null) view.structGo();
};
setInterval(() => el("tabStruct").hidden || document.hidden || view.structPoll(), 500);
el("ptrType").value = "i32";
el("ptrForm").onsubmit = async e => {
    e.preventDefault();
    const a = addr(el("ptrAddress").value), depth = Number(el("ptrDepth").value), offset = addr(el("ptrOffset").value);
    if (a == null) return view.toast("Invalid address");
    [view.ptrTarget, view.ptrMem] = [a, ui.mem()];
    const r = await ui.send("pointerScan", { address: a, maxDepth: depth, maxOffset: offset, memory: view.ptrMem });
    if (r) view.ptrShow(r.rows);
};
el("ptrRescan").onclick = async () => {
    const v = el("ptrRescanValue").value.trim(), a = addr(el("ptrAddress").value);
    if (!v && a == null) return view.toast("Invalid address");
    if (!v) view.ptrTarget = a;
    const r = await ui.send("pointerRescan", { ...v ? { value: v, type: el("ptrType").value } : { address: a }, pointers: view.ptrAll, memory: view.ptrMem });
    if (r) view.ptrShow(r.rows);
};
el("ptrPrev").onclick = () => view.ptrList(view.ptrOffset - 100);
el("ptrNext").onclick = () => view.ptrList(view.ptrOffset + 100);
el("ptrMaxLevel").oninput = el("ptrBaseFilter").onchange = () => view.ptrList(0);
el("ptrAddAll").onclick = () => (l => l.length > 500 ? view.toast(`${l.length} chains match; narrow the filters to 500 or fewer`) : view.addRows(l.map(pointer => ({ pointer }))))(view.ptrFiltered());
document.addEventListener("cetus:state", () => view.ptrRestore());
setInterval(view.memPoll, 250);
setInterval(async () => {
    if (document.hidden || !ui.state) return;
    const k = s => JSON.stringify(s?.instances.map(i => [i.id, i.memoryBytes, i.memories?.map(m => m.bytes)])), s = await ui.request("state").catch(() => null);
    if (s && ui.state && k(s) !== k(ui.state)) ui.refresh();
}, 2000);
document.addEventListener("cetus:reset", () => (el("memViewGrid").replaceChildren(), el("snapshots").replaceChildren()));
el("tabGlobalsButton").addEventListener("click", () => view.globals());
document.addEventListener("cetus:state", () => el("tabGlobals").hidden || view.globals());
el("shRange").oninput = () => (view.gauge(), el("toggleSpeedhack").getAttribute("enabled") === "true" && view.speed(true));
el("toggleSpeedhack").onclick = () => view.speed(el("toggleSpeedhack").getAttribute("enabled") !== "true");
document.addEventListener("cetus:state", ({ detail: { speed } }) => {
    if (speed === 0) return;
    if (speed !== 1) el("shRange").value = speed;
    view.speedOn(speed !== 1);
    view.gauge();
});
view.gauge();
