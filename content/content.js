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
  const pending = new Map(), EVENTS = ["init", "hits", "reset", "accesses", "traces", "hotkey", "command", "scriptLog", "scriptError", "instances"];
  let seq = 0, live = false, config = null, src = null, asked = false;
  const out = detail => dispatchEvent(new CustomEvent("cetusMsgOut", { detail }));
  const sendSrc = () => src && out(JSON.stringify({ type: "workerSource", body: { src } }));
  const want = () => asked || (asked = true, chrome.runtime.sendMessage({ type: "src" })
    .then(s => typeof s === "string" ? sendSrc(src = s) : asked = false, () => asked = false));
  const sendConfig = () => config && (out(JSON.stringify({ type: "config", body: config })), sendSrc());
  let chain = Promise.resolve();
  const update = (name, f) => chain = chain.then(async () => {
    const site = location.host + location.pathname, all = (await chrome.storage.local.get(name))[name], list = all?.[site];
    if (Array.isArray(list)) await chrome.storage.local.set({ [name]: { ...all, [site]: list.map(f) } });
  }).catch(() => {});
  const persist = b => {
    const fs = b.entries ?? (b.entry ? [b] : []), same = (e, k) => e?.type === k?.type && (e.memory ?? 0) === (k.memory ?? 0)
      && (k.pointer != null ? JSON.stringify(e.pointer) === JSON.stringify(k.pointer) : e.pointer == null && e.address === k.address);
    if (fs.length) update("cheatTables", e => (f => f ? { ...e, frozen: !!f.frozen, freezeValue: f.frozen ? f.value : null } : e)(fs.find(f => same(e, f.entry))));
    if (typeof b.script === "string") update("scripts", s => s?.name === b.script ? { ...s, enabled: !!b.enabled } : s);
  };

  addEventListener("cetusMsgIn", e => {
    const d = e.detail;
    let m;
    if (typeof d !== "string" || d.length > 16777216) return;
    try { m = JSON.parse(d); } catch { return; }
    if (m?.id != null) return pending.get(m.id)?.(d), pending.delete(m.id);
    if (m?.type === "ready") return sendConfig();
    if (m?.type === "needSource") return void want();
    if (!EVENTS.includes(m?.type)) return;
    live = m.type !== "reset";
    if (m.type === "hotkey" && m.body && m.body.error == null) persist(m.body);
    try { chrome.runtime.sendMessage(d).catch(() => {}); } catch {}
  });

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    let m;
    try { m = JSON.parse(msg); } catch { return; }
    if (typeof m?.type !== "string") return;
    if (!live) return respond(JSON.stringify({ id: m.id, ok: false, error: "No WebAssembly instance in this frame" }));
    pending.set(++seq, respond);
    out(JSON.stringify({ id: seq, type: m.type, body: m.body }));
    return true;
  });

  const LIVE = ["cheatTables", "hotkeys", "scripts", "globalFreezes", "customTypes"];
  const build = async () => {
    const { savedPatches, instrumentOptions, cheatTables, hotkeys, scripts, globalFreezes, customTypes } =
      await chrome.storage.local.get(["savedPatches", "instrumentOptions", ...LIVE]);
    const patches = [], processor = [], preinstantiate = [], site = location.host + location.pathname;
    for (const p of Array.isArray(savedPatches) ? savedPatches : []) if (p?.url === site && p.enabled) {
      const list = p.version ? p.functionPatches ?? [] : [p];
      const fp = ({ index, bytes, space, locals }) => ({ index, bytes: Object.values(bytes ?? []), space, locals });
      patches.push(...list.map(fp));
      if (typeof p.callbacks?.processor === "string") processor.push(p.callbacks.processor);
      if (typeof p.callbacks?.preinstantiate === "string") preinstantiate.push(p.callbacks.preinstantiate);
    }
    const table = cheatTables?.[site], keys = hotkeys?.[site], list = scripts?.[site], globals = globalFreezes?.[site];
    const types = customTypes?.[site];
    config = { patches, callbacks: { processor, preinstantiate }, instrumentOptions: {
      precise: false, trace: [], globalWatch: [], coverage: false, breakpoints: [], stepTrace: [], ...instrumentOptions?.[site] },
      table: Array.isArray(table) ? table.filter(e => e?.frozen || e?.watch?.length) : [], hotkeys: Array.isArray(keys) ? keys : [], scripts: Array.isArray(list) ? list.filter(s => s?.enabled) : [],
      hotkeyScripts: Array.isArray(list) && Array.isArray(keys) ? list.filter(s => keys.some(k => k?.action === "toggleScript" && k.script === s?.name)) : [], globals: Array.isArray(globals) ? globals : [],
      customTypes: Array.isArray(types) ? types : [] };
  };
  build().then(sendConfig);
  chrome.storage.onChanged.addListener((ch, area) => {
    const site = location.host + location.pathname;
    const moved = k => ch[k] && JSON.stringify(ch[k].oldValue?.[site]) !== JSON.stringify(ch[k].newValue?.[site]);
    if (area !== "local" || !LIVE.some(moved)) return;
    build().then(() => out(JSON.stringify({ type: "config", body: config })));
  });
})();
