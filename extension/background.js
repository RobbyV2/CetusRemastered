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

let queue = Promise.resolve(), src = null;

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type === "src") {
    src ??= Promise.all(chrome.runtime.getManifest().content_scripts[0].js.map(f => fetch(chrome.runtime.getURL(f)).then(r => r.text()))).then(t => t.join("\n;\n"));
    src.then(respond, () => respond(src = null));
    return true;
  }
  if (msg?.type === "relay") {
    chrome.tabs.sendMessage(msg.tabId, msg.msg, { frameId: msg.frameId }).then(respond, e => respond({ relayError: e.message }));
    return true;
  }
  const tabId = sender.tab?.id, frameId = sender.frameId, key = `frame:${tabId}`;
  let m;
  try { m = JSON.parse(msg); } catch { return; }
  if (tabId == null || !["init", "reset"].includes(m?.type)) return;
  queue = queue.then(async () => {
    const old = (await chrome.storage.session.get(key))[key];
    if (m.type === "reset") {
      if (old && (frameId === old.frameId || frameId === 0)) await Promise.all([chrome.storage.session.remove(key), chrome.action.setBadgeText({ tabId, text: "" })]);
      return;
    }
    const worker = !!m.body?.instance?.worker, memoryBytes = m.body?.instance?.memoryBytes ?? 0, count = (old?.count ?? 0) + 1;
    const wins = !old || (worker ? old.worker && frameId === old.frameId : old.worker || memoryBytes >= old.memoryBytes);
    const f = wins ? { frameId, memoryBytes: Math.max(memoryBytes, worker && old ? old.memoryBytes : 0), worker, count } : { ...old, count };
    await Promise.all([chrome.storage.session.set({ [key]: f }), chrome.action.setBadgeText({ tabId, text: String(count) })]);
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(tabId => chrome.storage.session.remove(`frame:${tabId}`));

globalThis.onCommand = async (name, tab) => {
  const f = (await chrome.storage.session.get(`frame:${tab?.id}`))[`frame:${tab?.id}`];
  const r = JSON.parse(await chrome.tabs.sendMessage(tab.id, JSON.stringify({ id: 1, type: "command", body: { name } }), { frameId: f?.frameId ?? 0 }));
  return r.ok ? r.body : Promise.reject(new Error(r.error));
};
chrome.commands.onCommand.addListener((name, tab) => onCommand(name, tab).catch(() => {}));
