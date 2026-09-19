import { test, expect, chromium } from "@playwright/test";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve, buildGame, GAME } from "./fixture.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
let runs = 0;

export async function launch(bfcache = false) {
  const dir = `temp/profile-${process.pid}-${runs++}`;
  rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, { channel: "chromium", headless: true, ignoreDefaultArgs: bfcache ? ["--disable-back-forward-cache"] : [], args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`] });
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent("serviceworker");
  const worker = async () => ctx.serviceWorkers()[0] ?? ctx.waitForEvent("serviceworker");
  const id = new URL(sw.url()).host;
  const game = async (url, frame = false) => {
    const page = await ctx.newPage();
    await page.goto(url);
    const target = frame ? await (await page.waitForSelector("iframe")).contentFrame() : page;
    await target.waitForFunction(() => window.game?.readHealth);
    const tabId = (await (await worker()).evaluate(u => chrome.tabs.query({ url: u }), new URL(url).origin + "/*"))[0].id;
    return { page, target, tabId };
  };
  const ui = async (tabId, query = "", init) => {
    const page = await ctx.newPage(), errors = [];
    if (init) await page.addInitScript(init);
    page.on("console", m => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(`chrome-extension://${id}/extension/popupview.html?tabId=${tabId}${query}`);
    return { page, errors };
  };
  const badge = async tabId => (await worker()).evaluate(t => chrome.action.getBadgeText({ tabId: t }), tabId);
  return { ctx, id, worker, game, ui, badge, close: async () => { await ctx.close(); rmSync(dir, { recursive: true, force: true }); } };
}

let server;
const rate = async (page, elapsed, speed, span) => {
  await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.speed))).toBe(speed);
  const t0 = Date.now(), e0 = await elapsed(), t0b = Date.now();
  let a, e1;
  await expect.poll(async () => (a = Date.now(), e1 = await elapsed()) - e0).toBeGreaterThanOrEqual(span);
  return [(e1 - e0) / (Date.now() - t0), (e1 - e0) / (a - t0b)];
};
const frames = (target, f) => target.evaluate(f => new Promise(r => { const s = [], t = () => s.push(game[f]()) > 5 ? r(s) : requestAnimationFrame(t); t(); }), f);
test.beforeAll(async () => { server = await serve(); });
test.afterAll(() => server.close());

test.describe("fixture", () => {
  const modes = ["instantiateStreaming", "instantiate", "instantiateModule", "compile", "compileStreaming", "module"];
  for (const load of modes) for (const memory of ["", "&memory=import"]) {
    test(`fixture ${load}${memory}`, async ({ page }) => {
      await page.goto(`${server.url}/?load=${load}${memory}`);
      expect(await page.evaluate(async () => (await game.ready).readHealth())).toBe(100);
    });
  }
  test("fixture csp", async ({ page }) => {
    await page.goto(`${server.url}/csp`);
    expect(await page.evaluate(async () => { await game.ready; game.damage(1); return [game.readHealth(), game.level(), game.magic()]; })).toEqual([99, 3, -16]);
  });
  test("fixture frame", async ({ page }) => {
    await page.goto(`${server.url}/frame?load=module`);
    const frame = page.frames()[1];
    await frame.waitForFunction(() => window.game?.readHealth);
    expect(await frame.evaluate(() => game.readHealth())).toBe(100);
  });
});

test.describe("platform", () => {
  let x;
  test.beforeAll(async () => { x = await launch(); });
  test.afterAll(() => x.close());
  test.afterEach(async () => { for (const p of x.ctx.pages()) await p.close(); });

  const unlocked = async ({ page, errors }) => {
    await expect(page.locator("#lockOverlay")).toBeHidden();
    await expect(page.locator("#instanceHeader")).toHaveText(/^Instance/);
    await expect(page.locator("#instanceHeader")).not.toContainText("not instrumented");
    expect(errors).toEqual([]);
  };

  test("service worker is registered", async () => {
    expect((await x.worker()).url()).toBe(`chrome-extension://${x.id}/extension/background.js`);
  });

  for (const load of ["instantiateStreaming", "instantiate", "instantiateModule", "compile", "compileStreaming", "module"]) for (const memory of ["", "&memory=import"]) {
    test(`unlocks for ${load}${memory}`, async () => {
      const { tabId } = await x.game(`${server.url}/?load=${load}${memory}`);
      await unlocked(await x.ui(tabId));
      await expect.poll(() => x.badge(tabId)).toBe("1");
    });
  }

  test("unlocks under a strict CSP", async () => {
    const { tabId } = await x.game(`${server.url}/csp`);
    await unlocked(await x.ui(tabId));
  });

  test("unlocks against the iframe frameId", async () => {
    const { tabId } = await x.game(`${server.url}/frame?load=module`, true);
    const u = await x.ui(tabId);
    await unlocked(u);
    expect(await u.page.evaluate(() => ui.frameId)).toBeGreaterThan(0);
  });

  test("the worker source is fetched only once a page needs it", async () => {
    const sw = await x.worker(), count = () => sw.evaluate(() => globalThis.srcAsks);
    await sw.evaluate(() => globalThis.srcAsks ?? (globalThis.srcAsks = 0, chrome.runtime.onMessage.addListener(m => void (m?.type === "src" && globalThis.srcAsks++))));
    await sw.evaluate(() => globalThis.srcAsks = 0);
    const page = await x.ctx.newPage();
    await page.addInitScript(() => addEventListener("cetusMsgOut", e => String(e.detail).startsWith('{"type":"config"') && (window.configured = true)));
    await page.goto(`${server.url}/plain`);
    await page.waitForFunction(() => window.configured);
    expect(await page.evaluate(() => typeof cetusLib.register)).toBe("function");
    expect(await count()).toBe(0);
    const pong = () => page.evaluate(() => new Promise(r => {
      const w = new Worker(URL.createObjectURL(new Blob(["onmessage = () => postMessage(typeof cetusLib)"])));
      w.onmessage = e => r((w.terminate(), e.data));
      w.postMessage(0);
    }));
    expect(await pong()).toBe("object");
    expect(await count()).toBe(1);
    expect(await pong()).toBe("object");
    expect(await count()).toBe(1);
    await page.close();
    const { tabId } = await x.game(`${server.url}/`);
    await expect.poll(count).toBe(2);
    await unlocked(await x.ui(tabId));
  });

  test("a worker-only iframe does not take over the active frame", async () => {
    const { tabId } = await x.game(`${server.url}/mixed`);
    await expect.poll(() => x.badge(tabId)).toBe("2");
    const u = await x.ui(tabId);
    await unlocked(u);
    const rec = () => x.worker().then(sw => sw.evaluate(k => chrome.storage.session.get(k).then(r => r[k]), `frame:${tabId}`));
    expect(await rec()).toMatchObject({ frameId: 0, count: 2 });
    expect(await u.page.evaluate(() => ui.frameId)).toBe(0);
    await unlocked(await x.ui(tabId));
  });

  test("a worker-only game inside an iframe is reached and selected", async () => {
    const { page, tabId } = await x.game(`${server.url}/frame?bare=1&worker=classic`, true);
    const u = await x.ui(tabId), p = u.page, header = p.locator("#instanceHeader");
    await expect(header).toHaveText(/^Worker instance \d+ of 1, 64 KiB memory, instrumented$/);
    await page.reload();
    const target = await (await page.waitForSelector("iframe")).contentFrame();
    await target.waitForFunction(() => window.game?.readHealth);
    await expect(header).toHaveText(/^Worker instance \d+ of 1, 64 KiB memory, instrumented$/);
    expect(await p.evaluate(() => [ui.frameId > 0, ui.worker])).toEqual([true, true]);
    const rec = await (await x.worker()).evaluate(k => chrome.storage.session.get(k).then(r => r[k]), `frame:${tabId}`);
    expect(rec).toMatchObject({ frameId: await p.evaluate(() => ui.frameId), memoryBytes: 65536, worker: true });
    const id = await p.locator("#instanceSelect option").getAttribute("value");
    const read = () => p.evaluate(async id => {
      await ui.request("select", { id });
      return (await ui.request("readValues", { items: [{ address: 256, type: "i32" }] })).values[0];
    }, +id);
    expect(await read()).toBe(100);
    expect(await target.evaluate(() => game.workerDamage(3))).toBe(97);
    expect(await read()).toBe(97);
    expect(u.errors).toEqual([]);
  });

  test("reload locks and unlocks again", async () => {
    const { page, tabId } = await x.game(`${server.url}/`);
    const u = await x.ui(tabId);
    await unlocked(u);
    await u.page.evaluate(() => {
      window.lockSeen = false;
      new MutationObserver(() => lockSeen ||= !lockOverlay.hidden).observe(lockOverlay, { attributes: true });
    });
    await page.reload();
    await expect.poll(() => u.page.evaluate(() => lockSeen)).toBe(true);
    await unlocked(u);
    await expect.poll(() => x.badge(tabId)).toBe("1");
  });

  test("bfcache restore unlocks again", async () => {
    const b = await launch(true);
    try {
      const { page, tabId } = await b.game(`${server.url}/`);
      const u = await b.ui(tabId);
      await unlocked(u);
      await page.evaluate(() => { window.kept = true; });
      await page.goto(`${server.url}/game.js`);
      await expect(u.page.locator("#lockOverlay")).toBeVisible();
      await expect.poll(() => b.badge(tabId)).toBe("");
      await page.goBack({ waitUntil: "commit" });
      expect(await page.evaluate(() => window.kept)).toBe(true);
      await unlocked(u);
      await expect.poll(() => b.badge(tabId)).toBe("1");
      expect(await u.page.evaluate(async () => (await ui.request("state")).instances.length)).toBe(1);
    } finally { await b.close(); }
  });

  test("state round trip survives a stopped service worker", async () => {
    const { tabId } = await x.game(`${server.url}/`);
    const u = await x.ui(tabId);
    await unlocked(u);
    const cdp = await x.ctx.newCDPSession(u.page);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers");
    expect(await u.page.evaluate(async () => (await ui.request("state")).instances.length)).toBe(1);
    await unlocked(u);
  });

  test("devtools mode renders", async () => {
    const { tabId } = await x.game(`${server.url}/`);
    const u = await x.ui(tabId, "&devtools=1");
    await expect(u.page.locator("body.devtools")).toHaveCount(1);
    await unlocked(u);
  });

  test("two UI pages unlock at the same time", async () => {
    const { tabId } = await x.game(`${server.url}/`);
    const [a, b] = await Promise.all([x.ui(tabId), x.ui(tabId, "&devtools=1")]);
    await unlocked(a);
    await unlocked(b);
  });

  test("legacy v1 patch with object bytes applies", async () => {
    const host = new URL(server.url).host, sw = await x.worker();
    await sw.evaluate(u => chrome.storage.local.set({ savedPatches: [{ name: "v1", url: u, enabled: true, index: 8, bytes: { 0: 65, 1: 7, 2: 11 } }] }), `${host}/`);
    const { target, tabId } = await x.game(`${server.url}/`);
    expect(await target.evaluate(() => game.magic())).toBe(7);
    await unlocked(await x.ui(tabId));
    await sw.evaluate(() => chrome.storage.local.remove("savedPatches"));
  });

  test("tabs switch panes", async () => {
    const { tabId } = await x.game(`${server.url}/`);
    const u = await x.ui(tabId);
    for (const t of ["Strings", "Table", "MemView", "Patch", "Globals", "SpeedHack", "Search"]) {
      await u.page.click(`#tab${t}Button`);
      await expect(u.page.locator(".tabs-content:not([hidden])")).toHaveAttribute("id", `tab${t}`);
    }
    const bg = () => u.page.evaluate(() => document.documentElement.style.getPropertyValue("--background"));
    const scheme = () => u.page.evaluate(() => chrome.storage.local.get("colorScheme").then(r => r.colorScheme));
    await expect.poll(bg).toBe("#1F2430");
    await u.page.click("#toggleColorScheme");
    await expect.poll(scheme).toBe("WHITE");
    await expect.poll(bg).toBe("#F1F2F6");
    await u.page.reload();
    await expect.poll(bg).toBe("#F1F2F6");
    await u.page.click("#toggleColorScheme");
    await expect.poll(scheme).toBe("DARK");
    await expect.poll(bg).toBe("#1F2430");
    expect(u.errors).toEqual([]);
  });
});

test.describe("scan", () => {
  let x;
  test.beforeAll(async () => { x = await launch(); });
  test.afterAll(() => x.close());
  test.afterEach(async () => { for (const p of x.ctx.pages()) await p.close(); });

  const open = async init => {
    const g = await x.game(`${server.url}/`), u = await x.ui(g.tabId, "", init), p = u.page;
    await expect(p.locator("#lockOverlay")).toBeHidden();
    const scan = async (type, compare, value) => {
      await expect(p.locator("#searchButton")).toBeEnabled();
      if (await p.locator("#searchType").isEnabled()) await p.selectOption("#searchType", type);
      else await expect(p.locator("#searchType")).toHaveValue(type);
      await p.selectOption("#searchCompare", compare);
      if (value != null) await p.fill("#searchParam", value);
      await p.evaluate(() => resultsTitle.textContent = "");
      await p.click("#searchButton");
      await expect(p.locator("#resultsTitle")).toHaveText(/^Found \d+$/);
    };
    return { ...g, ...u, scan, rows: p.locator("#results tr[data-address]") };
  };

  test("exact value then next scan finds HEALTH", async () => {
    const { page, target, scan, rows, errors } = await open();
    await scan("i32", "eq", "100");
    await expect(page.locator("#searchButton")).toHaveText("Next Scan");
    await target.evaluate(() => game.damage(10));
    await scan("i32", "eq", "90");
    await expect(page.locator("#resultsTitle")).toHaveText("Found 1");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-address", "256");
    await target.evaluate(() => game.damage(5));
    await expect(rows.first().locator(".live")).toHaveText("85");
    expect(errors).toEqual([]);
  });

  test("unknown initial value narrows by decreased and unchanged", async () => {
    const { page, target, scan, rows } = await open();
    await scan("i32", "unknown");
    await target.evaluate(() => game.damage(3));
    await scan("i32", "decreased");
    await expect(page.locator("#searchParam")).toBeDisabled();
    await scan("i32", "unchanged");
    await expect(page.locator("#resultsTitle")).toHaveText("Found 1");
    await expect(rows.first()).toHaveAttribute("data-address", "256");
  });

  test("saved scans become compare bases that isolate HEALTH", async () => {
    const { page, target, scan, rows, tabId, errors } = await open(), base = page.locator("#searchBase option");
    await expect(page.locator("#scanSaveRow")).toBeHidden();
    await scan("i32", "unknown");
    const save = async name => {
      await page.fill("#scanSaveName", name);
      await page.click("#scanSave");
      await expect(page.locator(`#searchBase option[value="saved:${name}"]`)).toHaveText(`Saved: ${name}`);
    };
    await save("a");
    await target.evaluate(() => game.damage(10));
    await save("b");
    await target.evaluate(() => game.setHealth(100));
    await expect(base).toHaveCount(4);
    await page.selectOption("#searchBase", "saved:a");
    await scan("i32", "unchanged");
    await page.selectOption("#searchBase", "saved:b");
    await scan("i32", "incBy", "10");
    await expect(page.locator("#resultsTitle")).toHaveText("Found 1");
    await expect(rows.first()).toHaveAttribute("data-address", "256");
    expect(await target.evaluate(() => game.readHealth())).toBe(100);
    const other = (await x.ui(tabId, "")).page;
    await expect(other.locator("#searchBase option[value=\"saved:b\"]")).toHaveCount(1);
    await other.close();
    await page.click("#restartBtn");
    await expect(page.locator("#searchButton")).toHaveText("First Scan");
    await expect(base).toHaveCount(2);
    expect(errors).toEqual([]);
  });

  test("value types and New Scan", async () => {
    const { page, scan, rows } = await open();
    for (const [type, value, address] of [["f32", "1.5", 0x108], ["i16", "-5", 0x118], ["u64", "1234567890123", 0x110], ["utf16", "Hero", 0x200], ["aob", "DE AD ?? EF", 0x240]]) {
      if (await page.locator("#restartBtn").isEnabled()) await page.click("#restartBtn");
      await expect(page.locator("#searchButton")).toHaveText("First Scan");
      await scan(type, "eq", value);
      await expect(page.locator("#searchToleranceField")).toBeVisible({ visible: type === "f32" });
      await expect(page.locator(`#results tr[data-address="${address}"]`)).toHaveCount(1);
    }
    await expect(page.locator("#searchCompare option")).toHaveCount(1);
    await page.click("#restartBtn");
    await expect(page.locator("#searchButton")).toHaveText("First Scan");
    await expect(rows).toHaveCount(0);
  });

  test("invalid value shows an error", async () => {
    const { page } = await open();
    await page.selectOption("#searchType", "u8");
    await page.fill("#searchParam", "abc");
    await page.click("#searchButton");
    await expect(page.locator("#errorToast")).toBeVisible();
    await expect(page.locator("#searchButton")).toHaveText("First Scan");
  });

  test("strings lists PLAYER_ONE", async () => {
    const { page } = await open();
    await page.click("#tabStringsButton");
    await page.selectOption("#strEncoding", "ascii");
    await page.fill("#strMinLength", "4");
    await page.click("#strSearchButton");
    await expect(page.locator("#strResultsTitle")).toHaveText(/^Found \d+$/);
    await expect(page.locator('#stringResults tr[data-address="544"]')).toContainText("PLAYER_ONE");
  });

  test("utf8 search, table edit and strings", async () => {
    const sw = await x.worker();
    await sw.evaluate(() => chrome.storage.local.remove("cheatTables"));
    const { page, target, scan, rows, errors } = await open();
    await expect(page.locator('#strEncoding option[value="utf8"], #tableAddType option[value="utf8"], #memFindType option[value="utf8"]')).toHaveCount(3);
    await scan("utf8", "eq", "Héros");
    await expect(page.locator("#searchCaseField")).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-address", String(GAME.NAME_UTF8));
    await rows.first().locator(".add-entry").click();
    await page.click("#tabTableButton");
    const tr = page.locator(`#table tr[data-address="${GAME.NAME_UTF8}"]`), value = tr.locator(".entry-value");
    await expect(value).toHaveValue("Héros");
    await expect(tr.locator(".entry-length")).toHaveValue("6");
    await expect(tr.locator(".entry-length")).toBeEnabled();
    await value.fill("Zoë");
    await value.press("Enter");
    const raw = () => target.evaluate(a => [...new Uint8Array(game.raw.exports.memory.buffer, a, 6)], GAME.NAME_UTF8);
    await expect.poll(raw).toEqual([0x5A, 0x6F, 0xC3, 0xAB, 0x6F, 0x73]);
    await tr.locator(".entry-length").fill("4");
    await tr.locator(".entry-length").press("Enter");
    await expect(value).toHaveValue("Zoë");
    await target.evaluate(a => new Uint8Array(game.raw.exports.memory.buffer).set([0x48, 0xC3, 0xA9, 0x72, 0x6F, 0x73], a), GAME.NAME_UTF8);
    await page.click("#tabStringsButton");
    await page.selectOption("#strEncoding", "utf8");
    await page.fill("#strMinLength", "5");
    await page.click("#strSearchButton");
    await expect(page.locator(`#stringResults tr[data-address="${GAME.NAME_UTF8}"]`)).toContainText("Héros");
    expect(errors).toEqual([]);
  });

  test("add-entry persists in cheatTables", async () => {
    const { page, scan } = await open(), sw = await x.worker(), key = `${new URL(server.url).host}/`;
    await sw.evaluate(() => chrome.storage.local.remove("cheatTables"));
    await scan("i32", "eq", "100");
    for (let i = 0; i < 2; i++) await page.click('#results tr[data-address="256"] .add-entry');
    await expect.poll(() => sw.evaluate(k => chrome.storage.local.get("cheatTables").then(r => r.cheatTables?.[k]), key))
      .toEqual([{ description: "", address: 256, type: "i32" }]);
  });

  test("without chrome.tabs requests relay through the service worker", async () => {
    const sw = await x.worker();
    await sw.evaluate(() => chrome.storage.local.remove("cheatTables"));
    const { page, target, scan, errors } = await open(() => Object.defineProperty(chrome, "tabs", { value: undefined }));
    expect(await page.evaluate(() => typeof chrome.tabs)).toBe("undefined");
    await expect(page.locator("#instanceHeader")).toHaveText(/^Instance/);
    await scan("i32", "eq", "100");
    const hit = page.locator(`#results tr[data-address="${GAME.HEALTH}"]`);
    await expect(hit).toHaveCount(1);
    await hit.locator(".add-entry").click();
    await page.click("#tabTableButton");
    const value = page.locator(`#table tr[data-address="${GAME.HEALTH}"] .entry-value`);
    await expect(value).toHaveValue("100");
    await value.fill("555");
    await value.press("Enter");
    await expect.poll(() => target.evaluate(() => game.readHealth())).toBe(555);
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => { ui.tabId = 2 ** 30; return ui.request("state").then(() => "", e => e.message); })).not.toBe("");
    await expect(page.locator("#lockOverlay")).toBeVisible();
  });
});

test.describe("patch", () => {
  let x;
  test.beforeAll(async () => { x = await launch(); });
  test.afterAll(() => x.close());
  test.afterEach(async () => { for (const p of x.ctx.pages()) await p.close(); });

  const open = async () => {
    const g = await x.game(`${server.url}/`), u = await x.ui(g.tabId), p = u.page;
    await expect(p.locator("#lockOverlay")).toBeHidden();
    await p.click("#tabPatchButton");
    const fn = async index => {
      await p.fill("#functionInput", String(index));
      await p.click("#functionSearchButton");
      await expect(p.locator("#codeDisassembly")).not.toHaveValue("");
    };
    const magic = async () => {
      await g.page.reload();
      await g.page.waitForFunction(() => window.game?.readHealth);
      return g.page.evaluate(() => game.magic());
    };
    const stored = () => x.worker().then(sw => sw.evaluate(() => chrome.storage.local.get("savedPatches").then(r => r.savedPatches ?? [])));
    return { ...g, ...u, fn, magic, stored };
  };

  test("close button dismisses save patch modal without saving", async () => {
    const { page, fn, stored, errors } = await open();
    await (await x.worker()).evaluate(() => chrome.storage.local.remove("savedPatches"));
    await fn(8);
    await page.click("#openSavePatchModalButton");
    await expect(page.locator("#savePatchModal")).not.toHaveClass(/modal-hidden/);
    await page.fill("#patchName", "unsaved");
    await page.click("#closeSavePatchModalButton");
    await expect(page.locator("#savePatchModal")).toHaveClass(/modal-hidden/);
    expect(await stored()).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("save, disable, download and remove a patch", async () => {
    const { page, fn, magic, stored, errors } = await open();
    await (await x.worker()).evaluate(() => chrome.storage.local.remove("savedPatches"));
    await fn(8);
    await expect(page.locator("#codeDisassembly")).toHaveValue(/i32\.const 240\s+i32\.extend8_s\s+end/);
    await page.fill("#codeDisassembly", "i32.const 999\nend");
    await page.click("#openSavePatchModalButton");
    await page.fill("#patchName", "p1");
    await page.click("#savePatchButton");
    await expect(page.locator("#savePatchModal")).toHaveClass(/modal-hidden/);
    await expect.poll(stored).toEqual([{ name: "p1", url: `${new URL(server.url).host}/`, enabled: true, version: 2, functionPatches: [{ index: 6, bytes: [65, 231, 7, 11], space: "original" }] }]);
    expect(await magic()).toBe(999);

    await page.click("#openLoadPatchModalButton");
    await expect(page.locator("#loadedPatchesTable th")).toHaveCount(6);
    const row = page.locator('#loadedPatchesTable tr[data-name="p1"]');
    await expect(row.locator(".patch-enable")).toBeChecked();
    await row.locator(".patch-enable").uncheck();
    await expect.poll(async () => (await stored())[0].enabled).toBe(false);
    expect(await magic()).toBe(-16);

    const [download] = await Promise.all([page.waitForEvent("download"), row.locator(".patch-download").click()]);
    expect(download.suggestedFilename()).toBe("p1.cetus.json");
    const file = JSON.parse(readFileSync(await download.path(), "utf8"));
    expect(file).toMatchObject({ format: "cetus-remastered", version: 2, entries: [], patches: [{ name: "p1", functionPatches: [{ index: 6, bytes: [65, 231, 7, 11], space: "original" }] }] });

    await row.locator(".patch-remove").click();
    await expect(row).toHaveCount(0);
    await expect.poll(stored).toEqual([]);
    await page.click("#closeLoadPatchModalButton");
    await expect(page.locator("#loadPatchModal")).toHaveClass(/modal-hidden/);
    expect(errors).toEqual([]);
  });

  test("the lock overlay lists and removes saved patches", async () => {
    const sw = await x.worker(), url = `${server.url}/plain`, key = `${new URL(url).host}/plain`;
    const seeded = { name: "p1", url: key, enabled: true, version: 2, functionPatches: [{ index: 6, bytes: [65, 231, 7, 11], space: "original" }] };
    await sw.evaluate(p => chrome.storage.local.set({ savedPatches: [p] }), seeded);
    const gp = await x.ctx.newPage();
    await gp.goto(url);
    const tabId = (await sw.evaluate(u => chrome.tabs.query({ url: u }), url))[0].id, { page, errors } = await x.ui(tabId);
    await expect(page.locator("#lockOverlay")).toBeVisible();
    await page.click("#overlayLoadPatchModalButton");
    await expect(page.locator("#loadPatchModal")).toBeVisible();
    const rows = page.locator("#loadedPatchesTable tr[data-name]");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-name", "p1");
    await rows.first().locator(".patch-remove").click();
    await expect(rows).toHaveCount(0);
    await expect.poll(() => sw.evaluate(() => chrome.storage.local.get("savedPatches").then(r => r.savedPatches))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("template original on magicTail saves a canonical patch that stays instrumented across option changes", async () => {
    const { page, target, fn, magic, stored, errors } = await open(), sw = await x.worker(), key = `${new URL(server.url).host}/`, code = page.locator("#codeDisassembly");
    await sw.evaluate(() => chrome.storage.local.remove(["savedPatches", "instrumentOptions"]));
    await fn(16);
    await expect(page.locator("#functionTitle")).toContainText("magicTail");
    await page.fill("#codeDisassembly", "i32.const 1\nend");
    await page.selectOption("#patchTemplate", "original");
    await expect(code).toHaveValue("call 8\ndrop\nreturn_call 8\nend");
    await page.click("#openSavePatchModalButton");
    await page.fill("#patchName", "tail");
    await page.click("#savePatchButton");
    await expect(page.locator("#savePatchModal")).toHaveClass(/modal-hidden/);
    await expect.poll(stored).toEqual([{ name: "tail", url: key, enabled: true, version: 2, functionPatches: [{ index: 14, bytes: [0x10, 6, 0x1a, 0x12, 6, 0x0b], space: "original" }] }]);
    const live = () => page.evaluate(() => ui.request("state").then(s => s.instances.find(i => i.id === s.active)?.instrumented));
    for (const precise of [false, true]) {
      await sw.evaluate(([k, p]) => chrome.storage.local.set({ instrumentOptions: { [k]: { precise: p } } }), [key, precise]);
      expect(await magic()).toBe(-16);
      expect(await target.evaluate(() => [game.raw.exports.magicTail(), typeof game.raw.exports.__cetus_watch])).toEqual([-16, "function"]);
      await expect.poll(live).toBe(true);
    }
    await fn(16);
    await expect(code).toHaveValue("call 8\ndrop\nreturn_call 8\nend");
    await sw.evaluate(() => chrome.storage.local.remove(["savedPatches", "instrumentOptions"]));
    expect(errors).toEqual([]);
  });

  test("a patch with a scratch local doubles damage and reopens with its local line", async () => {
    const { page, target, fn, stored, errors } = await open(), sw = await x.worker(), code = page.locator("#codeDisassembly");
    await sw.evaluate(() => chrome.storage.local.remove("savedPatches"));
    const reload = async () => {
      await target.reload();
      await target.waitForFunction(() => window.game?.readHealth);
      await expect(page.locator("#lockOverlay")).toBeHidden();
    };
    const hit = () => target.evaluate(() => (game.setHealth(100), game.damage(10), game.readHealth()));
    await fn(4);
    await expect(page.locator("#functionTitle")).toHaveText("Function 4: damage (i32) -> ()");
    const text = await code.inputValue();
    expect(text.match(/local\.get 0/g)).toHaveLength(1);
    await page.fill("#codeDisassembly", `local i32\nlocal.get 0\ni32.const 2\ni32.mul\nlocal.set 1\n${text.replace("local.get 0", "local.get 1")}`);
    await page.click("#openSavePatchModalButton");
    await page.fill("#patchName", "double");
    await page.click("#savePatchButton");
    await expect(page.locator("#savePatchModal")).toHaveClass(/modal-hidden/);
    await expect.poll(async () => (await stored())[0]?.functionPatches).toEqual([{ index: 2, bytes: expect.any(Array), space: "original", locals: ["i32"] }]);
    expect(await hit()).toBe(90);
    await reload();
    expect(await hit()).toBe(80);
    expect(await page.evaluate(() => ui.request("state").then(s => s.instances.map(i => i.instrumented)))).toEqual([true]);
    await fn(4);
    await expect(page.locator("#functionTitle")).toHaveText("Function 4: damage (i32) -> () [locals: i32]");
    await expect(code).toHaveValue(/^local i32\nlocal\.get 0\ni32\.const 2\ni32\.mul\nlocal\.set 1\n/);
    await page.click("#openSavePatchModalButton");
    await page.click("#savePatchButton");
    await expect(page.locator("#savePatchModal")).toHaveClass(/modal-hidden/);
    await expect.poll(async () => (await stored())[0]?.history?.length).toBe(1);
    const [now] = await stored();
    expect(now.functionPatches).toEqual(now.history[0]);
    await reload();
    expect(await hit()).toBe(80);
    await fn(4);
    await page.fill("#codeDisassembly", (await code.inputValue()).replace("local i32\n", ""));
    await page.click("#openSavePatchModalButton");
    await page.click("#savePatchButton");
    await expect.poll(async () => (await stored())[0]?.history?.length).toBe(2);
    await reload();
    await expect(page.locator("#patchNotice")).toContainText("patched module failed");
    expect(await hit()).toBe(90);
    await sw.evaluate(() => chrome.storage.local.remove("savedPatches"));
    expect(errors).toEqual([]);
  });

  test("patch callbacks are saved from the modal, reloaded when a patch is opened, and run on reload", async () => {
    const { page, target, fn, stored, errors } = await open(), sw = await x.worker(), key = `${new URL(server.url).host}/`;
    await sw.evaluate(() => chrome.storage.local.remove("savedPatches"));
    const reload = async () => {
      await target.reload();
      await target.waitForFunction(() => window.game?.readHealth);
      await expect(page.locator("#lockOverlay")).toBeHidden();
    };
    const processor = ["const t = processor.addTypeEntry({ form: \"func\", params: [], returnType: \"i32\" });",
      "const f = processor.addFunctionEntry({ type: t });", "processor.addCodeEntry(f, { locals: [], code: [0x41, 42, 0x0b] });",
      "processor.addExportEntry(f, { fieldStr: \"cheat42\", kind: \"func\" });"].join("\n");
    const preinstantiate = "globalThis.preRan = module.length > 8 && typeof importObject;";
    await fn(8);
    await page.click("#openSavePatchModalButton");
    await expect(page.locator("#patchProcessor")).toHaveValue("");
    await page.fill("#patchName", "cb");
    await page.fill("#patchProcessor", processor);
    await page.fill("#patchPreinstantiate", preinstantiate);
    await page.click("#savePatchButton");
    await expect(page.locator("#savePatchModal")).toHaveClass(/modal-hidden/);
    await expect.poll(stored).toEqual([{ name: "cb", url: key, enabled: true, version: 2, functionPatches: [{ index: 6, bytes: [0x41, 0xf0, 0x01, 0xc0, 0x0b], space: "original" }],
      callbacks: { processor, preinstantiate } }]);
    expect(await target.evaluate(() => typeof game.raw.exports.cheat42)).toBe("undefined");
    await reload();
    expect(await target.evaluate(() => [game.raw.exports.cheat42(), window.preRan, game.magic()])).toEqual([42, "object", -16]);
    await expect(page.locator("#patchNotice")).toBeHidden();
    await page.evaluate(() => { el("patchName").value = "other"; el("patchProcessor").value = "stale"; });
    await page.click("#openSavePatchModalButton");
    await expect(page.locator("#patchProcessor")).toHaveValue("");
    await page.fill("#patchName", "cb");
    await page.locator("#patchName").blur();
    await expect(page.locator("#patchProcessor")).toHaveValue(processor);
    await page.click("#closeSavePatchModalButton");
    await page.evaluate(() => { el("patchName").value = ""; el("patchProcessor").value = ""; });
    await page.click("#openLoadPatchModalButton");
    await page.click('#loadedPatchesTable tr[data-name="cb"] .patch-name');
    await expect(page.locator("#loadPatchModal")).toHaveClass(/modal-hidden/);
    await expect(page.locator("#savePatchModal")).not.toHaveClass(/modal-hidden/);
    await expect(page.locator("#patchName")).toHaveValue("cb");
    await expect(page.locator("#patchProcessor")).toHaveValue(processor);
    await expect(page.locator("#patchPreinstantiate")).toHaveValue(preinstantiate);
    await page.fill("#patchProcessor", "throw new Error('processor failed')");
    await page.fill("#patchPreinstantiate", "syntax error here(");
    await page.click("#savePatchButton");
    await expect.poll(async () => (await stored())[0].callbacks.processor).toBe("throw new Error('processor failed')");
    await reload();
    await expect(page.locator("#patchNotice")).toContainText("Patch callback failed: processor failed");
    await expect(page.locator("#patchNotice")).toContainText(/Patch callback failed: .*(Unexpected|token|missing)/i);
    expect(await target.evaluate(() => typeof game.raw.exports.cheat42)).toBe("undefined");
    await page.click("#openSavePatchModalButton");
    await page.fill("#patchProcessor", "");
    await page.fill("#patchPreinstantiate", "");
    await page.click("#savePatchButton");
    await expect.poll(async () => (await stored())[0].callbacks).toBeUndefined();
    await reload();
    await expect(page.locator("#patchNotice")).toBeHidden();
    await sw.evaluate(() => chrome.storage.local.remove("savedPatches"));
    expect(errors).toEqual([]);
  });

  test("editing callbacks from the patch list leaves function patches alone whatever function is open", async () => {
    const { page, fn, stored, errors } = await open(), sw = await x.worker(), url = `${new URL(server.url).host}/`;
    const seed = { name: "cb", url, enabled: false, version: 2, functionPatches: [{ index: 6, bytes: [0x41, 0x01, 0x0b], space: "original" }],
      callbacks: { processor: "globalThis.p1 = 1;" } };
    await sw.evaluate(p => chrome.storage.local.set({ savedPatches: [p] }), seed);
    const edit = async (field, value) => {
      await page.click("#openLoadPatchModalButton");
      await page.click('#loadedPatchesTable tr[data-name="cb"] .patch-name');
      await expect(page.locator("#savePatchModal")).not.toHaveClass(/modal-hidden/);
      await page.fill(field, value);
      await page.click("#savePatchButton");
      await expect(page.locator("#savePatchModal")).toHaveClass(/modal-hidden/);
    };
    await edit("#patchProcessor", "globalThis.p2 = 2;");
    await expect.poll(stored).toEqual([{ ...seed, callbacks: { processor: "globalThis.p2 = 2;" } }]);
    await fn(4);
    await page.fill("#codeDisassembly", "i32.const 7\nend");
    await edit("#patchPreinstantiate", "globalThis.p3 = 3;");
    await expect.poll(stored).toEqual([{ ...seed, callbacks: { processor: "globalThis.p2 = 2;", preinstantiate: "globalThis.p3 = 3;" } }]);
    await page.click("#openSavePatchModalButton");
    await page.fill("#patchName", "cb");
    await page.locator("#patchName").blur();
    await expect(page.locator("#patchProcessor")).toHaveValue("globalThis.p2 = 2;");
    await page.fill("#patchName", "fresh");
    await page.locator("#patchName").blur();
    await expect(page.locator("#patchProcessor")).toHaveValue("");
    await expect(page.locator("#patchPreinstantiate")).toHaveValue("");
    await page.fill("#patchProcessor", "typed");
    await page.fill("#patchName", "fresh2");
    await page.locator("#patchName").blur();
    await expect(page.locator("#patchProcessor")).toHaveValue("typed");
    await page.click("#closeSavePatchModalButton");
    await fn(4);
    for (const [name, save] of [["renamed", () => page.click("#savePatchButton")], ["entered", () => page.press("#patchName", "Enter")]]) {
      await page.click("#openSavePatchModalButton");
      await page.fill("#patchName", "cb");
      await page.locator("#patchName").blur();
      await expect(page.locator("#patchProcessor")).toHaveValue("globalThis.p2 = 2;");
      await page.fill("#patchName", name);
      await save();
      await expect(page.locator("#savePatchModal")).toHaveClass(/modal-hidden/);
      await expect.poll(async () => (await stored()).some(p => p.name === name)).toBe(true);
      const saved = (await stored()).find(p => p.name === name);
      expect([saved.callbacks, saved.functionPatches.length]).toEqual([undefined, 1]);
    }
    expect((await stored())[0]).toEqual({ ...seed, callbacks: { processor: "globalThis.p2 = 2;", preinstantiate: "globalThis.p3 = 3;" } });
    await sw.evaluate(() => chrome.storage.local.remove("savedPatches"));
    expect(errors).toEqual([]);
  });

  test("bad text shows the assembler line", async () => {
    const { page, fn, stored } = await open();
    await fn(8);
    await page.fill("#codeDisassembly", "i32.const 1\ni32.bogus\nend");
    await page.click("#openSavePatchModalButton");
    await page.fill("#patchName", "bad");
    await page.click("#savePatchButton");
    await expect(page.locator("#asmError")).toBeVisible();
    await expect(page.locator("#asmError")).toContainText("Line 2");
    expect(await stored()).toEqual([]);
  });

  test("openFunction highlights the access line", async () => {
    const { page } = await open();
    await page.evaluate(() => view.openFunction(2, 1e9));
    const lines = (await page.locator("#codeDisassembly").inputValue()).split("\n");
    await expect(page.locator("#codeDisassembly")).toHaveAttribute("data-line", String(lines.findLastIndex(l => l.includes("i32.load")) + 1));
    await expect(page.locator("pre[data-line] .line-highlight")).toHaveCount(1);
    await expect(page.locator("#patchNotice")).toBeHidden();
    await page.evaluate(() => ui.emit("cetus:state", { ...ui.state, instances: ui.state.instances.map(i => ({ ...i, instrumented: false, error: "boom" })) }));
    await expect(page.locator("#patchNotice")).toContainText("not instrumented");
    await page.evaluate(() => view.openFunction(2));
    await expect(page.locator("#codeDisassembly")).not.toHaveAttribute("data-line");
  });

  test("SIMD function disassembles, reassembles and patches", async () => {
    const { page, target, fn, stored, errors } = await open();
    await (await x.worker()).evaluate(() => chrome.storage.local.remove("savedPatches"));
    await fn(14);
    await expect(page.locator("#functionTitle")).toContainText("simdSet");
    await expect(page.locator("#codeDisassembly")).toHaveValue(/local\.get 0\ni32x4\.splat\nv128\.store align=4 offset=1280\n/);
    await page.fill("#codeDisassembly", "i32.const 0\nlocal.get 0\ni32x4.splat\nv128.const i32x4 1 2 3 0xFFFFFFFF\ni32x4.add\nv128.store align=4 offset=1280\nend");
    await page.click("#openSavePatchModalButton");
    await page.fill("#patchName", "simd");
    await page.click("#savePatchButton");
    await expect(page.locator("#savePatchModal")).toHaveClass(/modal-hidden/);
    await expect.poll(async () => (await stored())[0]?.functionPatches[0].bytes.slice(4, 8)).toEqual([0xfd, 0x11, 0xfd, 0x0c]);
    await target.reload();
    await target.waitForFunction(() => window.game?.simdSet);
    expect(await target.evaluate(() => { game.simdSet(10); const dv = new DataView(game.raw.exports.memory.buffer); return [0, 4, 8, 12].map(o => dv.getInt32(0x500 + o, true)); }))
      .toEqual([11, 12, 13, 9]);
    await (await x.worker()).evaluate(() => chrome.storage.local.remove("savedPatches"));
    expect(errors).toEqual([]);
  });
});

test.describe("table", () => {
  let x;
  test.beforeAll(async () => { x = await launch(); });
  test.afterAll(() => x.close());
  test.afterEach(async () => { for (const p of x.ctx.pages()) await p.close(); });

  const open = async () => {
    const g = await x.game(`${server.url}/`), u = await x.ui(g.tabId), p = u.page;
    await expect(p.locator("#lockOverlay")).toBeHidden();
    await p.click("#tabTableButton");
    const row = a => p.locator(`#table tr[data-address="${a}"]`);
    const add = async (address, type) => {
      await p.fill("#tableAddAddress", address);
      await p.selectOption("#tableAddType", type);
      await p.click("#tableAddButton");
    };
    return { ...g, ...u, row, add };
  };
  const game = (t, f) => t.evaluate(f);

  test("watch hits show last values and a clickable call stack", async () => {
    const sw = await x.worker();
    await sw.evaluate(() => chrome.storage.local.clear());
    const { page, target, row, add } = await open();
    await add("0x100", "i32");
    await page.check("#watchBreak");
    await row(256).locator(".entry-watch-write").check();
    await expect.poll(() => page.evaluate(() => ui.state.watches.map(w => w.break))).toEqual([true]);
    await game(target, () => game.damage(1));
    const hit = page.locator("#hits tr[data-func][data-offset]");
    await expect(hit.locator(".hit-last")).toHaveText("100 -> 99");
    await hit.locator(".hit-stack").click();
    const frame = page.locator("#hitStack tr[data-func][data-offset]");
    await expect(frame).not.toHaveCount(0);
    await expect(page.locator("#tabTable")).toBeVisible();
    await frame.first().click();
    await expect(page.locator("#tabPatch")).toBeVisible();
    await expect(page.locator("#codeDisassembly")).toHaveAttribute("data-line", /^\d+$/);
    await page.click("#tabTableButton");
    await row(256).locator(".entry-watch-write").uncheck();
    await expect.poll(() => page.evaluate(() => ui.state.watches.length)).toBe(0);
  });

  test("a hit's NOP button patches the store out after a reload", async () => {
    const sw = await x.worker(), stored = async () => (await sw.evaluate(() => chrome.storage.local.get("savedPatches"))).savedPatches ?? [];
    await sw.evaluate(() => chrome.storage.local.clear());
    const { page, target, row, add } = await open(), toast = page.locator("#errorToast"), ta = page.locator("#codeDisassembly");
    await add("0x100", "i32");
    await row(256).locator(".entry-watch-write").check();
    await expect.poll(() => page.evaluate(() => ui.state.watches.length)).toBe(1);
    await game(target, () => game.damage(1));
    await page.locator("#hits tr[data-func] .hit-nop").click();
    await expect(page.locator("#tabPatch")).toBeVisible();
    await expect(toast).toHaveText("Reload the game to apply");
    await expect(ta).toHaveValue(/i32\.sub\ndrop\ndrop\nglobal\.get/);
    await expect(ta).not.toHaveValue(/i32\.store/);
    await expect.poll(async () => (await stored()).map(p => p.name)).toEqual([expect.stringMatching(/^nop 4@0x[0-9A-F]+$/)]);
    await page.click("#codeNop");
    await expect.poll(async () => (await stored())[0].history?.length).toBe(1);
    await page.evaluate(() => (view.toastTimer = clearTimeout(view.toastTimer), el("errorToast").hidden = true));
    await page.evaluate(() => { const t = el("codeDisassembly"); delete t.dataset.line; t.setSelectionRange(t.value.length, t.value.length); });
    await page.click("#codeNop");
    await expect(toast).toHaveText("Cannot replace this instruction");
    expect((await stored()).length).toBe(1);
    await target.reload();
    await target.waitForFunction(() => window.game?.damage);
    expect(await game(target, () => (game.damage(30), game.readHealth()))).toBe(100);
    await page.reload();
    await expect(page.locator("#lockOverlay")).toBeHidden();
    await page.click("#tabPatchButton");
    await page.click("#openLoadPatchModalButton");
    const patch = page.locator('#loadedPatchesTable tr[data-name^="nop 4@"]');
    await expect(patch).toHaveCount(1);
    await expect(patch.locator(".patch-revert")).toBeEnabled();
    await sw.evaluate(() => chrome.storage.local.clear());
  });

  test("freeze, edit, persist, watch and import/export", async () => {
    const sw = await x.worker(), key = `${new URL(server.url).host}/`;
    await sw.evaluate(() => chrome.storage.local.clear());
    const { page, target, row, add, errors } = await open();
    await add("0x100", "i32");
    await add("260", "u32");
    await expect(page.locator("#table tr[data-address]")).toHaveCount(2);
    await expect(row(256).locator(".entry-value")).toHaveValue("100");
    await row(256).locator(".entry-desc").fill("health");
    await row(256).locator(".entry-desc").press("Enter");
    await expect.poll(() => sw.evaluate(k => chrome.storage.local.get("cheatTables").then(r => r.cheatTables[k][0].description), key)).toBe("health");

    for (const a of [256, 260]) await row(a).locator(".entry-freeze").check();
    await expect.poll(() => page.evaluate(() => ui.state.freezes.length)).toBe(2);
    expect(await game(target, () => new Promise(r => { game.damage(50); let n = 0; const f = () => game.readHealth() === 100 || ++n > 3 ? r(game.readHealth()) : requestAnimationFrame(f); requestAnimationFrame(f); }))).toBe(100);
    for (const a of [256, 260]) await row(a).locator(".entry-freeze").uncheck();
    await expect.poll(() => page.evaluate(() => ui.state.freezes.length)).toBe(0);
    await game(target, () => game.damage(50));
    expect(await game(target, () => game.readHealth())).toBe(50);

    await row(260).locator(".entry-value").fill("777");
    await row(260).locator(".entry-value").press("Enter");
    await expect.poll(() => game(target, () => game.readGold())).toBe(777);

    await target.reload();
    await target.waitForFunction(() => window.game?.readHealth);
    await page.reload();
    await expect(page.locator("#lockOverlay")).toBeHidden();
    await page.click("#tabTableButton");
    await expect(page.locator("#table tr[data-address]")).toHaveCount(2);
    await expect(row(256).locator(".entry-desc")).toHaveValue("health");

    await row(256).locator(".entry-watch-write").check();
    await expect.poll(() => page.evaluate(() => ui.state.watches.length)).toBe(1);
    for (let i = 0; i < 3; i++) await game(target, () => game.damage(1));
    const hit = page.locator("#hits tr[data-func][data-offset]");
    await expect(hit).toHaveCount(1);
    await expect(hit.locator(".hit-count")).toHaveText("3");
    await row(256).locator(".entry-watch-write").uncheck();
    await expect.poll(() => page.evaluate(() => ui.state.watches.length)).toBe(0);
    await game(target, () => game.damage(1));
    expect(await game(target, () => cetusLib.handle("state", {}).then(s => s.hits))).toEqual([]);
    await expect(hit.locator(".hit-count")).toHaveText("3");
    await hit.click();
    await expect(page.locator("#tabPatch")).toBeVisible();
    await expect(page.locator("#codeDisassembly")).toHaveAttribute("data-line", /^\d+$/);
    const line = +(await page.locator("#codeDisassembly").getAttribute("data-line"));
    expect((await page.locator("#codeDisassembly").inputValue()).split("\n")[line - 1]).toContain("store");

    const patch = { name: "p", url: key, enabled: false, version: 2, functionPatches: [{ index: 8, bytes: [65, 7, 11] }, { index: 5, bytes: [65, 9, 11], space: "original" }] };
    await sw.evaluate(p => chrome.storage.local.set({ savedPatches: [p] }), patch);
    await page.click("#tabTableButton");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#tableExport")]);
    expect(download.suggestedFilename()).toMatch(/\.cetus\.json$/);
    const file = await download.path();
    await sw.evaluate(() => chrome.storage.local.clear());
    await page.evaluate(() => view.table());
    await expect(page.locator("#table tr[data-address]")).toHaveCount(0);
    await page.setInputFiles("#tableImport", file);
    await expect(page.locator("#table tr[data-address]")).toHaveCount(2);
    await expect(row(256).locator(".entry-desc")).toHaveValue("health");
    expect(await sw.evaluate(() => chrome.storage.local.get("savedPatches").then(r => r.savedPatches))).toEqual([patch]);

    const legacy = { name: "old", url: key, enabled: true, index: 8, bytes: [65, 231, 7, 11] };
    await page.setInputFiles("#tableImport", { name: "old.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(legacy)) });
    await expect.poll(() => sw.evaluate(() => chrome.storage.local.get("savedPatches").then(r => r.savedPatches.find(p => p.name === "old")))).toEqual(
      { name: "old", url: key, enabled: true, version: 2, functionPatches: [{ index: 8, bytes: [65, 231, 7, 11] }] });
    const bad = { format: "cetus-remastered", version: 1, entries: [], patches: [{ name: "bad", url: key, enabled: true, index: 1.5, bytes: [1] }, { name: "bad2", url: key, version: 2, functionPatches: [{ index: 8, bytes: [300] }] },
      { name: "good", url: key, enabled: 1, version: 2, functionPatches: [{ index: 8, bytes: { 0: 65, 1: 7, 2: 11 } }] }] };
    await page.setInputFiles("#tableImport", { name: "bad.cetus.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bad)) });
    await expect.poll(() => sw.evaluate(() => chrome.storage.local.get("savedPatches").then(r => r.savedPatches.map(p => p.name)))).toEqual(["p", "old", "good"]);
    expect((await sw.evaluate(() => chrome.storage.local.get("savedPatches").then(r => r.savedPatches)))[2]).toEqual({ name: "good", url: key, enabled: true, version: 2, functionPatches: [{ index: 8, bytes: [65, 7, 11] }] });
    await sw.evaluate(() => chrome.storage.local.get("savedPatches").then(r => chrome.storage.local.set({ savedPatches: r.savedPatches.slice(0, 2) })));
    await target.reload();
    await target.waitForFunction(() => window.game?.readHealth);
    expect(await game(target, () => game.magic())).toBe(999);
    expect(errors).toEqual([]);
  });

  test("importing callbacks asks for confirmation", async () => {
    const sw = await x.worker(), key = `${new URL(server.url).host}/`;
    await sw.evaluate(() => chrome.storage.local.clear());
    const { page } = await open();
    const dialogs = [];
    page.on("dialog", d => { dialogs.push(d.message()); d.dismiss(); });
    const bundle = { format: "cetus-remastered", version: 1, site: key, entries: [{ description: "", address: 256, type: "i32" }],
      patches: [{ name: "cb", url: key, enabled: true, version: 2, functionPatches: [], callbacks: { processor: "1" } }] };
    await page.setInputFiles("#tableImport", { name: "cb.cetus.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bundle)) });
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toContain("JavaScript");
    expect(await sw.evaluate(() => chrome.storage.local.get(null))).toEqual({});
    page.removeAllListeners("dialog");
    page.on("dialog", d => d.accept());
    await page.setInputFiles("#tableImport", { name: "cb.cetus.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bundle)) });
    await expect(page.locator("#table tr[data-address]")).toHaveCount(1);
    expect((await sw.evaluate(() => chrome.storage.local.get("savedPatches"))).savedPatches[0].name).toBe("cb");
  });

  test("a throwing processor callback shows in the patch notice", async () => {
    const sw = await x.worker(), key = `${new URL(server.url).host}/`;
    await sw.evaluate(p => chrome.storage.local.set({ savedPatches: [p] }), { name: "cb", url: key, enabled: true, version: 2, functionPatches: [], callbacks: { processor: "throw new Error('boom')" } });
    const { page, target } = await open();
    await target.reload();
    await target.waitForFunction(() => window.game?.readHealth);
    await expect(page.locator("#lockOverlay")).toBeHidden();
    await page.click("#tabPatchButton");
    await expect(page.locator("#patchNotice")).toBeVisible();
    await expect(page.locator("#patchNotice")).toHaveText("Patch callback failed: boom");
    expect(await page.evaluate(() => ui.request("state").then(s => s.instances.map(i => [i.instrumented, i.warnings])))).toEqual([[true, ["boom"]]]);
    await sw.evaluate(() => chrome.storage.local.remove("savedPatches"));
  });

  test("open in tab moves the popup to a tab that imports", async () => {
    const sw = await x.worker(), key = `${new URL(server.url).host}/`;
    await sw.evaluate(() => chrome.storage.local.clear());
    const g = await x.game(`${server.url}/`);
    for (const q of ["", "&devtools=1"]) {
      const { page } = await x.ui(g.tabId, q);
      await expect(page.locator("#openTab")).toBeHidden();
      await page.close();
    }
    await g.page.bringToFront();
    const url = `chrome-extension://${x.id}/extension/popupview.html`;
    const [popup] = await Promise.all([x.ctx.waitForEvent("page", p => p.url() === url), sw.evaluate(u => chrome.tabs.create({ url: u, active: false }), url)]);
    await expect(popup.locator("#lockOverlay")).toBeHidden();
    expect(await popup.evaluate(() => ui.tabId)).toBe(g.tabId);
    await popup.click("#tabTableButton");
    await expect(popup.locator("#openTab")).toBeVisible();
    const [tab] = await Promise.all([x.ctx.waitForEvent("page", p => p.url().endsWith(`popupview.html?tabId=${g.tabId}`)), popup.click("#openTab")]);
    await expect.poll(() => popup.isClosed()).toBe(true);
    const errors = [];
    tab.on("pageerror", e => errors.push(e.message));
    await expect(tab.locator("#lockOverlay")).toBeHidden();
    await expect(tab.locator("#instanceHeader")).toHaveText(/^Instance/);
    await tab.click("#tabTableButton");
    await expect(tab.locator("#openTab")).toBeHidden();
    const bundle = { format: "cetus-remastered", version: 2, site: key, entries: [{ description: "hp", address: GAME.HEALTH, type: "i32" }], patches: [] };
    await tab.setInputFiles("#tableImport", { name: "t.cetus.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bundle)) });
    await expect(tab.locator(`#table tr[data-address="${GAME.HEALTH}"] .entry-desc`)).toHaveValue("hp");
    await expect(tab.locator(`#table tr[data-address="${GAME.HEALTH}"] .entry-value`)).toHaveValue("100");
    expect(errors).toEqual([]);
  });
});

test.describe("tools", () => {
  let x;
  test.beforeAll(async () => { x = await launch(); });
  test.afterAll(() => x.close());
  test.afterEach(async () => { for (const p of x.ctx.pages()) await p.close(); });

  const open = async tab => {
    const g = await x.game(`${server.url}/`), u = await x.ui(g.tabId), p = u.page;
    await expect(p.locator("#lockOverlay")).toBeHidden();
    await p.click(`#tab${tab}Button`);
    return { ...g, ...u };
  };

  test("memory view goes, pages, clamps and edits bytes", async () => {
    const { page, target, errors } = await open("MemView");
    const byte = a => page.locator(`#memViewGrid span[data-address="${a}"]`);
    await page.fill("#memViewStartAddress", "0x100");
    await page.click("#memViewGo");
    for (const [i, v] of ["64", "00", "00", "00"].entries()) await expect(byte(256 + i)).toHaveText(v);
    await expect(page.locator("#memViewGrid span[data-address]")).toHaveCount(512);
    await byte(256).dblclick();
    await page.fill("#memViewByteInput", "7B");
    await page.press("#memViewByteInput", "Enter");
    await expect.poll(() => target.evaluate(() => game.readHealth())).toBe(123);
    await expect(byte(256)).toHaveText("7B");
    await page.click("#memViewNextPage");
    await expect(page.locator("#memViewStartAddress")).toHaveValue("0x00000300");
    await page.click("#memViewPrevPage");
    await expect(page.locator("#memViewStartAddress")).toHaveValue("0x00000100");
    await page.click("#memViewPrevPage");
    await expect(page.locator("#memViewStartAddress")).toHaveValue("0x00000000");
    await expect(page.locator("#memViewGrid span[data-address]").first()).toHaveAttribute("data-address", "0");
    await page.fill("#memViewStartAddress", "zz");
    await page.click("#memViewGo");
    await expect(page.locator("#errorToast")).toHaveText("Invalid address");
    expect(errors).toEqual([]);
  });

  test("xrefs list callers and global uses, call lines navigate with a back stack", async () => {
    const { page, target, errors } = await open("Patch");
    const code = page.locator("#codeDisassembly"), title = page.locator("#functionTitle"), back = page.locator("#codeBack");
    const rows = page.locator("#xrefResults tr[data-func][data-offset]");
    expect(await target.evaluate(() => [game.raw.exports.magicTail(), game.magic()])).toEqual([-16, -16]);
    await expect(page.locator("#xrefsButton")).toBeDisabled();
    await page.fill("#functionFilter", "magic");
    await page.click('#functionList tr[data-index="8"]');
    await expect(title).toContainText("Function 8: magic");
    await page.click("#xrefsButton");
    await expect(page.locator("#xrefResultsTitle")).toHaveText("Callers of function 8: magic () -> (i32): 3 references");
    await expect(rows).toHaveCount(2);
    await expect(page.locator("#xrefResults tbody tr").nth(2)).toContainText("elem 0 table 0 slot 0");
    await expect(rows.nth(0)).toContainText("call 8");
    await rows.nth(1).click();
    await expect(title).toContainText("Function 16: magicTail");
    await expect(code).toHaveAttribute("data-line", "3");
    expect((await code.inputValue()).split("\n")[2]).toBe("return_call 8");
    await expect(back).toBeEnabled();
    await back.click();
    await expect(title).toContainText("Function 8: magic");
    await expect(back).toBeDisabled();
    await page.click('#functionList tr[data-index="16"]');
    await expect(code).toHaveValue("call 8\ndrop\nreturn_call 8\nend");
    await code.scrollIntoViewIfNeeded();
    const box = await code.boundingBox();
    await page.mouse.dblclick(box.x + box.width / 2, box.y + 12);
    await expect(title).toContainText("Function 8: magic");
    await expect(back).toBeEnabled();
    await code.dblclick();
    await expect(title).toContainText("Function 8: magic");
    await back.click();
    await expect(title).toContainText("Function 16: magicTail");
    await expect(code).toHaveAttribute("data-line", "1");
    await expect(back).toBeDisabled();
    await code.evaluate(ta => ta.setSelectionRange(9, 9));
    await code.dispatchEvent("dblclick");
    await expect(back).toBeDisabled();
    await page.click("#tabGlobalsButton");
    await page.click('#globals tr[data-name="lives"] .global-xrefs');
    await expect(page.locator("#tabPatch")).toBeVisible();
    await expect(page.locator("#xrefResultsTitle")).toHaveText("Global lives: 1 reference");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("getLives");
    await expect(rows.first()).toContainText("global.get 0");
    await rows.first().click();
    await expect(title).toContainText("Function 7: getLives");
    await expect(code).toHaveAttribute("data-line", "1");
    await page.click("#tabGlobalsButton");
    await page.click('#globals tr[data-name="level"] .global-xrefs');
    await expect(page.locator("#xrefResultsTitle")).toHaveText("Global level: 2 references");
    await expect(rows).toHaveText([/bumpLevel.*global\.get 1/, /bumpLevel.*global\.set 1/]);
    await page.click("#tabGlobalsButton");
    await page.click('#globals tr[data-name="ratio"] .global-xrefs');
    await expect(page.locator("#xrefResultsTitle")).toHaveText("Global ratio: 0 references");
    await expect(page.locator("#xrefResults tr")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("globals list and edit", async () => {
    const { page, target, errors } = await open("Globals");
    await expect(page.locator('#globals tr[data-name="level"] .global-value')).toHaveValue("3");
    const lives = page.locator('#globals tr[data-name="lives"] .global-value');
    await expect(lives).toHaveValue("3");
    await lives.fill("9");
    await lives.press("Enter");
    await expect.poll(() => target.evaluate(() => game.getLives())).toBe(9);
    expect(errors).toEqual([]);
  });

  test("globals show declared types, instrumented and not", async () => {
    const sw = await x.worker(), key = `${new URL(server.url).host}/`, row = (p, n) => p.locator(`#globals tr[data-name="${n}"]`);
    const types = { lives: "i32", level: "i32", ratio: "f32", vec: "v128", global4: "funcref const", gravity: "f64 const" };
    for (const bad of [false, true]) {
      if (bad) await sw.evaluate(p => chrome.storage.local.set({ savedPatches: [p] }), { name: "bad", url: key, enabled: true, version: 2, functionPatches: [{ index: 8, bytes: [0x6a, 0x0b] }] });
      const { page, target, errors } = await open("Globals");
      await expect.poll(() => page.evaluate(() => ui.state.instances[0].instrumented)).toBe(!bad);
      for (const [n, t] of Object.entries(types)) await expect(row(page, n).locator(".global-type")).toHaveText(t);
      await expect(row(page, "ratio").locator(".global-value")).toHaveValue("100");
      await expect(row(page, "gravity").locator(".global-value")).toHaveValue("9.5");
      await expect(row(page, "gravity").locator(".global-value")).toBeDisabled();
      await expect(row(page, "vec").locator(".global-value")).toHaveValue(bad ? "?" : "01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F 10");
      await expect(row(page, "vec").locator(".global-freeze")).toBeDisabled();
      await expect(row(page, "global4").locator(".global-value")).toHaveValue(bad ? "?" : "func secretBonus");
      await expect(row(page, "lives").locator(".global-value")).toHaveValue(bad ? "?" : "3");
      await row(page, "ratio").locator(".global-value").fill("2.5");
      await row(page, "ratio").locator(".global-value").press("Enter");
      await expect.poll(() => target.evaluate(() => game.ratio())).toBe(2.5);
      if (!bad) {
        await row(page, "vec").locator(".global-value").fill("aa 00 00 00 00 00 00 00 00 00 00 00 00 00 00 bb");
        await row(page, "vec").locator(".global-value").press("Enter");
        await expect(row(page, "vec").locator(".global-value")).toHaveValue("AA 00 00 00 00 00 00 00 00 00 00 00 00 00 00 BB");
      }
      expect(errors).toEqual([]);
      await target.close();
    }
    await sw.evaluate(() => chrome.storage.local.remove("savedPatches"));
  });

  test("global freeze holds while the game changes it", async () => {
    const { page, target, errors } = await open("Globals");
    const row = page.locator('#globals tr[data-name="level"]');
    await row.locator(".global-value").fill("7");
    await row.locator(".global-value").press("Enter");
    await expect.poll(() => target.evaluate(() => game.level())).toBe(7);
    await row.locator(".global-freeze").check();
    await expect(row.locator(".global-freeze")).toBeChecked();
    const bump = () => target.evaluate(() => new Promise(r => { let k = 0; const t = () => { game.raw.exports.level.value += 5; ++k > 3 ? requestAnimationFrame(() => r(game.level())) : requestAnimationFrame(t); }; requestAnimationFrame(t); }));
    expect(await bump()).toBe(7);
    await row.locator(".global-freeze").uncheck();
    await expect.poll(() => target.evaluate(() => cetusLib.handle("state", {}).then(s => s.freezes.length))).toBe(0);
    await target.evaluate(() => { game.raw.exports.level.value = 30; });
    expect(await bump()).toBe(50);
    expect(errors).toEqual([]);
  });

  test("speedhack scales time and restores state", async () => {
    const { page, target, tabId, errors } = await open("SpeedHack");
    const elapsed = () => target.evaluate(() => game.elapsed());
    await page.fill("#shRange", "4");
    await expect(page.locator("#shValue")).toHaveText("4x");
    await page.click("#toggleSpeedhack");
    await expect(page.locator("#toggleSpeedhack")).toHaveText("Disable");
    const [lo, hi] = await rate(page, elapsed, 4, 4000);
    expect(lo).toBeLessThan(4.7);
    expect(hi).toBeGreaterThan(3.3);
    const before = await elapsed();
    await page.click("#toggleSpeedhack");
    await expect(page.locator("#toggleSpeedhack")).toHaveText("Enable");
    await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.speed))).toBe(1);
    const seen = await frames(target, "elapsed");
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen[0]).toBeGreaterThanOrEqual(before);
    await page.click("#toggleSpeedhack");
    await expect(page.locator("#toggleSpeedhack")).toHaveText("Disable");
    const u = await x.ui(tabId);
    await u.page.click("#tabSpeedHackButton");
    await expect(u.page.locator("#toggleSpeedhack")).toHaveText("Disable");
    await expect(u.page.locator("#shValue")).toHaveText("4x");
    expect([...errors, ...u.errors]).toEqual([]);
  });
});

test.describe("instrument", () => {
  let x;
  test.beforeAll(async () => { x = await launch(); });
  test.afterAll(() => x.close());
  test.afterEach(async () => { for (const p of x.ctx.pages()) await p.close(); });

  const open = async (path, tab) => {
    await (await x.worker()).evaluate(() => chrome.storage.local.clear());
    const g = await x.game(`${server.url}${path}`), u = await x.ui(g.tabId), p = u.page;
    await expect(p.locator("#lockOverlay")).toBeHidden();
    if (tab) await p.click(`#tab${tab}Button`);
    const reload = async () => {
      await g.page.reload();
      await g.page.waitForFunction(() => window.game?.readHealth);
      await expect(p.locator("#lockOverlay")).toBeHidden();
    };
    const add = async (address, type) => {
      await p.click("#tabTableButton");
      await p.fill("#tableAddAddress", address);
      await p.selectOption("#tableAddType", type);
      await p.click("#tableAddButton");
      return p.locator(`#table tr[data-address="${Number(address)}"]`);
    };
    const synced = () => expect.poll(() => p.evaluate(() => ui.request("state").then(s => s.instances.every(i => !i.worker || i.synced)))).toBe(true);
    const strike = () => g.target.evaluate(() => {
      game.worker.postMessage(2);
      const t = performance.now();
      while (game.readHealth() === 100 && performance.now() - t < 5000);
      return game.readHealth();
    });
    return { ...g, ...u, reload, add, synced, strike, hit: p.locator("#hits tr[data-func][data-offset]") };
  };

  test("instance selector switches the active instance", async () => {
    const { page, errors } = await open("/?second=1");
    await expect(page.locator("#instanceSelect option")).toHaveCount(2);
    const second = await page.locator("#instanceSelect option").nth(1).getAttribute("value");
    await page.selectOption("#instanceSelect", second);
    await expect.poll(() => page.evaluate(() => ui.state.active)).toBe(+second);
    await page.click("#tabMemViewButton");
    await page.fill("#memViewStartAddress", "0x100");
    await page.click("#memViewGo");
    await expect(page.locator('#memViewGrid span[data-address="256"]')).toHaveText("2A");
    expect(errors).toEqual([]);
  });

  test("memory selector switches the hex view, scans and new entries to memory 1, whose freeze holds", async () => {
    const { page, target, add, reload, errors } = await open("/?multimem=1");
    const hex = async v => {
      await page.click("#tabMemViewButton");
      await page.fill("#memViewStartAddress", "0x100");
      await page.click("#memViewGo");
      await expect(page.locator('#memViewGrid span[data-address="256"]')).toHaveText(v);
    };
    const held = () => target.evaluate(() => new Promise(r => { game.poke2(99); requestAnimationFrame(() => r(game.peek2())); }));
    await expect(page.locator("#memorySelect option")).toHaveCount(2);
    await expect(page.locator("#memorySelect")).toBeVisible();
    await hex("64");
    await page.selectOption("#memorySelect", "1");
    await expect.poll(() => page.evaluate(() => ui.mem())).toBe(1);
    await hex("2A");
    await page.click("#tabSearchButton");
    await page.selectOption("#searchType", "u8");
    await page.fill("#searchParam", "42");
    await page.click("#searchButton");
    await expect(page.locator("#resultsTitle")).toHaveText("Found 1");
    await expect(page.locator('#results tr[data-address="256"]')).toHaveCount(1);
    const row = await add("0x100", "i32");
    await expect(row).toHaveAttribute("data-memory", "1");
    await expect(row.locator(".entry-memory")).toHaveText("memory 1");
    await expect(row.locator(".entry-watch-write")).toBeDisabled();
    await expect(page.locator("#hotkeyEntry option")).toHaveAttribute("value", "256:i32:1");
    await row.locator(".entry-value").fill("7");
    await row.locator(".entry-value").press("Enter");
    await expect.poll(() => target.evaluate(() => game.peek2())).toBe(7);
    expect(await target.evaluate(() => game.readHealth())).toBe(100);
    await row.locator(".entry-freeze").check();
    await expect.poll(() => page.evaluate(() => ui.state.freezes)).toEqual([{ address: 256, type: "i32", value: 7, memory: 1 }]);
    expect(await held()).toBe(7);
    await page.selectOption("#memorySelect", "0");
    await hex("64");
    await expect(row.locator(".entry-value")).toHaveValue("7");
    expect(await held()).toBe(7);
    expect(await target.evaluate(() => game.readHealth())).toBe(100);
    await reload();
    await expect.poll(() => page.evaluate(() => ui.state.freezes)).toEqual([{ address: 256, type: "i32", value: 7, memory: 1 }]);
    expect(await held()).toBe(7);
    await expect(page.locator("#memorySelect")).toHaveValue("0");
    expect(errors).toEqual([]);
  });

  test("a WasmGC module with a tag, try_table and a rec group is instrumented, hit and patched", async () => {
    const { page, target, add, reload, hit, errors } = await open("/?gc=1"), code = page.locator("#codeDisassembly");
    const state = () => page.evaluate(async () => (await ui.request("state")).instances
      .map(i => [i.instrumented, i.error]));
    const sw = await x.worker(), stored = () => sw.evaluate(() => chrome.storage.local.get("savedPatches"));
    const saved = async () => (await stored()).savedPatches?.[0]?.functionPatches.map(f => [f.index, f.space, f.bytes]);
    await expect.poll(state).toEqual([[true, null]]);
    const row = await add("0x100", "i32");
    await row.locator(".entry-watch-write").check();
    await expect.poll(() => page.evaluate(() => ui.state.watches.length)).toBe(1);
    expect(await target.evaluate(() => (game.gcHeal(42), game.readHealth()))).toBe(42);
    await expect(hit).toHaveAttribute("data-func", "18");
    await expect(hit.locator(".hit-count")).toHaveText("1");
    await page.click("#tabPatchButton");
    await page.fill("#functionInput", "18");
    await page.click("#functionSearchButton");
    await expect(page.locator("#functionTitle")).toContainText("gcHeal");
    await expect(code).toHaveValue(/try_table catch 0 0\n\s*local\.get 0\n\s*struct\.new 7\n/);
    await expect(code).toHaveValue(/struct\.get 7 0\n\s*throw 0\n[^]*i32\.store align=2 offset=256/);
    await page.fill("#codeDisassembly", (await code.inputValue()).replace("local.get 0", "i32.const 777"));
    await page.click("#openSavePatchModalButton");
    await page.fill("#patchName", "gc");
    await page.click("#savePatchButton");
    await expect(page.locator("#savePatchModal")).toHaveClass(/modal-hidden/);
    const body = [0x41, 0, 0x02, 0x7f, 0x1f, 0x40, 1, 0, 0, 0, 0x41, 0x89, 0x06, 0xfb, 0, 7, 0xfb, 2, 7, 0, 0x08, 0];
    await expect.poll(saved).toEqual([[16, "original", [...body, 0x0b, 0x00, 0x0b, 0x36, 2, 0x80, 2, 0x0b]]]);
    await reload();
    await expect.poll(state).toEqual([[true, null]]);
    expect(await target.evaluate(() => (game.gcHeal(1), game.readHealth()))).toBe(777);
    expect(errors).toEqual([]);
  });

  test("memory.fill and atomic store hits name and highlight the bulk or atomic instruction, precise same-value fills included", async () => {
    const { page, target, add, reload, hit, errors } = await open("/?bulk=1"), code = page.locator("#codeDisassembly");
    const at = async (func, op) => {
      await page.click("#tabTableButton");
      await hit.and(page.locator(`[data-func="${func}"]`)).click();
      await expect(page.locator("#functionTitle")).toContainText(`Function ${func}`);
      await expect(code).toHaveAttribute("data-line", /^\d+$/);
      const lines = (await code.inputValue()).split("\n");
      expect(lines[+(await code.getAttribute("data-line")) - 1]).toContain(op);
    };
    const watch = async () => {
      await (await add("0x100", "i32")).locator(".entry-watch-write").check();
      await expect.poll(() => page.evaluate(() => ui.state.watches.length)).toBe(1);
    };
    await watch();
    expect(await target.evaluate(() => (game.bulkFill(7), game.setHealth(5), game.readHealth()))).toBe(5);
    await expect(hit).toHaveCount(2);
    await expect(hit.and(page.locator('[data-func="18"]')).locator(".hit-name")).toHaveText("bulkFill");
    await at(18, "memory.fill 0");
    expect(await target.evaluate(() => (game.atomicSet(9), game.readHealth()))).toBe(9);
    await expect(hit.and(page.locator('[data-func="19"]')).locator(".hit-name")).toHaveText("atomicSet");
    await at(19, "i32.atomic.store");
    await page.click("#tabTableButton");
    await page.check("#watchPrecise");
    await reload();
    await expect.poll(() => page.evaluate(() => ui.state.options?.precise)).toBe(true);
    await expect.poll(() => page.evaluate(() => ui.state.watches.length)).toBe(1);
    await target.evaluate(() => (game.bulkFill(3), game.bulkFill(3), game.atomicSet(4)));
    await expect(hit.and(page.locator('[data-func="18"]')).locator(".hit-count")).toHaveText("2");
    await at(18, "memory.fill 0");
    await at(19, "i32.atomic.store");
    expect(errors).toEqual([]);
  });

  test("string and pointer results keep the memory they came from across a memory switch and a reload", async () => {
    const { page, target, reload, errors } = await open("/?multimem=1");
    await target.evaluate(() => (game.setHealth(0x6f746563), game.poke2(0x6f6f6f63)));
    await page.click("#tabStringsButton");
    await page.selectOption("#strEncoding", "ascii");
    await page.fill("#strMinLength", "4");
    await page.click("#strSearchButton");
    const zero = page.locator('#stringResults tr[data-address="256"]');
    await expect(zero).toHaveAttribute("data-memory", "0");
    await page.selectOption("#memorySelect", "1");
    await expect.poll(() => page.evaluate(() => ui.mem())).toBe(1);
    await target.evaluate(() => game.setHealth(0x61746563));
    await page.click("#tabStringsButton");
    await expect(zero.locator(".live")).toHaveText("ceta");
    await target.evaluate(() => (game.setHealth(100), game.poke2(0x6f746563)));
    await page.click("#tabStringsButton");
    await page.selectOption("#strEncoding", "ascii");
    await page.fill("#strMinLength", "4");
    await page.click("#strSearchButton");
    await expect(page.locator("#strResultsTitle")).toHaveText("Found 1 in memory 1");
    const str = page.locator('#stringResults tr[data-address="256"]');
    await expect(str).toHaveAttribute("data-memory", "1");
    await page.selectOption("#memorySelect", "0");
    await expect.poll(() => page.evaluate(() => ui.mem())).toBe(0);
    await target.evaluate(() => game.poke2(0x6f6f6f63));
    await page.click("#tabStringsButton");
    await expect(str.locator(".live")).toHaveText("cooo");
    await str.locator(".add-entry").click();
    await expect(page.locator('#table tr[data-address="256"]')).toHaveAttribute("data-memory", "1");
    await target.evaluate(() => game.poke2(42));
    await page.selectOption("#memorySelect", "1");
    await page.click("#tabPointerButton");
    await page.fill("#ptrAddress", "0x100");
    await page.fill("#ptrDepth", "1");
    await page.click("#ptrScan");
    await expect(page.locator("#ptrCount")).toHaveText(/^Found [1-9]\d* in memory 1$/);
    const n = await page.evaluate(() => view.ptrAll.length);
    await page.selectOption("#memorySelect", "0");
    await reload();
    await page.evaluate(() => (Object.assign(view, { ptrSite: null, ptrAll: [], ptrMem: 0 }), view.ptrRestore()));
    await expect.poll(() => page.evaluate(() => [ui.mem(), view.ptrMem, view.ptrAll.length])).toEqual([0, 1, n]);
    await page.selectOption("#ptrType", "i32");
    await page.fill("#ptrRescanValue", "42");
    await page.click("#ptrRescan");
    await expect(page.locator("#ptrCount")).toHaveText(`Found ${n} in memory 1`);
    await page.locator("#ptrResults .add-entry").first().click();
    await expect(page.locator("#table tr[data-memory='1']")).toHaveCount(2);
    expect(errors).toEqual([]);
  });

  test("precise write watch reports same-value stores after a reload", async () => {
    const { page, target, reload, add, hit, errors } = await open("/", "Table");
    await page.check("#watchPrecise");
    await expect(page.locator("#watchPreciseNote")).toBeVisible();
    await reload();
    await expect.poll(() => page.evaluate(() => ui.state.options?.precise)).toBe(true);
    await expect(page.locator("#watchPrecise")).toBeChecked();
    await (await add("0x100", "i32")).locator(".entry-watch-write").check();
    await expect.poll(() => page.evaluate(() => ui.state.watches.length)).toBe(1);
    for (let i = 0; i < 2; i++) await target.evaluate(() => game.sameStore());
    await expect(hit.locator(".hit-count")).toHaveText("2");
    await expect(hit.locator(".hit-name")).toHaveText("sameStore");
    expect(await target.evaluate(() => game.readHealth())).toBe(100);
    expect(errors).toEqual([]);
  });

  test("hit accesses list the addresses an instruction touches", async () => {
    const { page, target, add, hit, errors } = await open("/", "Table");
    await (await add("0x104", "u32")).locator(".entry-watch-read").check();
    await target.evaluate(() => game.readGold());
    await expect(hit).toHaveCount(1);
    await expect(hit.locator(".hit-name")).toHaveText("readGold");
    await hit.locator(".hit-accesses").click();
    await expect(page.locator("#tabTable")).toBeVisible();
    await target.evaluate(() => game.readGold());
    await expect(page.locator('#accesses tr[data-address="260"] .access-count')).toHaveText("1");
    await page.locator('#accesses tr[data-address="260"] .add-entry').click();
    const types = () => page.locator('#table tr[data-address="260"] .entry-type')
      .evaluateAll(l => l.map(e => e.value).sort());
    await expect.poll(types).toEqual(["i32", "u32"]);
    await hit.locator(".hit-accesses").click();
    await expect(page.locator("#accesses tr[data-address]")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("the Patch tab traces the addresses of the highlighted instruction", async () => {
    const { page, target, reload, errors } = await open("/", "Patch");
    const btn = page.locator("#codeAccesses"), rows = page.locator("#codeAccessResults tr[data-address]");
    const toast = page.locator("#errorToast");
    const armed = () => page.evaluate(() => ui.request("state").then(s => s.accesses.map(a => a.func)));
    const fn = async i => (await page.fill("#functionInput", String(i)), await page.click("#functionSearchButton"));
    const pick = (re, d = 0) => page.evaluate(([src, d]) => {
      const t = el("codeDisassembly");
      view.setCode(t.value, t.value.split("\n").findIndex(l => new RegExp(src).test(l)) + d);
      view.codeAccesses();
    }, [re, d]);
    const hide = () => page.evaluate(() => {
      view.toastTimer = clearTimeout(view.toastTimer);
      el("errorToast").hidden = true;
    });
    await fn(6);
    await expect(page.locator("#functionTitle")).toContainText("readGold");
    await pick("^\\s*i32\\.const", 0);
    await btn.click();
    await expect(toast).toHaveText("Instruction is not traceable");
    await hide();
    await pick("^\\s*i32\\.load");
    await btn.click();
    await expect(btn).toHaveText("Stop");
    await expect.poll(armed).toEqual([6]);
    await target.evaluate(() => game.readGold());
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveAttribute("data-address", "260");
    await expect(rows.locator(".access-count")).toHaveText(/^[1-9]\d*$/);
    await rows.locator(".add-entry").click();
    await page.click("#tabTableButton");
    await expect(page.locator('#table tr[data-address="260"] .entry-type')).toHaveValue("i32");
    await page.click("#tabPatchButton");
    await btn.click();
    await expect.poll(armed).toEqual([]);
    await expect(btn).toHaveText("Accesses");
    await expect(rows).toHaveCount(0);
    await page.click("#tabTableButton");
    await page.check("#watchPrecise");
    await reload();
    await expect.poll(() => page.evaluate(() => ui.state.options?.precise)).toBe(true);
    await page.click("#tabPatchButton");
    await fn(4);
    await expect(page.locator("#functionTitle")).toContainText("damage");
    await pick("^\\s*global\\.get", -1);
    await btn.click();
    await expect(btn).toHaveText("Stop");
    await target.evaluate(() => game.damage(1));
    await expect(rows).toHaveAttribute("data-address", "256");
    await rows.locator(".add-entry").click();
    await page.click("#tabTableButton");
    await expect(page.locator('#table tr[data-address="256"] .entry-type')).toHaveValue("i32");
    await page.click("#tabPatchButton");
    const sites = () => page.evaluate(() => ui.request("state").then(s => s.accesses.map(a => a.offset)));
    const before = await sites();
    await pick("^\\s*i32\\.load");
    await page.click("#codeNop");
    await expect(toast).toHaveText("Reload the game to apply");
    await expect(page.locator("#codeDisassembly")).toHaveValue(/drop\n\s*i32\.const 0\n/);
    await pick("^\\s*global\\.get", -1);
    await expect(btn).toHaveText("Stop");
    await btn.click();
    await expect(btn).toHaveText("Accesses");
    await expect.poll(sites).toEqual([]);
    await btn.click();
    await expect.poll(sites).toEqual(before);
    const more = [[4, "damage", "i32\\.load", 0], [2, "getHealth", "i32\\.load", 0],
      [3, "setHealth", "global\\.get", -1]];
    for (const [i, name, re, d] of more) {
      await fn(i);
      await expect(page.locator("#functionTitle")).toContainText(name);
      await pick(`^\\s*${re}`, d);
      await btn.click();
      await expect(btn).toHaveText("Stop");
    }
    await expect.poll(armed).toHaveLength(4);
    await fn(6);
    await expect(page.locator("#functionTitle")).toContainText("readGold");
    await pick("^\\s*i32\\.load");
    await btn.click();
    await expect(toast).toHaveText("All 4 access slots are in use");
    expect(errors).toEqual([]);
  });

  test("function trace logs calls and arguments after a reload", async () => {
    const { page, target, reload, errors } = await open("/", "Patch");
    await page.fill("#functionInput", "4");
    await page.click("#functionSearchButton");
    await expect(page.locator(".fn-trace")).toBeEnabled();
    await page.check(".fn-trace");
    await expect.poll(() => page.evaluate(() => ui.options().then(o => o.trace))).toEqual([4]);
    await reload();
    await target.evaluate(() => game.damage(4));
    const row = page.locator('#traceLog tr[data-func="4"]');
    await expect(row.locator(".trace-count")).toHaveText("1");
    await expect(row.locator(".trace-args")).toHaveText("4");
    expect(errors).toEqual([]);
  });

  test("code filter narrows to the function a game action ran after a reload", async () => {
    const { page, target, reload, errors } = await open("/", "Patch");
    const rows = page.locator("#codeFilterResults tr[data-func]"), count = page.locator("#codeFilterCount");
    await page.click("#codeFilterStart");
    await expect(page.locator("#errorToast")).toHaveText("Coverage is off: enable it and reload the game");
    await page.check("#coverageOn");
    await expect(page.locator("#coverageNote")).toBeVisible();
    await expect.poll(() => page.evaluate(() => ui.options().then(o => o.coverage))).toBe(true);
    await reload();
    await expect.poll(() => page.evaluate(() => ui.state.options?.coverage)).toBe(true);
    await expect(page.locator("#coverageOn")).toBeChecked();
    await page.click("#codeFilterStart");
    await expect(count).toHaveText("17 functions");
    await expect(rows).toHaveCount(17);
    await target.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.click("#codeFilterNotExecuted");
    await expect(rows.filter({ hasText: "getHealth" })).toHaveCount(0);
    await target.evaluate(() => game.addGold(1));
    await page.click("#codeFilterExecuted");
    await expect(count).toHaveText("1 function");
    await expect(rows).toHaveCount(1);
    await expect(rows.locator(".cf-name")).toHaveText("addGold");
    await expect(rows.locator(".cf-calls")).toHaveText("1");
    await rows.click();
    await expect(page.locator("#functionTitle")).toContainText("addGold");
    await page.click("#codeFilterReset");
    await expect(rows).toHaveCount(0);
    await expect(count).toHaveText("");

    await page.click("#tabTableButton");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#tableExport")]);
    expect(JSON.parse(readFileSync(await download.path(), "utf8")).instrumentOptions.coverage).toBe(true);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#tableExportUserscript")]);
    const text = readFileSync(await dl.path(), "utf8");
    await page.click("#tabPatchButton");
    await page.uncheck("#coverageOn");
    await expect.poll(() => page.evaluate(() => ui.options().then(o => o.coverage))).toBe(false);
    await page.setInputFiles("#tableImport", await download.path());
    await expect.poll(() => page.evaluate(() => ui.options().then(o => o.coverage))).toBe(true);
    expect(errors).toEqual([]);

    const browser = await chromium.launch({ channel: "chromium", headless: true });
    try {
      const gp = await (await browser.newContext()).newPage();
      await gp.addInitScript({ content: text });
      await gp.goto(`${server.url}/`);
      await gp.waitForFunction(() => window.game?.readHealth);
      expect(await gp.evaluate(async () => {
        const ask = (id, body) => new Promise(r => {
          const f = e => (m => m.id === id && (removeEventListener("cetusMsgIn", f), r(m.body)))(cetusLib.decode(e.detail));
          addEventListener("cetusMsgIn", f);
          dispatchEvent(new CustomEvent("cetusMsgOut", { detail: cetusLib.encode({ id, type: "codeFilter", body }) }));
        });
        await ask(1, { op: "start" });
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        await ask(3, { op: "notExecuted" });
        game.addGold(1);
        return ask(2, { op: "executed" }).then(r => r.rows.map(f => f.name));
      })).toEqual(["addGold"]);
    } finally { await browser.close(); }
  });

  test("global write watch lists the writers of a global after a reload", async () => {
    const { page, target, reload, errors } = await open("/", "Globals");
    const row = n => page.locator(`#globals tr[data-name="${n}"] .global-watch`);
    await expect(row("level")).toBeEnabled();
    for (const n of ["gravity", "vec", "global4"]) await expect(row(n)).toBeDisabled();
    await row("level").check();
    await expect(page.locator("#globalWatchNote")).toBeVisible();
    await expect.poll(() => page.evaluate(() => ui.options().then(o => o.globalWatch))).toEqual([1]);
    await reload();
    await expect.poll(() => page.evaluate(() => ui.state.options?.globalWatch)).toEqual([1]);
    await page.click("#tabGlobalsButton");
    await expect(row("level")).toBeChecked();
    await target.evaluate(() => game.bumpLevel());
    const hit = page.locator("#globalHits tr[data-func][data-offset]");
    await expect(hit.locator(".hit-count")).toHaveText("1");
    await expect(hit.locator(".hit-name")).toHaveText("bumpLevel");
    await expect(hit.locator(".hit-last")).toHaveText("4");
    expect(await target.evaluate(() => game.level())).toBe(4);
    await target.evaluate(() => (game.bumpLevel(), game.damage(1)));
    await expect(hit.locator(".hit-count")).toHaveText("2");
    await expect(hit.locator(".hit-last")).toHaveText("5");
    await hit.click();
    await expect(page.locator("#tabPatch")).toBeVisible();
    await expect(page.locator("#functionTitle")).toContainText("bumpLevel");
    const line = await page.locator("#codeDisassembly").getAttribute("data-line");
    expect((await page.locator("#codeDisassembly").inputValue()).split("\n")[line - 1].trim()).toBe("global.set 1");

    await page.click("#tabTableButton");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#tableExport")]);
    const file = JSON.parse(readFileSync(await download.path(), "utf8"));
    expect(file.instrumentOptions.globalWatch).toEqual([1]);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#tableExportUserscript")]);
    const text = readFileSync(await dl.path(), "utf8");
    await page.click("#tabGlobalsButton");
    await row("level").uncheck();
    await expect.poll(() => page.evaluate(() => ui.options().then(o => o.globalWatch))).toEqual([]);
    await page.setInputFiles("#tableImport", await download.path());
    await expect.poll(() => page.evaluate(() => ui.options().then(o => o.globalWatch))).toEqual([1]);
    expect(errors).toEqual([]);

    const browser = await chromium.launch({ channel: "chromium", headless: true });
    try {
      const gp = await (await browser.newContext()).newPage();
      await gp.addInitScript({ content: text });
      await gp.goto(`${server.url}/`);
      await gp.waitForFunction(() => window.game?.readHealth);
      await gp.evaluate(() => game.bumpLevel());
      expect(await gp.evaluate(() => new Promise(r => {
        const rows = m => m.id === 7 && r(m.body.globalHits.map(h => [h.name, h.count, h.last]));
        addEventListener("cetusMsgIn", e => rows(cetusLib.decode(e.detail)));
        dispatchEvent(new CustomEvent("cetusMsgOut", { detail: cetusLib.encode({ id: 7, type: "state", body: {} }) }));
      }))).toEqual([["bumpLevel", 1, 4]]);
    } finally { await browser.close(); }
  });

  test("an execute breakpoint counts damage calls after a reload and feeds script onHit", async () => {
    const { page, target, reload, errors } = await open("/", "Patch");
    const ta = page.locator("#codeDisassembly"), row = page.locator('#breakpoints tr[data-func="4"][data-offset]');
    const bps = () => page.evaluate(() => ui.options().then(o => o.breakpoints));
    const fn = async i => (await page.fill("#functionInput", String(i)), await page.click("#functionSearchButton"));
    const caret = (re, d = 0) => page.evaluate(([src, d]) => {
      const t = el("codeDisassembly"), ls = t.value.split("\n");
      const i = ls.findIndex(l => new RegExp(src).test(l)) + d, p = ls.slice(0, i).join("\n").length + 1;
      delete t.dataset.line;
      t.setSelectionRange(p, p);
    }, [re, d]);
    await fn(4);
    await expect(page.locator("#functionTitle")).toContainText("damage");
    await caret("^\\s*i32\\.store");
    await page.click("#codeBreakpoint");
    await expect(page.locator("#breakpointNote")).toBeVisible();
    await expect.poll(bps).toEqual([{ func: 4, offset: 11 }]);
    await expect(row).toHaveAttribute("data-offset", "11");
    await expect(row.locator(".bp-count")).toHaveText("0");
    await reload();
    await expect.poll(() => page.evaluate(() => ui.state.options?.breakpoints)).toEqual([{ func: 4, offset: 11 }]);
    for (let i = 0; i < 3; i++) await target.evaluate(() => game.damage(1));
    await expect(row.locator(".bp-count")).toHaveText("3");
    await fn(2);
    await expect(page.locator("#functionTitle")).toContainText("getHealth");
    await row.click();
    await expect(page.locator("#functionTitle")).toContainText("damage");
    const line = await ta.getAttribute("data-line");
    expect((await ta.inputValue()).split("\n")[line - 1].trim()).toMatch(/^i32\.store/);
    expect((await ta.inputValue()).split("\n")[line - 2].trim()).toMatch(/^call \d+$/);
    await caret("^\\s*i32\\.store", -1);
    await page.click("#codeBreakpoint");
    await expect.poll(bps).toEqual([]);
    await expect(row).toHaveCount(0);
    await page.click("#codeBreakpoint");
    await expect.poll(bps).toEqual([{ func: 4, offset: 11 }]);
    await row.locator(".bp-break").check();
    await expect.poll(bps).toEqual([{ func: 4, offset: 11, break: true }]);
    await row.locator(".bp-break").uncheck();
    await expect.poll(bps).toEqual([{ func: 4, offset: 11 }]);

    await page.click("#tabScriptsButton");
    await page.fill("#scriptName", "hits");
    await page.fill("#scriptCode", 'cetus.onHit(h => cetus.log(h.kind, h.name, h.bp.offset))');
    await page.click("#scriptSave");
    await page.locator('#scripts tr[data-name="hits"] .script-enable').check();
    await expect(page.locator('#scripts tr[data-name="hits"]')).toContainText("Running");
    for (let i = 0; i < 2; i++) await target.evaluate(() => game.damage(1));
    const logs = page.locator("#scriptLog div", { hasText: "hits: breakpoint damage 11" });
    await expect(logs).toHaveCount(2);
    await page.locator('#scripts tr[data-name="hits"] .script-enable').uncheck();
    await expect(page.locator('#scripts tr[data-name="hits"]')).not.toContainText("Running");
    await target.evaluate(() => game.damage(1));
    await page.click("#tabPatchButton");
    await expect(row.locator(".bp-count")).toHaveText("6");
    await expect(logs).toHaveCount(2);

    await page.click("#tabTableButton");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#tableExport")]);
    const exported = JSON.parse(readFileSync(await download.path(), "utf8"));
    expect(exported.instrumentOptions.breakpoints).toEqual([{ func: 4, offset: 11 }]);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#tableExportUserscript")]);
    const text = readFileSync(await dl.path(), "utf8");
    await page.click("#tabPatchButton");
    await row.locator(".bp-remove").click();
    await expect.poll(bps).toEqual([]);
    page.once("dialog", d => d.accept());
    await page.setInputFiles("#tableImport", await download.path());
    await expect.poll(bps).toEqual([{ func: 4, offset: 11 }]);
    expect(errors).toEqual([]);

    const browser = await chromium.launch({ channel: "chromium", headless: true });
    try {
      const gp = await (await browser.newContext()).newPage();
      await gp.addInitScript({ content: text });
      await gp.goto(`${server.url}/`);
      await gp.waitForFunction(() => window.game?.readHealth);
      await gp.evaluate(() => (game.damage(1), game.damage(1)));
      const got = await gp.evaluate(() => cetusLib.handle("state", {})
        .then(s => s.bpHits.map(h => [h.name, h.offset, h.count])));
      expect(got).toEqual([["damage", 11, 2]]);
    } finally { await browser.close(); }
  });

  test("breakpoint locals and a condition decide when a hit pauses", async () => {
    const { page, target, reload, errors } = await open("/", "Patch");
    const row = page.locator('#breakpoints tr[data-func="4"][data-offset="11"]');
    const bps = () => page.evaluate(() => ui.options().then(o => o.breakpoints));
    const cond = "hit.locals[0] === 5 && (globalThis.stopped = (globalThis.stopped ?? 0) + 1, true)";
    await page.fill("#functionInput", "4");
    await page.click("#functionSearchButton");
    await expect(page.locator("#functionTitle")).toContainText("damage");
    await page.evaluate(() => {
      const t = el("codeDisassembly"), ls = t.value.split("\n");
      const i = ls.findIndex(l => /^\s*i32\.store/.test(l)), p = ls.slice(0, i).join("\n").length + 1;
      delete t.dataset.line;
      t.setSelectionRange(p, p);
    });
    await page.click("#codeBreakpoint");
    await expect.poll(bps).toEqual([{ func: 4, offset: 11 }]);
    await row.locator(".bp-locals").check();
    await row.locator(".bp-condition").fill(cond);
    await row.locator(".bp-condition").press("Enter");
    await row.locator(".bp-break").check();
    await expect.poll(bps).toEqual([{ func: 4, offset: 11, locals: true, condition: cond, break: true }]);
    await reload();
    await expect.poll(() => page.evaluate(() => ui.state.options?.breakpoints)).toEqual([{ func: 4, offset: 11, locals: true, condition: cond, break: true }]);
    await target.evaluate(() => game.damage(7));
    await expect(row.locator(".bp-locals-value")).toHaveText("local0=7");
    expect(await target.evaluate(() => window.stopped)).toBe(undefined);
    await target.evaluate(() => game.damage(5));
    await expect(row.locator(".bp-count")).toHaveText("2");
    await expect(row.locator(".bp-locals-value")).toHaveText("local0=5");
    expect(await target.evaluate(() => window.stopped)).toBe(1);
    await row.locator(".bp-condition").fill("nope(");
    await row.locator(".bp-condition").press("Enter");
    await target.evaluate(() => game.damage(5));
    await expect(page.locator("#scriptLog div", { hasText: "Condition 4:11" })).toHaveCount(1);
    expect(await target.evaluate(() => window.stopped)).toBe(1);
    expect(errors).toEqual([]);
  });

  test("a watch condition decides when a write pauses", async () => {
    const { page, target, add, hit, errors } = await open("/", "Table");
    const cond = "hit.new < 90 && (globalThis.broke = (globalThis.broke ?? 0) + 1, true)";
    const row = await add("0x100", "i32");
    await page.check("#watchBreak");
    await row.locator(".entry-watch-write").check();
    await row.locator(".entry-watch-condition").fill(cond);
    await row.locator(".entry-watch-condition").press("Enter");
    await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.watches.map(w => w.condition)))).toEqual([cond]);
    await target.evaluate(() => game.damage(5));
    await expect(hit.locator(".hit-count")).toHaveText("1");
    expect(await target.evaluate(() => window.broke)).toBe(undefined);
    await target.evaluate(() => game.damage(8));
    await expect(hit.locator(".hit-count")).toHaveText("2");
    expect(await target.evaluate(() => window.broke)).toBe(1);
    await expect.poll(() => page.evaluate(() => ui.table().then(l => l[0].watchCondition))).toBe(cond);
    expect(errors).toEqual([]);
  });

  test("step trace lists the last run of a function and jumps to its instruction", async () => {
    const { page, target, reload, errors } = await open("/", "Patch");
    const fn = async i => (await page.fill("#functionInput", String(i)), await page.click("#functionSearchButton"));
    const rows = page.locator("#stepTrace tr[data-offset]"), ta = page.locator("#codeDisassembly");
    await fn(16);
    await expect(page.locator("#functionTitle")).toContainText("magicTail");
    await expect(page.locator(".fn-steptrace")).toBeEnabled();
    await page.check(".fn-steptrace");
    await expect.poll(() => page.evaluate(() => ui.options().then(o => o.stepTrace))).toEqual([{ func: 16, max: 1000 }]);
    await reload();
    await fn(16);
    await expect(page.locator(".fn-steptrace")).toBeChecked();
    await expect(rows).toHaveCount(0);
    await target.evaluate(() => game.raw.exports.magicTail());
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute("data-offset", "0");
    await expect(rows.nth(1)).toHaveAttribute("data-offset", "3");
    await expect(rows.nth(0).locator(".step-text")).toHaveText(/^call \d+$/);
    await expect(rows.nth(1).locator(".step-text")).toHaveText(/^return_call \d+$/);
    await rows.nth(1).click();
    const line = await ta.getAttribute("data-line");
    expect((await ta.inputValue()).split("\n")[line - 1].trim()).toMatch(/^return_call /);
    expect(errors).toEqual([]);
  });

  test("worker instances report hits and respect freezes on shared memory", async () => {
    const { page, target, add, hit, synced, strike, errors } = await open("/threads");
    await target.evaluate(() => game.startWorker());
    await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.instances.map(i => [i.worker, i.shared])))).toEqual([[false, true], [true, true]]);
    await expect(page.locator("#instanceSelect option:enabled")).toHaveText([/^Instance /, /^Worker \d+: /]);
    await expect(page.locator("#errorToast")).toBeHidden();
    const row = await add("0x100", "i32");
    await row.locator(".entry-watch-write").check();
    await expect.poll(() => page.evaluate(() => ui.state.watches.length)).toBe(1);
    await synced();
    for (let i = 0; i < 2; i++) await target.evaluate(() => game.workerDamage(2));
    await expect(hit.locator(".hit-count")).toHaveText("2");
    await expect(hit.locator(".hit-last")).toHaveText("98 -> 96");
    await target.evaluate(() => game.damage(5));
    await expect(hit.locator(".hit-last")).toHaveText("96 -> 91");
    await target.evaluate(() => game.workerDamage(2));
    await expect(hit.locator(".hit-last")).toHaveText("91 -> 89");
    for (const worker of [true, false]) {
      await row.locator(".entry-value").fill("100");
      await row.locator(".entry-value").press("Enter");
      await expect.poll(() => target.evaluate(() => game.readHealth())).toBe(100);
      if (worker) await target.evaluate(() => game.workerDamage(2));
      if (worker) await expect(hit.locator(".hit-last")).toHaveText("100 -> 98");
    }
    await row.locator(".entry-freeze").check();
    await expect.poll(() => page.evaluate(() => ui.state.freezes.length)).toBe(1);
    for (let i = 0; i < 3; i++) {
      await expect.poll(() => target.evaluate(() => game.readHealth())).toBe(100);
      expect(await strike()).toBe(98);
    }
    await expect.poll(() => target.evaluate(() => game.readHealth())).toBe(100);
    expect(errors).toEqual([]);
  });

  for (const [path, shared, tag] of [["/threads?early=1", true, "Worker"], ["/threads?early=1&worker=module", true, "Worker"], ["/threads?early=1&worker=nested", true, "Worker"],
    ["/threads?early=1&worker=worklet", true, "Promise"], ["/?early=1&own=1", false, "Worker"], ["/?early=1&own=1&worker=shared", false, "MessagePort"]]) {
    test(`worker created at page start is hooked: ${path}`, async () => {
      const { page, target, add, hit, synced, strike, errors } = await open(path);
      expect(await target.evaluate(async () => [Object.prototype.toString.call(game.early), await (game.pong ?? true)])).toEqual([`[object ${tag}]`, true]);
      await target.evaluate(() => game.startWorker());
      await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.instances.map(i => [i.worker, i.shared])))).toEqual([[false, shared], [true, shared]]);
      const row = await add("0x100", "i32");
      await row.locator(".entry-watch-write").check();
      await expect.poll(() => page.evaluate(() => ui.state.watches.length)).toBe(1);
      await synced();
      expect([await target.evaluate(() => game.workerDamage(2)), await target.evaluate(() => game.workerDamage(2))]).toEqual([98, 96]);
      await expect(hit.locator(".hit-count")).toHaveText("2");
      await expect(hit.locator(".hit-last")).toHaveText("98 -> 96");
      if (shared) {
        await row.locator(".entry-value").fill("100");
        await row.locator(".entry-value").press("Enter");
        await expect.poll(() => target.evaluate(() => game.readHealth())).toBe(100);
        await row.locator(".entry-freeze").check();
        await expect.poll(() => page.evaluate(() => ui.state.freezes.length)).toBe(1);
        for (let i = 0; i < 3; i++) {
          await expect.poll(() => target.evaluate(() => game.readHealth())).toBe(100);
          expect(await strike()).toBe(98);
        }
      }
      const id = await page.evaluate(() => ui.request("state").then(s => s.instances.find(i => i.worker).id));
      const read = () => page.evaluate(async id => {
        await ui.request("select", { id });
        return (await ui.request("readValues", { items: [{ address: 256, type: "i32" }] })).values[0];
      }, id);
      await expect.poll(async () => await read() === await target.evaluate(() => game.workerDamage(0))).toBe(true);
      if (tag === "Promise") {
        await target.evaluate(() => game.audio.close());
        await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.instances.map(i => i.worker)))).toEqual([false]);
      }
      expect(errors).toEqual([]);
    });
  }

  test("a bare worker instance is selected and scanned, written, frozen, hex viewed, listed and disassembled", async () => {
    const { page, target, add, errors } = await open("/threads?bare=1&worker=classic");
    const opt = page.locator("#instanceSelect option");
    await expect(opt).toHaveCount(1);
    await expect(opt).toHaveText(/^Worker \d+: .* \(64 KiB\)$/);
    await expect(opt).toBeEnabled();
    await page.locator("#instanceSelect").evaluate(s => s.dispatchEvent(new Event("change")));
    await expect(page.locator("#instanceHeader")).toHaveText(/^Worker instance \d+ of 1, 64 KiB memory, instrumented$/);
    expect(await page.evaluate(() => ui.state.active)).toBe(+await opt.getAttribute("value"));
    await page.selectOption("#searchType", "i32");
    await page.selectOption("#searchCompare", "eq");
    await page.fill("#searchParam", "100");
    await page.click("#searchButton");
    await expect(page.locator('#results tr[data-address="256"]')).toHaveCount(1);
    const row = await add("0x100", "i32");
    await row.locator(".entry-value").fill("999");
    await row.locator(".entry-value").press("Enter");
    await expect.poll(() => target.evaluate(() => game.readHealth())).toBe(999);
    await row.locator(".entry-freeze").check();
    await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.freezes.map(f => [f.address, f.value])))).toEqual([[256, 999]]);
    for (let i = 0; i < 3; i++) {
      await target.evaluate(() => game.workerDamage(7));
      await expect.poll(() => target.evaluate(() => game.readHealth())).toBe(999);
    }
    await page.click("#tabMemViewButton");
    await page.fill("#memViewStartAddress", "0x100");
    await page.click("#memViewGo");
    await expect(page.locator('#memViewGrid span[data-address="256"]')).toHaveText("E7");
    await expect(page.locator('#memViewGrid span[data-address="257"]')).toHaveText("03");
    await page.click("#tabGlobalsButton");
    await expect(page.locator('#globals tr[data-name="level"] .global-value')).toHaveValue("3");
    await expect(page.locator('#globals tr[data-name="lives"]')).toHaveCount(1);
    await page.click("#tabPatchButton");
    await page.fill("#functionInput", "4");
    await page.click("#functionSearchButton");
    await expect(page.locator("#codeDisassembly")).toHaveValue(/i32\.store/);
    await expect(page.locator("#functionTitle")).toContainText("damage");
    await page.click("#tabTableButton");
    await row.locator(".entry-freeze").uncheck();
    await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.freezes.length))).toBe(0);
    await row.locator(".entry-watch-write").check();
    await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.watches.length && s.instances[0].synced))).toBe(true);
    expect(await target.evaluate(() => game.workerDamage(9))).toBe(990);
    await expect(page.locator("#hits tr[data-func][data-offset] .hit-last")).toHaveText("999 -> 990");
    await expect(page.locator("#hits tr[data-func][data-offset] .hit-name")).toHaveText("damage");
    expect(errors).toEqual([]);
  });

  test("a bare worker that is terminated, respawned or closed is dropped and the newest one becomes active", async () => {
    const { page, target, errors } = await open("/threads?bare=1&worker=classic");
    const opt = page.locator("#instanceSelect option"), read = () => page.evaluate(() => ui.request("readValues", { items: [{ address: 256, type: "i32" }] }).then(r => r.values[0]));
    await expect(opt).toHaveCount(1);
    const first = +await opt.getAttribute("value");
    expect(await page.evaluate(id => ui.request("select", { id }).then(r => r.active), first)).toBe(first);
    await target.evaluate(() => game.workerDamage(10));
    await expect.poll(read).toBe(90);
    await target.evaluate(() => game.respawn());
    await expect.poll(() => page.evaluate(first => ui.request("state").then(s => s.instances.length === 1 && s.instances[0].id !== first && s.active === s.instances[0].id), first)).toBe(true);
    const next = await page.evaluate(() => ui.request("state").then(s => s.active));
    await expect.poll(read).toBe(100);
    await page.evaluate(() => ui.request("write", { address: 256, type: "i32", value: "999" }));
    expect(await target.evaluate(() => game.readHealth())).toBe(999);
    await expect(opt).toHaveCount(1);
    await expect(opt).toHaveAttribute("value", String(next));
    await target.evaluate(() => game.worker.postMessage("close"));
    await expect.poll(() => page.evaluate(() => ui.request("state").then(s => [s.instances.length, s.active]))).toEqual([0, null]);
    expect(errors).toEqual([]);
  });

  test("hotkeys added in the UI survive a respawned or late worker", async () => {
    for (const [path, again, count] of [["/threads?bare=1&worker=classic", () => game.respawn(), 1], ["/?early=1&own=1", () => game.startWorker(), 2]]) {
      const { page, target, add, errors } = await open(path);
      const ids = () => page.evaluate(() => ui.request("state").then(s => s.instances.map(i => i.id)));
      await expect.poll(() => ids().then(l => l.length)).toBe(1);
      const first = (await ids())[0];
      await add("0x100", "i32");
      await page.fill("#hotkeyCombo", "Alt+K");
      await page.selectOption("#hotkeyAction", "set");
      await page.selectOption("#hotkeyEntry", "256:i32");
      await page.fill("#hotkeyValue", "42");
      await page.click("#hotkeyAdd");
      await expect(page.locator('#hotkeys tr[data-combo="Alt+K"]')).toHaveCount(1);
      await target.evaluate(again);
      await expect.poll(() => ids().then(l => l.length === count && l.at(-1) !== first)).toBe(true);
      await target.bringToFront();
      await target.keyboard.press("Alt+K");
      await expect.poll(() => target.evaluate(() => game.readHealth())).toBe(42);
      expect(errors).toEqual([]);
      await page.close();
      await target.close();
    }
  });

  test("a freeze turned off after load stays off in a respawned worker", async () => {
    const { page, target, add, reload, errors } = await open("/threads?bare=1&worker=classic");
    const freezes = () => page.evaluate(() => ui.request("state").then(s => s.freezes.map(f => f.address)));
    const row = await add("0x100", "i32");
    await row.locator(".entry-freeze").check();
    await reload();
    await expect.poll(freezes).toEqual([256]);
    await page.click("#tabTableButton");
    await row.locator(".entry-freeze").uncheck();
    await expect.poll(freezes).toEqual([]);
    const ids = () => page.evaluate(() => ui.request("state").then(s => s.instances.map(i => i.id)));
    const [first] = await ids();
    await target.evaluate(() => game.respawn());
    await expect.poll(() => ids().then(l => l.length === 1 && l[0] !== first)).toBe(true);
    expect(await target.evaluate(() => game.workerDamage(10))).toBe(90);
    await page.waitForTimeout(200);
    expect(await freezes()).toEqual([]);
    expect(await target.evaluate(() => game.readHealth())).toBe(90);
    expect(errors).toEqual([]);
  });

  test("a bare worker keys storage by its page and refreshes the UI when it goes away", async () => {
    const { page, target, add, reload, errors } = await open("/threads?bare=1&worker=classic"), sw = await x.worker();
    const site = `${new URL(server.url).host}/threads`, get = k => sw.evaluate(k => chrome.storage.local.get(k).then(r => r[k]), k);
    const opt = page.locator("#instanceSelect option");
    await expect(opt).toHaveCount(1);
    await page.locator("#instanceSelect").evaluate(s => s.dispatchEvent(new Event("change")));
    const row = await add("0x100", "i32");
    await expect.poll(() => get("cheatTables").then(t => Object.keys(t ?? {}))).toEqual([site]);
    await page.click("#tabPatchButton");
    await page.fill("#functionInput", "4");
    await page.click("#functionSearchButton");
    await expect(page.locator("#functionTitle")).toContainText("damage");
    await page.evaluate(() => {
      const t = el("codeDisassembly");
      view.setCode(t.value, t.value.split("\n").findIndex(l => /^\s*i32\.store/.test(l)));
    });
    await page.click("#codeNop");
    await expect.poll(() => get("savedPatches").then(l => l?.map(p => p.url))).toEqual([site]);
    await reload();
    expect(await target.evaluate(() => game.workerDamage(5))).toBe(100);
    await page.click("#tabTableButton");
    await row.locator(".entry-freeze").check();
    await expect.poll(() => get("cheatTables").then(t => t[site][0].frozen)).toBe(true);
    await reload();
    await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.freezes.map(f => f.address)))).toEqual([256]);
    await target.evaluate(() => game.worker.postMessage("close"));
    await expect(page.locator("#lockOverlay")).toBeVisible();
    await target.evaluate(() => game.respawn());
    await expect(page.locator("#lockOverlay")).toBeHidden();
    const id = await page.evaluate(() => ui.request("state").then(s => s.instances[0].id));
    await expect(opt).toHaveCount(1);
    await expect(opt).toHaveAttribute("value", String(id));
    expect(errors).toEqual([]);
  });

  test("worker hits on own memory keep their own old values", async () => {
    const { page, target, add, hit, synced, errors } = await open("/?early=1&own=1");
    await target.evaluate(() => game.startWorker());
    await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.instances.length))).toBe(2);
    const row = await add("0x100", "i32");
    await row.locator(".entry-watch-write").check();
    await synced();
    await target.evaluate(() => game.damage(5));
    await expect(hit.locator(".hit-last")).toHaveText("100 -> 95");
    expect(await target.evaluate(() => game.workerDamage(2))).toBe(98);
    await expect(hit.locator(".hit-last")).toHaveText("100 -> 98");
    await target.evaluate(() => game.damage(5));
    await expect(hit.locator(".hit-last")).toHaveText("95 -> 90");
    expect(errors).toEqual([]);
  });

  test("early workers still run unhooked under a strict CSP", async () => {
    const { target, errors } = await open("/csp?early=1");
    expect(await target.evaluate(async () => [await game.pong, await game.startWorker() ?? 0, await game.workerDamage(1)])).toEqual([true, 0, 99]);
    expect(errors).toEqual([]);
  });

  test("strict CSP still unlocks and runs workers with the wrapper installed", async () => {
    const { page, target, errors } = await open("/csp");
    await expect(page.locator("#instanceHeader")).not.toContainText("not instrumented");
    expect(await target.evaluate(async () => { await game.startWorker(); return game.workerDamage(1); })).toBe(99);
    expect(errors).toEqual([]);
  });

  test("speed 0.5 halves game time", async () => {
    const { page, target, errors } = await open("/", "SpeedHack");
    const elapsed = () => target.evaluate(() => game.elapsed());
    await page.fill("#shRange", "0.5");
    await expect(page.locator("#shValue")).toHaveText("0.5x");
    await page.click("#toggleSpeedhack");
    await expect(page.locator("#toggleSpeedhack")).toHaveText("Disable");
    const [lo, hi] = await rate(page, elapsed, 0.5, 500);
    expect(lo).toBeLessThan(0.7);
    expect(hi).toBeGreaterThan(0.3);
    expect(errors).toEqual([]);
  });

  const still = async read => {
    const e0 = await read(), t0 = Date.now();
    await expect.poll(async () => (expect(await read()).toBe(e0), Date.now() - t0), { intervals: [50] }).toBeGreaterThanOrEqual(500);
    return e0;
  };

  test("speed scales event, animation and audio timelines and stops them while paused", async () => {
    const { page, target, errors } = await open("/", "SpeedHack");
    await target.click("body");
    await target.evaluate(async () => {
      window.ac = new AudioContext();
      await ac.resume();
      while (ac.state !== "running") await new Promise(r => setTimeout(r, 20));
    });
    const reads = [() => target.evaluate(() => document.timeline.currentTime), () => target.evaluate(() => new Event("x").timeStamp),
      () => target.evaluate(() => ac.currentTime * 1000)];
    await page.fill("#shRange", "4");
    await page.click("#toggleSpeedhack");
    for (const read of reads) {
      const [lo, hi] = await rate(page, read, 4, 4000);
      expect(lo).toBeLessThan(4.7);
      expect(hi).toBeGreaterThan(3.3);
    }
    await page.click("#pauseButton");
    await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.speed))).toBe(0);
    const held = [];
    for (const read of reads) held.push(await still(read));
    await page.click("#pauseButton");
    for (const [i, read] of reads.entries()) await expect.poll(read).toBeGreaterThan(held[i]);
    await page.click("#toggleSpeedhack");
    expect(errors).toEqual([]);
  });

  test("speed reschedules load-time intervals, virtualizes new Date() and the slider reaches 16", async () => {
    const { page, target, tabId, errors } = await open("/?interval=1", "SpeedHack");
    const ticks = () => target.evaluate(() => game.ticks * 20), date = () => target.evaluate(() => new Date().getTime());
    await expect.poll(ticks).toBeGreaterThan(100);
    await expect(page.locator("#shRange")).toHaveAttribute("max", "16");
    await page.fill("#shRange", "4");
    await page.click("#toggleSpeedhack");
    for (const read of [ticks, date]) {
      const [lo, hi] = await rate(page, read, 4, 4000);
      expect(lo).toBeLessThan(4.7);
      expect(hi).toBeGreaterThan(3.3);
    }
    await page.fill("#shRange", "0.5");
    const [lo, hi] = await rate(page, ticks, 0.5, 500);
    expect(lo).toBeLessThan(0.7);
    expect(hi).toBeGreaterThan(0.3);
    await page.click("#pauseButton");
    await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.speed))).toBe(0);
    const [t0, d0] = [await still(ticks), await still(date)];
    await page.click("#pauseButton");
    await expect.poll(ticks).toBeGreaterThan(t0);
    await expect.poll(date).toBeGreaterThan(d0);
    await page.fill("#shRange", "16");
    await expect(page.locator("#shValue")).toHaveText("16x");
    await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.speed))).toBe(16);
    const u = await x.ui(tabId);
    await u.page.click("#tabSpeedHackButton");
    await expect(u.page.locator("#shValue")).toHaveText("16x");
    await page.click("#toggleSpeedhack");
    await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.speed))).toBe(1);
    expect([...errors, ...u.errors]).toEqual([]);
  });

  test("worker clocks follow the speed multiplier and stop while paused", async () => {
    const { page, target, errors } = await open("/threads?early=1", "SpeedHack");
    expect(await target.evaluate(() => game.pong)).toBe(true);
    const now = () => target.evaluate(() => game.workerNow());
    await page.fill("#shRange", "4");
    await page.click("#toggleSpeedhack");
    const [lo, hi] = await rate(page, now, 4, 4000);
    expect(lo).toBeLessThan(4.7);
    expect(hi).toBeGreaterThan(3.3);
    await page.click("#pauseButton");
    const w0 = await still(now);
    await page.click("#pauseButton");
    await expect.poll(now).toBeGreaterThan(w0 + 50);
    await page.click("#toggleSpeedhack");
    expect(errors).toEqual([]);
  });
});

test.describe("scan2", () => {
  let x;
  test.beforeAll(async () => { x = await launch(); });
  test.afterAll(() => x.close());
  test.afterEach(async () => { for (const p of x.ctx.pages()) await p.close(); });

  const open = async (path = "/") => {
    const g = await x.game(`${server.url}${path}`), u = await x.ui(g.tabId), p = u.page;
    await expect(p.locator("#lockOverlay")).toBeHidden();
    const scan = async (type, compare, value, set = {}) => {
      await expect(p.locator("#searchButton")).toBeEnabled();
      if (await p.locator("#searchType").isEnabled()) await p.selectOption("#searchType", type);
      else await expect(p.locator("#searchType")).toHaveValue(type);
      await p.selectOption("#searchCompare", compare);
      if (value != null) await p.fill("#searchParam", value);
      for (const [id, v] of Object.entries(set)) typeof v === "boolean" ? await p.setChecked(`#${id}`, v) : await p.locator(`#${id}`).evaluate((e, v) => e.value = v, v);
      await p.evaluate(() => resultsTitle.textContent = "");
      await p.click("#searchButton");
      await expect(p.locator("#resultsTitle")).toHaveText(/^Found \d+$/);
      return +(await p.locator("#resultsTitle").textContent()).slice(6);
    };
    const reset = async () => {
      await expect(p.locator("#searchButton")).toBeEnabled();
      if (await p.locator("#restartBtn").isEnabled()) await p.click("#restartBtn");
      await expect(p.locator("#searchButton")).toHaveText("First Scan");
    };
    return { ...g, ...u, scan, reset, row: (a, extra = "") => p.locator(`#results tr[data-address="${a}"]${extra}`) };
  };

  test("unknown i8 pages through results and undo restores the count", async () => {
    const { page, target, scan, errors } = await open();
    expect(await scan("i8", "unknown")).toBeGreaterThan(100);
    await expect(page.locator("#resultsPage")).toHaveText(/^1-100 of \d+$/);
    const first = await page.locator("#results tr[data-address]").first().getAttribute("data-address");
    await page.click("#resultsNext");
    await expect(page.locator("#resultsPage")).toHaveText(/^101-200 of \d+$/);
    await expect(page.locator("#results tr[data-address]").first()).not.toHaveAttribute("data-address", first);
    await page.click("#resultsPrev");
    await expect(page.locator("#results tr[data-address]").first()).toHaveAttribute("data-address", first);
    await page.click("#restartBtn");
    const n = await scan("i32", "eq", "100");
    await target.evaluate(() => game.damage(1));
    expect(await scan("i32", "increased")).toBe(0);
    await page.click("#scanUndo");
    await expect(page.locator("#resultsTitle")).toHaveText(`Found ${n}`);
    await expect(page.locator('#results tr[data-address="256"]')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("between, not, base first, case-insensitive text, all and binary find their values", async () => {
    const { page, target, scan, reset, row, errors } = await open();
    await scan("u32", "between", "490", { searchValue2: "510" });
    await expect(row(260)).toHaveCount(1);
    await reset();
    await scan("i32", "eq", "100");
    await target.evaluate(() => game.damage(10));
    await scan("i32", "eq", "100", { searchNot: true });
    await expect(row(256)).toHaveCount(1);
    await reset();
    await target.evaluate(() => game.setHealth(100));
    await scan("i32", "eq", "100", { searchNot: false });
    await target.evaluate(() => game.damage(5));
    await scan("i32", "decreased");
    await target.evaluate(() => game.setHealth(97));
    expect(await scan("i32", "decreased", null, { searchBase: "first" })).toBe(1);
    await expect(row(256)).toHaveCount(1);
    await reset();
    await scan("ascii", "eq", "player_one", { searchCaseSensitive: false });
    await expect(row(544)).toHaveCount(1);
    await reset();
    await target.evaluate(() => game.setHealth(100));
    await scan("all", "eq", "100");
    await expect(row(256, '[data-type="i32"]')).toHaveCount(1);
    await expect(row(256, '[data-type="i32"] .live')).toHaveText(/^\d+$/);
    await reset();
    await scan("binary", "eq", "11011110 ????1101");
    await expect(row(576)).toContainText("11011110 10101101");
    expect(errors).toEqual([]);
  });

  test("worker scans return worker:true and fall back under a strict CSP with identical rows", async () => {
    const body = { type: "i32", compare: "eq", value: "100", aligned: true, worker: true };
    const run = async path => {
      const { page } = await open(path), r = await page.evaluate(b => ui.request("scan", b), body);
      await page.context().pages().at(-2).close();
      return r;
    };
    const a = await run("/"), b = await run("/csp");
    expect([a.worker, b.worker]).toEqual([true, false]);
    expect(b.rows).toEqual(a.rows);
    expect(a.rows.some(r => r.address === 256)).toBe(true);
  });

  test("tolerance, rounding, range and alignment options narrow scans", async () => {
    const { target, scan, reset, row, errors } = await open();
    const none = { searchLower: "", searchUpper: "", searchAligned: true, searchRounding: "tolerance" };
    await scan("f32", "eq", "1.49", { ...none, searchTolerance: "0.02" });
    await expect(row(264)).toHaveCount(1);
    await reset();
    await scan("f32", "eq", "1.49", { ...none, searchTolerance: "0" });
    await expect(row(264)).toHaveCount(0);
    await reset();
    await scan("f32", "eq", "1", { ...none, searchRounding: "truncated" });
    await expect(row(264)).toHaveCount(1);
    await reset();
    expect(await scan("i32", "eq", "100", { ...none, searchLower: "0x100", searchUpper: "0x104" })).toBe(1);
    await expect(row(256)).toHaveCount(1);
    await reset();
    await scan("i32", "eq", "100", { ...none, searchLower: "0x104" });
    await expect(row(256)).toHaveCount(0);
    await reset();
    await target.evaluate(() => new DataView(game.raw.exports.memory.buffer).setInt32(0x3001, 777777, true));
    await scan("i32", "eq", "777777", { ...none, searchAligned: false });
    await expect(row(12289)).toHaveCount(1);
    await reset();
    await scan("i32", "eq", "777777", none);
    await expect(row(12289)).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("strings honour the search range", async () => {
    const { page, errors } = await open();
    const search = async lower => {
      await page.fill("#strSearchLower", lower);
      await page.fill("#strSearchUpper", "0x230");
      await page.evaluate(() => strResultsTitle.textContent = "");
      await page.click("#strSearchButton");
      await expect(page.locator("#strResultsTitle")).toHaveText(/^Found \d+$/);
      return page.locator("#stringResults tr[data-address]").evaluateAll(l => l.map(e => +e.dataset.address));
    };
    await page.click("#tabStringsButton");
    await page.selectOption("#strEncoding", "ascii");
    await page.fill("#strMinLength", "4");
    const a = await search("0x220");
    expect(a).toContain(544);
    await expect(page.locator('#stringResults tr[data-address="544"]')).toContainText("PLAYER_ONE");
    expect(a.every(v => v >= 0x220 && v < 0x230)).toBe(true);
    expect(await search("0x221")).not.toContain(544);
    expect(errors).toEqual([]);
  });

  test("strings page through results", async () => {
    const { page, target } = await open();
    await target.evaluate(() => { for (let i = 0; i < 150; i++) new Uint8Array(game.raw.exports.memory.buffer)[0x3000 + i * 2] = 0x41; });
    await page.click("#tabStringsButton");
    await page.fill("#strMinLength", "1");
    await page.click("#strSearchButton");
    await expect(page.locator("#strResultsPage")).toHaveText(/^1-100 of \d+$/);
    const first = await page.locator("#stringResults tr[data-address]").first().getAttribute("data-address");
    await page.click("#strResultsNext");
    await expect(page.locator("#strResultsPage")).toHaveText(/^101-\d+ of \d+$/);
    await expect(page.locator("#stringResults tr[data-address]").first()).not.toHaveAttribute("data-address", first);
    await page.click("#strResultsPrev");
    await expect(page.locator("#stringResults tr[data-address]").first()).toHaveAttribute("data-address", first);
  });

  test("scan, string and pointer results add selected rows or up to 500 rows", async () => {
    const { page, target, scan, errors } = await open();
    const table = () => page.evaluate(() => ui.table()), clear = () => page.evaluate(() => ui.table(() => []));
    await clear();
    const n = await scan("i8", "unknown"), rows = page.locator("#results tr[data-address]");
    await expect(page.locator("#resultsAddSelected")).toBeEnabled();
    const picked = [await rows.nth(0).getAttribute("data-address"), await rows.nth(5).getAttribute("data-address")].map(Number);
    await rows.nth(0).locator(".select-row").check();
    await rows.nth(5).locator(".select-row").check();
    await page.click("#resultsAddSelected");
    await expect.poll(table).toEqual(picked.map(address => ({ description: "", address, type: "i8" })));
    await clear();
    await page.click("#resultsAddAll");
    await expect.poll(async () => (await table()).length).toBe(Math.min(500, n));
    const all = await table();
    expect(all.every(e => e.type === "i8")).toBe(true);
    expect(new Set(all.map(e => e.address)).size).toBe(all.length);
    await page.click("#restartBtn");
    await expect(page.locator("#resultsAddAll")).toBeDisabled();
    await clear();
    await target.evaluate(() => { for (let i = 0; i < 150; i++) new Uint8Array(game.raw.exports.memory.buffer)[0x3000 + i * 2] = 0x41; });
    await page.click("#tabStringsButton");
    await page.selectOption("#strEncoding", "ascii");
    await page.fill("#strMinLength", "4");
    await page.click("#strSearchButton");
    const srows = page.locator("#stringResults tr[data-address]");
    await expect(srows.first()).toBeVisible();
    await page.locator("#stringResults .select-all").check();
    await page.click("#strResultsAddSelected");
    await expect.poll(async () => (await table()).length).toBe(await srows.count());
    expect((await table()).find(e => e.address === 544)).toEqual({ description: "", address: 544, type: "ascii", length: 10 });
    await clear();
    await page.fill("#strMinLength", "1");
    await page.evaluate(() => strResultsTitle.textContent = "");
    await page.click("#strSearchButton");
    await expect(page.locator("#strResultsTitle")).toHaveText(/^Found \d+$/);
    const sn = +(await page.locator("#strResultsTitle").textContent()).slice(6);
    expect(sn).toBeGreaterThan(100);
    await page.click("#strResultsAddAll");
    await expect.poll(async () => (await table()).length).toBe(Math.min(500, sn));
    await clear();
    await page.click("#tabPointerButton");
    await page.fill("#ptrAddress", "0x1010");
    await page.fill("#ptrDepth", "2");
    await page.fill("#ptrOffset", "4096");
    await page.selectOption("#ptrType", "i32");
    await page.click("#ptrScan");
    const prows = page.locator("#ptrResults tr[data-chain]");
    await expect(prows.first()).toBeVisible();
    await page.locator('#ptrResults tr[data-chain="[0x300] + 0x10"] .select-row').check();
    await page.click("#ptrResultsAddSelected");
    await expect.poll(table).toEqual([{ description: "", address: 0x1010, type: "i32", pointer: { base: { kind: "static", address: 0x300 }, offsets: [0x10] } }]);
    await page.click("#ptrResultsAddAll");
    await expect.poll(async () => (await table()).length).toBe(await prows.count());
    expect((await table()).every(e => e.pointer && e.type === "i32")).toBe(true);
    expect(errors).toEqual([]);
  });

  test("group scans find a struct, rescan the block and add one grouped entry per element", async () => {
    const { page, target, scan, row, errors } = await open();
    const table = () => page.evaluate(() => ui.table());
    await page.evaluate(() => ui.table(() => []));
    await page.selectOption("#searchType", "group");
    await expect(page.locator("#searchGroupHint")).toBeVisible();
    await expect(page.locator("#searchCompare option")).toHaveText(["Equal to"]);
    await page.fill("#searchParam", "4:100 zz");
    await page.click("#searchButton");
    await expect(page.locator("#errorToast")).toHaveText("Invalid group element: zz");
    expect(await scan("group", "eq", "4:100 4:500 f:1.5")).toBe(1);
    await expect(page.locator("#results tr[data-address]")).toHaveCount(1);
    await expect(row(256, " td.live")).toHaveText("i32:100 i32:500 f32:1.5");
    await expect(page.locator("#searchCompare option")).toHaveText(["Equal to", "Changed", "Unchanged"]);
    await target.evaluate(() => game.damage(10));
    await expect(row(256, " td.live")).toHaveText("i32:90 i32:500 f32:1.5");
    expect(await scan("group", "unchanged")).toBe(0);
    await page.click("#scanUndo");
    await expect(page.locator("#resultsTitle")).toHaveText("Found 1");
    expect(await scan("group", "changed")).toBe(1);
    expect(await scan("group", "eq", "4:90 4:* f:1.5")).toBe(1);
    await row(256).locator(".add-entry").click();
    const group = "4:90 4:* f:1.5 @ 0x100";
    await expect.poll(table).toEqual([{ description: "+0x0", address: 256, type: "i32", group }, { description: "+0x4", address: 260, type: "i32", group }, { description: "+0x8", address: 264, type: "f32", group }]);
    await page.click("#tabTableButton");
    await expect(page.locator(`#table tr.group[data-group="${group}"]`)).toHaveCount(1);
    await expect(page.locator("#table tr[data-address]")).toHaveCount(3);
    await page.locator('#table tr[data-address="260"] .entry-value').fill("777");
    await page.locator('#table tr[data-address="260"] .entry-value').press("Enter");
    await expect.poll(() => target.evaluate(() => game.readGold())).toBe(777);
    await page.evaluate(() => ui.table(() => []));
    await page.click("#tabSearchButton");
    await page.click("#resultsAddAll");
    await expect.poll(async () => (await table()).map(e => [e.address, e.group])).toEqual([[256, group], [260, group], [264, group]]);
    expect(await page.evaluate(async () => (r => [r.worker, r.count, r.rows[0].value])(await ui.send("scan", { type: "group", compare: "changed", worker: true })))).toEqual([true, 1, "i32:90 i32:777 f32:1.5"]);
    expect(errors).toEqual([]);
  });
  test("relational, decreased-by and percent compares find HEALTH", async () => {
    const { target, scan, reset, row, errors } = await open();
    const r = { searchLower: "0x100", searchUpper: "0x104" }, hp = v => target.evaluate(v => game.setHealth(v), v);
    await hp(100);
    for (const [c, v, n] of [["gt", "99", 1], ["gte", "100", 1], ["lt", "101", 1], ["lte", "100", 1], ["ne", "5", 1], ["gt", "100", 0], ["lt", "100", 0], ["ne", "100", 0]]) {
      expect(await scan("i32", c, v, r)).toBe(n);
      await expect(row(256)).toHaveCount(n);
      await reset();
    }
    await scan("i32", "eq", "100", r);
    await target.evaluate(() => game.damage(10));
    expect(await scan("i32", "decBy", "10")).toBe(1);
    await reset();
    await hp(100);
    await scan("i32", "eq", "100", r);
    await hp(150);
    expect(await scan("i32", "incPct", "40")).toBe(1);
    await hp(60);
    expect(await scan("i32", "decPct", "50")).toBe(1);
    expect(await scan("i32", "decPct", "70")).toBe(0);
    expect(errors).toEqual([]);
  });
});

test.describe("table2", () => {
  let x;
  test.beforeAll(async () => { x = await launch(); });
  test.afterAll(() => x.close());
  test.afterEach(async () => { for (const p of x.ctx.pages()) await p.close(); });

  const key = () => `${new URL(server.url).host}/`;
  const open = async (storage = {}) => {
    const sw = await x.worker();
    await sw.evaluate(s => chrome.storage.local.clear().then(() => chrome.storage.local.set(s)), storage);
    const g = await x.game(`${server.url}/`), u = await x.ui(g.tabId), p = u.page;
    await expect(p.locator("#lockOverlay")).toBeHidden();
    await p.click("#tabTableButton");
    const row = a => p.locator(`#table tr[data-address="${a}"]`);
    const add = async (address, type) => {
      await p.fill("#tableAddAddress", address);
      await p.selectOption("#tableAddType", type);
      await p.click("#tableAddButton");
      await expect(row(Number(address))).toHaveCount(1);
      return row(Number(address));
    };
    const reload = async () => {
      await g.page.reload();
      await g.page.waitForFunction(() => window.game?.readHealth);
      await expect.poll(() => p.evaluate(() => ui.state?.instances.length ?? 0)).toBe(1);
      await expect(p.locator("#lockOverlay")).toBeHidden();
    };
    const game = f => g.page.evaluate(f);
    const hold = (name, v) => g.page.evaluate(([n, v]) => new Promise(r => { game[n](v); let k = 0; const t = () => ++k > 3 ? r(game.readHealth()) : requestAnimationFrame(t); requestAnimationFrame(t); }), [name, v]);
    const stored = k => sw.evaluate(k => chrome.storage.local.get(k).then(r => r[k]), k);
    return { ...g, ...u, sw, row, add, reload, game, hold, stored };
  };

  test("freezes and watches persist across a reload", async () => {
    const { page, add, reload, game, hold, errors } = await open();
    await (await add("0x100", "i32")).locator(".entry-freeze").check();
    await (await add("0x104", "u32")).locator(".entry-watch-write").check();
    await expect.poll(() => page.evaluate(() => ui.table().then(l => l.map(e => [e.frozen ?? false, e.watch ?? null])))).toEqual([[true, null], [false, ["write"]]]);
    await reload();
    await expect(page.locator('#table tr[data-address="256"] .entry-freeze')).toBeChecked();
    await expect(page.locator('#table tr[data-address="260"] .entry-watch-write')).toBeChecked();
    expect(await hold("damage", 30)).toBe(100);
    await game(() => game.addGold(1));
    await expect(page.locator("#hits tr[data-func][data-offset] .hit-count")).toHaveText("1");
    await page.locator('#table tr[data-address="256"] .entry-freeze').uncheck();
    await game(() => game.damage(1));
    await page.reload();
    await expect(page.locator("#lockOverlay")).toBeHidden();
    await page.click("#tabTableButton");
    await expect(page.locator('#table tr[data-address="256"] .entry-freeze')).not.toBeChecked();
    expect(errors).toEqual([]);
  });

  test("live values survive bad entries and more than 500 rows, and lengths are capped", async () => {
    const { page, errors } = await open();
    const entries = [...Array.from({ length: 501 }, (_, i) => ({ description: `e${i}`, address: 0x100 + i * 4, type: "i32" })),
      { description: "long", address: 0, type: "ascii", length: 5000 }, { description: "other", address: 0, type: "i32", memory: 1 }];
    const bundle = { format: "cetus-remastered", version: 1, entries, patches: [] };
    await page.setInputFiles("#tableImport", { name: "big.cetus.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(bundle)) });
    const rows = page.locator("#table tr[data-address]");
    await expect(rows).toHaveCount(503);
    await expect(rows.nth(0).locator(".entry-value")).toHaveValue("100");
    await expect(rows.nth(500).locator(".entry-value")).toHaveValue(/^-?\d+$/);
    await expect(rows.nth(502).locator(".entry-value")).toHaveValue("?");
    const toast = page.locator("#errorToast");
    await rows.nth(501).locator(".entry-length").fill("4097");
    await rows.nth(501).locator(".entry-length").press("Enter");
    await expect(toast).toHaveText("Length must be 1 to 4096");
    await page.evaluate(() => (view.toastTimer = clearTimeout(view.toastTimer), el("errorToast").hidden = true));
    await page.fill("#tableAddAddress", "0x220");
    await page.selectOption("#tableAddType", "ascii");
    await page.fill("#tableAddLength", "5000");
    await page.click("#tableAddButton");
    await expect(toast).toHaveText("Length must be 1 to 4096");
    await expect(rows).toHaveCount(503);
    expect(errors).toEqual([]);
  });

  test("table refreshes wait while a row is being edited", async () => {
    const { page, sw, tabId, add, stored, errors } = await open();
    const desc = (await add("0x100", "i32")).locator(".entry-desc");
    await desc.evaluate(n => n.dataset.old = "1");
    await desc.fill("typing");
    await page.evaluate(() => (window.seen = 0, document.addEventListener("cetus:state", () => window.seen++)));
    for (let i = 0; i < 2; i++) await sw.evaluate(t => onCommand("toggle-freezes", { id: t }), tabId);
    await expect.poll(() => page.evaluate(() => window.seen)).toBeGreaterThanOrEqual(2);
    await expect.poll(() => page.evaluate(() => view.tableDue)).toBe(true);
    await expect(desc).toBeFocused();
    await expect(desc).toHaveValue("typing");
    await expect(page.locator("#table .entry-desc[data-old]")).toHaveCount(1);
    await desc.blur();
    await expect(page.locator("#table .entry-desc[data-old]")).toHaveCount(0);
    await expect(page.locator('#table tr[data-address="256"] .entry-desc')).toHaveValue("typing");
    await expect.poll(async () => Object.values(await stored("cheatTables"))[0][0].description).toBe("typing");
    expect(await page.evaluate(() => view.tableDue)).toBe(false);
    expect(errors).toEqual([]);
  });

  test("both watch kinds persist across a reload", async () => {
    const { page, add, reload, errors } = await open();
    const hp = await add("0x100", "i32");
    await hp.locator(".entry-watch-write").check();
    await hp.locator(".entry-watch-read").check();
    await expect.poll(() => page.evaluate(() => ui.table().then(l => l[0].watch))).toEqual(["write", "read"]);
    await reload();
    await expect(page.locator('#table tr[data-address="256"] .entry-watch-write')).toBeChecked();
    await expect(page.locator('#table tr[data-address="256"] .entry-watch-read')).toBeChecked();
    const ws = await page.evaluate(() => ui.request("state").then(s => s.watches.map(w => [w.address, w.kind]).sort()));
    expect(ws).toEqual([[256, "read"], [256, "write"]]);
    await page.locator('#table tr[data-address="256"] .entry-type').selectOption("u32");
    await expect.poll(() => page.evaluate(() => ui.table().then(l => [l[0].type, l[0].watch]))).toEqual(["u32", ["write", "read"]]);
    await expect(page.locator('#table tr[data-address="256"] .entry-watch-read')).toBeChecked();
    await page.locator('#table tr[data-address="256"] .entry-watch-read').uncheck();
    await expect.poll(() => page.evaluate(() => ui.table().then(l => l[0].watch))).toEqual(["write"]);
    expect(await page.evaluate(() => ui.request("state").then(s => s.watches.map(w => w.kind)))).toEqual(["write"]);
    expect(errors).toEqual([]);
  });

  test("modes, groups, hex, options and undo", async () => {
    const { page, row, add, game, hold, errors } = await open();
    const hp = await add("0x100", "i32");
    await hp.locator(".entry-mode").selectOption("noDecrease");
    await hp.locator(".entry-freeze").check();
    await expect.poll(() => page.evaluate(() => ui.state.freezes[0]?.mode)).toBe("noDecrease");
    expect(await hold("damage", 30)).toBe(100);
    expect(await hold("setHealth", 150)).toBe(150);
    await hp.locator(".entry-freeze").uncheck();
    await expect.poll(() => page.evaluate(() => ui.state.freezes.length)).toBe(0);
    await game(() => game.setHealth(100));

    await hp.locator(".entry-hex").check();
    await expect(hp.locator(".entry-value")).toHaveValue("0x64");
    await hp.locator(".entry-hex").uncheck();

    await add("0x104", "u32");
    for (const a of [256, 260]) {
      await row(a).locator(".entry-group").fill("player");
      await row(a).locator(".entry-group").press("Enter");
      await expect(row(a).locator(".entry-group")).toHaveValue("player");
    }
    const group = page.locator('#table tr.group[data-group="player"]');
    await group.locator(".group-freeze").check();
    await expect.poll(() => page.evaluate(() => ui.state.freezes.length)).toBe(2);
    await group.locator(".group-freeze").uncheck();
    await expect.poll(() => page.evaluate(() => ui.state.freezes.length)).toBe(0);
    await group.click();
    await expect(row(256)).toBeHidden();
    await group.click();
    await expect(row(256)).toBeVisible();

    await row(260).locator(".entry-value").fill("1");
    await row(260).locator(".entry-value").press("Enter");
    await expect.poll(() => game(() => game.readGold())).toBe(1);
    await page.click("#undoButton");
    await expect.poll(() => game(() => game.readGold())).toBe(500);

    await page.evaluate(() => ui.entry({ address: 260, type: "u32" }, { options: [{ value: "500", label: "Poor" }, { value: "9999", label: "Rich" }] }));
    await row(260).locator("select.entry-value").selectOption("9999");
    await expect.poll(() => game(() => game.readGold())).toBe(9999);
    expect(errors).toEqual([]);
  });

  test("manual pointer entries, address, type and length edits and bulk actions", async () => {
    const { page, row, add, game, stored, errors } = await open();
    const ptr = page.locator("#table tr[data-pointer]");
    const addText = async (text, type, length) => {
      await page.fill("#tableAddAddress", text);
      await page.selectOption("#tableAddType", type);
      if (length) await page.fill("#tableAddLength", length);
      await page.click("#tableAddButton");
    };
    await expect(page.locator("#tableAddLength")).toBeHidden();
    await addText("[0x300] + 0x10", "i32");
    await expect(ptr.locator(".entry-value")).toHaveValue("250");
    await expect(ptr.locator(".entry-address")).toHaveValue("[0x300] + 0x10");
    await game(() => { game.relocate(); new DataView(game.raw.exports.memory.buffer).setInt32(0x2010, 321, true); });
    await expect(ptr.locator(".entry-value")).toHaveValue("321");
    await addText("[[0x300] + 0x10] - 0x4", "u8");
    await addText("level + 0x8", "u8");
    await addText("0x100 + 0x4", "u8");
    await expect(page.locator("#errorToast")).toHaveText("Invalid address or pointer");
    expect((await stored("cheatTables"))[key()].map(e => e.pointer)).toEqual([{ base: { kind: "static", address: 0x300 }, offsets: [0x10] },
      { base: { kind: "static", address: 0x300 }, offsets: [0x10, -4] }, { base: { kind: "global", name: "level" }, offsets: [8] }]);
    await expect.poll(() => page.locator("#table tr[data-pointer] .entry-address").evaluateAll(l => l.map(i => i.value))).toEqual(["[0x300] + 0x10", "[[0x300] + 0x10] - 0x4", "level + 0x8"]);
    await page.selectOption("#tableAddType", "ascii");
    await expect(page.locator("#tableAddLength")).toBeVisible();
    await addText("0x220", "ascii", "6");
    await expect(row(0x220).locator(".entry-value")).toHaveValue("PLAYER");
    await row(0x220).locator(".entry-length").fill("10");
    await row(0x220).locator(".entry-length").press("Enter");
    await expect(row(0x220).locator(".entry-value")).toHaveValue("PLAYER_ONE");
    for (let n = 2; n >= 0; n--) (await ptr.first().locator(".entry-remove").click(), await expect(ptr).toHaveCount(n));
    await row(0x220).locator(".entry-remove").click();
    await expect(page.locator("#table tr[data-address]")).toHaveCount(0);

    await game(() => game.setHealth(70000));
    const hp = await add("0x100", "i32");
    await expect(hp.locator(".entry-value")).toHaveValue("70000");
    await hp.locator(".entry-freeze").check();
    await expect.poll(() => page.evaluate(() => ui.state.freezes.length)).toBe(1);
    await page.evaluate(() => ui.hotkeys(l => [...l, { combo: "Alt+K", action: "toggleFreeze", entry: { address: 256, type: "i32" } }]));
    await hp.locator(".entry-type").selectOption("i16");
    await expect(page.locator('#table tr[data-address="256"][data-type="i16"] .entry-value')).toHaveValue("4464");
    await expect.poll(() => page.evaluate(() => ui.state.freezes.map(f => [f.address, f.type]))).toEqual([[256, "i16"]]);
    await expect(page.locator('#table tr[data-address="256"] .entry-freeze')).toBeChecked();
    await page.locator('#table tr[data-address="256"] .entry-address').fill("0x104");
    await page.locator('#table tr[data-address="256"] .entry-address').press("Enter");
    await expect(row(260)).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => ui.state.freezes.map(f => [f.address, f.type, f.value]))).toEqual([[260, "i16", 4464]]);
    await expect.poll(() => game(() => game.readGold())).toBe(4464);
    expect((await stored("cheatTables"))[key()]).toMatchObject([{ address: 260, type: "i16", frozen: true, freezeValue: "4464" }]);
    expect((await stored("hotkeys"))[key()].map(h => h.entry)).toEqual([{ address: 260, type: "i16" }]);
    await expect(row(260).locator(".entry-hotkey")).toHaveText("Alt+K");
    await row(260).locator(".entry-freeze").uncheck();
    await expect.poll(() => page.evaluate(() => ui.state.freezes.length)).toBe(0);
    await row(260).locator(".entry-remove").click();

    await game(() => (game.setHealth(100), game.addGold(500 - game.readGold())));
    await add("0x100", "i32");
    await add("0x104", "u32");
    await add("0x108", "f32");
    for (const a of [256, 260]) await row(a).locator(".entry-select").check();
    await page.click("#tableBulkSet");
    await expect(page.locator("#errorToast")).toHaveText("Enter a value");
    await page.fill("#tableBulkValue", "7");
    await page.click("#tableBulkSet");
    await expect.poll(() => game(() => [game.readHealth(), game.readGold()])).toEqual([7, 7]);
    await expect(row(264).locator(".entry-value")).toHaveValue("1.5");
    await page.fill("#tableBulkValue", "");
    await page.click("#tableBulkFreeze");
    await expect.poll(() => page.evaluate(() => ui.state.freezes.map(f => f.address).sort())).toEqual([256, 260]);
    await game(() => game.damage(3));
    await expect.poll(() => game(() => game.readHealth())).toBe(7);
    await page.click("#tableBulkFreeze");
    await expect.poll(() => page.evaluate(() => ui.state.freezes.length)).toBe(0);
    await page.click("#tableBulkRemove");
    await expect(page.locator("#table tr[data-address]")).toHaveCount(1);
    await expect(row(264)).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("pointer entries can be watched at the address they resolve to", async () => {
    const { page, game, errors } = await open();
    await game(() => new DataView(game.raw.exports.memory.buffer).setUint32(0x300, 0xF0, true));
    await page.fill("#tableAddAddress", "[0x300] + 0x10");
    await page.click("#tableAddButton");
    const ptr = page.locator("#table tr[data-pointer]");
    await expect(ptr.locator(".entry-value")).toHaveValue("100");
    await expect(ptr.locator(".entry-watch-write")).toHaveAttribute("title", "The watch follows the address at enable time");
    await ptr.locator(".entry-watch-write").check();
    await expect.poll(() => page.evaluate(() => ui.state.watches.map(w => [w.address, w.kind, !!w.pointer]))).toEqual([[256, "write", true]]);
    await game(() => new DataView(game.raw.exports.memory.buffer).setUint32(0x300, 0x1000, true));
    for (let i = 0; i < 2; i++) await game(() => game.damage(1));
    await expect(page.locator("#hits tr[data-func][data-offset] .hit-count")).toHaveText("2");
    await expect.poll(() => page.evaluate(() => ui.table().then(l => l[0].watch))).toEqual(["write"]);
    await page.reload();
    await expect(page.locator("#lockOverlay")).toBeHidden();
    await page.click("#tabTableButton");
    await expect(page.locator("#table tr[data-pointer] .entry-watch-write")).toBeChecked();
    await page.locator("#table tr[data-pointer] .entry-watch-write").uncheck();
    await expect.poll(() => page.evaluate(() => ui.state.watches.length)).toBe(0);
    expect(errors).toEqual([]);
  });

  test("value lists from the options column", async () => {
    const { page, row, add, game, stored, errors } = await open();
    const gold = await add("0x104", "u32");
    await gold.locator(".entry-options").fill("0=Broke; 9999=Rich");
    await gold.locator(".entry-options").press("Enter");
    await expect(row(260).locator("select.entry-value option")).toHaveText(["Broke", "Rich"]);
    await row(260).locator("select.entry-value").selectOption({ label: "Rich" });
    await expect.poll(() => game(() => game.readGold())).toBe(9999);
    await row(260).locator(".entry-options").fill("x=Bad");
    await row(260).locator(".entry-options").press("Enter");
    await expect(page.locator("#errorToast")).toBeVisible();
    await expect(page.locator("#errorToast")).toHaveText("Invalid option value: x");
    await expect(row(260).locator(".entry-options")).toHaveValue("0=Broke; 9999=Rich");
    expect((await stored("cheatTables"))[key()][0].options).toEqual([{ value: "0", label: "Broke" }, { value: "9999", label: "Rich" }]);
    await row(260).locator(".entry-options").fill("");
    await row(260).locator(".entry-options").press("Enter");
    await expect(row(260).locator("input.entry-value")).toHaveValue("9999");
    expect((await stored("cheatTables"))[key()][0].options).toBeNull();
    await (await add("0x220", "ascii")).locator(".entry-options").isDisabled().then(d => expect(d).toBe(true));
    expect(errors).toEqual([]);
  });

  test("Enter writes the shown value even when the text is unchanged", async () => {
    const { page, add, game, errors } = await open();
    const hp = (await add("0x100", "i32")).locator(".entry-value");
    await expect(hp).toHaveValue("100");
    await hp.focus();
    await game(() => game.setHealth(5));
    await hp.press("Enter");
    await expect.poll(() => game(() => game.readHealth())).toBe(100);
    await page.click("#tabGlobalsButton");
    const level = page.locator('#globals tr[data-name="level"] .global-value');
    await expect(level).toHaveValue("3");
    await level.focus();
    await game(() => { game.raw.exports.level.value = 20; });
    await level.press("Enter");
    await expect.poll(() => game(() => game.level())).toBe(3);
    expect(errors).toEqual([]);
  });

  test("patch history reverts to the first save", async () => {
    const { page, game, reload, stored } = await open();
    await page.click("#tabPatchButton");
    await page.fill("#functionInput", "8");
    await page.click("#functionSearchButton");
    await expect(page.locator("#codeDisassembly")).toHaveValue(/i32\.const 240/);
    for (const v of [111, 222]) {
      await page.fill("#codeDisassembly", `i32.const ${v}\nend`);
      await page.click("#openSavePatchModalButton");
      await page.fill("#patchName", "p");
      await page.click("#savePatchButton");
      await expect(page.locator("#savePatchModal")).toHaveClass(/modal-hidden/);
    }
    await expect.poll(async () => (await stored("savedPatches"))[0].history?.length).toBe(1);
    await reload();
    expect(await game(() => game.magic())).toBe(222);
    await page.click("#openLoadPatchModalButton");
    await page.locator('#loadedPatchesTable tr[data-name="p"] .patch-revert').click();
    await expect(page.locator('#loadedPatchesTable tr[data-name="p"] .patch-revert')).toBeDisabled();
    await reload();
    expect(await game(() => game.magic())).toBe(111);
  });

  test("global freezes persist across reloads, warn on a module change and round-trip through JSON", async () => {
    const { page, reload, game, sw, stored, errors } = await open();
    const row = n => page.locator(`#globals tr[data-name="${n}"]`), hash = await page.evaluate(() => ui.state.instances[0].hash);
    const act = async f => {
      await page.locator("#globals > table").evaluate(t => t.dataset.old = "1");
      await f();
      await expect(page.locator("#globals > table[data-old]")).toHaveCount(0);
    };
    const set = (n, v) => act(async () => (await row(n).locator(".global-value").fill(v), await row(n).locator(".global-value").press("Enter")));
    const freeze = (n, on) => act(() => row(n).locator(".global-freeze").setChecked(on));
    const bumped = () => game(() => new Promise(r => { game.raw.exports.level.value = 30; let k = 0; const t = () => ++k > 3 ? r([game.level(), game.getLives()]) : requestAnimationFrame(t); requestAnimationFrame(t); }));
    await page.click("#tabGlobalsButton");
    await set("level", "7");
    await freeze("level", true);
    await freeze("lives", true);
    await set("lives", "8");
    await expect.poll(() => stored("globalFreezes")).toEqual({ [key()]: [{ global: "level", value: "7", hash }, { global: "lives", value: "8", hash }] });
    await reload();
    await expect(row("level").locator(".global-freeze")).toBeChecked();
    await expect(row("lives").locator(".global-freeze")).toBeChecked();
    await expect(page.locator("#globalsHashWarning")).toBeHidden();
    expect(await bumped()).toEqual([7, 8]);

    await sw.evaluate(([k, h]) => chrome.storage.local.set({ globalFreezes: { [k]: [{ global: "level", value: "9", hash: "old" }, { global: "lives", value: "8", hash: "old" }, { global: "lives", value: "6", hash: h }] } }), [key(), hash]);
    await reload();
    await expect(page.locator("#globalsHashWarning")).toBeVisible();
    await expect(page.locator("#globalsHashWarning")).toContainText("level");
    await expect(page.locator("#globalsHashWarning")).not.toContainText("lives");
    expect(await bumped()).toEqual([9, 6]);

    await page.click("#tabTableButton");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#tableExport")]);
    await page.click("#tabGlobalsButton");
    const file = JSON.parse(readFileSync(await download.path(), "utf8"));
    expect(file.globalFreezes).toEqual((await stored("globalFreezes"))[key()]);
    await freeze("level", false);
    await freeze("lives", false);
    await expect.poll(() => stored("globalFreezes")).toEqual({ [key()]: [] });
    await expect(page.locator("#globalsHashWarning")).toBeHidden();
    await page.setInputFiles("#tableImport", await download.path());
    await expect.poll(() => stored("globalFreezes")).toEqual({ [key()]: file.globalFreezes });
    await expect(page.locator("#globalsHashWarning")).toBeVisible();
    await reload();
    expect(await bumped()).toEqual([9, 6]);
    await set("level", "11");
    await expect.poll(() => stored("globalFreezes").then(s => s[key()].filter(f => f.global === "level"))).toEqual([{ global: "level", value: "9", hash: "old" }, { global: "level", value: "11", hash }]);
    await expect(page.locator("#globalsHashWarning")).toBeHidden();
    expect(await bumped()).toEqual([11, 6]);
    expect(errors).toEqual([]);
  });

  test("hotkeys, commands, hash warning and hotkey export", async () => {
    const { page, add, hold, tabId, sw, stored, errors } = await open({ tableHash: { [key()]: "x" } });
    await expect(page.locator("#tableHashWarning")).toBeVisible();
    await add("0x100", "i32");
    await page.fill("#hotkeyCombo", "ctrl+shift+f");
    await page.selectOption("#hotkeyAction", "toggleFreeze");
    await page.selectOption("#hotkeyEntry", "256:i32");
    await page.click("#hotkeyAdd");
    await expect(page.locator('#hotkeys tr[data-combo="Ctrl+Shift+F"]')).toHaveCount(1);
    await expect(page.locator('#table tr[data-address="256"] .entry-hotkey')).toHaveText("Ctrl+Shift+F");
    const gp = page.context().pages().find(p => p.url().startsWith(server.url));
    await gp.bringToFront();
    await gp.keyboard.press("Control+Shift+F");
    await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.freezes.length))).toBe(1);
    await expect.poll(() => stored("cheatTables").then(t => t[key()][0].frozen)).toBe(true);
    expect(await hold("damage", 30)).toBe(100);
    await gp.keyboard.press("Control+Shift+F");
    await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.freezes.length))).toBe(0);

    expect(await sw.evaluate(t => onCommand("toggle-speedhack", { id: t }).then(r => r.speed), tabId)).toBe(2);
    await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.speed))).toBe(2);
    await expect(page.locator("#toggleSpeedhack")).toHaveAttribute("enabled", "true");
    await expect(page.locator("#toggleSpeedhack")).toHaveText("Disable");
    await expect(page.locator("#shRange")).toHaveValue("2");
    await sw.evaluate(t => onCommand("toggle-speedhack", { id: t }), tabId);
    await expect(page.locator("#toggleSpeedhack")).toHaveAttribute("enabled", "false");

    const cmd = () => sw.evaluate(t => onCommand("toggle-freezes", { id: t }), tabId), notice = page.locator("#freezesSuspended");
    await expect(notice).toBeHidden();
    await page.locator('#table tr[data-address="256"] .entry-freeze').check();
    await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.freezes.length))).toBe(1);
    expect(await hold("damage", 10)).toBe(100);
    expect((await cmd()).freezesSuspended).toBe(true);
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("All freezes are suspended");
    expect(await hold("damage", 10)).toBe(90);
    await page.click("#resumeFreezes");
    await expect(notice).toBeHidden();
    expect(await page.evaluate(() => ui.request("state").then(s => s.freezesSuspended))).toBe(false);
    expect(await hold("damage", 10)).toBe(100);
    await cmd();
    await expect(notice).toBeVisible();
    expect(await hold("damage", 10)).toBeLessThan(100);
    await cmd();
    await expect(notice).toBeHidden();
    expect(await hold("damage", 10)).toBe(100);
    await page.locator('#table tr[data-address="256"] .entry-freeze').uncheck();
    expect((await sw.evaluate(() => chrome.commands.getAll())).map(c => c.name).filter(n => !n.startsWith("_")).sort()).toEqual(["toggle-freezes", "toggle-pause", "toggle-speedhack"]);

    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#tableExport")]);
    const file = JSON.parse(readFileSync(await download.path(), "utf8"));
    expect([file.version, file.hotkeys]).toEqual([2, [{ combo: "Ctrl+Shift+F", action: "toggleFreeze", entry: { address: 256, type: "i32" } }]]);
    await page.locator('#hotkeys tr[data-combo="Ctrl+Shift+F"] .hotkey-remove').click();
    await expect(page.locator("#hotkeys tr[data-combo]")).toHaveCount(0);
    await page.setInputFiles("#tableImport", await download.path());
    await expect(page.locator('#hotkeys tr[data-combo="Ctrl+Shift+F"]')).toHaveCount(1);
    expect(await stored("hotkeys")).toEqual({ [key()]: file.hotkeys });
    expect(errors).toEqual([]);
  });

  test("the table hash warning clears on accept and when the table is rebuilt", async () => {
    const seed = () => ({ tableHash: { [key()]: "x" }, cheatTables: { [key()]: [{ description: "", address: 256, type: "i32" }] } });
    let { page, add, stored, errors } = await open(seed());
    const warn = page.locator("#tableHashWarning");
    await expect(warn).toBeVisible();
    await page.click("#tableHashAccept");
    await expect(warn).toBeHidden();
    const hash = await page.evaluate(() => ui.state.instances[0].hash);
    await expect.poll(() => stored("tableHash").then(h => h[key()])).toBe(hash);
    expect(errors).toEqual([]);
    for (const p of x.ctx.pages()) await p.close();
    ({ page, add, stored, errors } = await open(seed()));
    await expect(page.locator("#tableHashWarning")).toBeVisible();
    await page.locator("#table .entry-remove").click();
    await expect(page.locator("#table tr[data-address]")).toHaveCount(0);
    await add("0x104", "i32");
    await expect(page.locator("#tableHashWarning")).toBeHidden();
    await expect.poll(() => stored("tableHash").then(h => h[key()])).toBe(hash);
    expect(errors).toEqual([]);
  });

  test("pause stops game time from the button, command, hotkey and scan", async () => {
    const { page, target, tabId, sw, errors } = await open();
    const elapsed = () => target.evaluate(() => game.elapsed()), btn = page.locator("#pauseButton"), speed = () => page.evaluate(() => ui.request("state").then(s => s.speed));
    const cmd = name => sw.evaluate(([n, t]) => onCommand(n, { id: t }), [name, tabId]);
    const still = async () => {
      await target.evaluate(() => { window.pausedFrames = 0; requestAnimationFrame(() => window.pausedFrames++); });
      const e0 = await elapsed(), t0 = Date.now();
      await expect.poll(async () => (expect(await elapsed()).toBe(e0), Date.now() - t0), { intervals: [50] }).toBeGreaterThanOrEqual(500);
      expect(await target.evaluate(() => window.pausedFrames)).toBe(0);
      return e0;
    };
    const runs = async e0 => {
      await expect.poll(() => target.evaluate(() => window.pausedFrames)).toBe(1);
      await expect.poll(elapsed).toBeGreaterThan(e0 + 50);
    };
    await expect(btn).toHaveText("Pause");
    await btn.click();
    await expect(btn).toHaveText("Resume");
    expect(await speed()).toBe(0);
    let e0 = await still();
    await btn.click();
    await expect(btn).toHaveText("Pause");
    await runs(e0);

    expect((await cmd("toggle-speedhack")).speed).toBe(2);
    expect((await cmd("toggle-pause")).speed).toBe(0);
    await expect(btn).toHaveText("Resume");
    e0 = await still();
    expect((await cmd("toggle-pause")).speed).toBe(2);
    await expect(btn).toHaveText("Pause");
    await runs(e0);
    await cmd("toggle-speedhack");

    const notice = page.locator("#freezesSuspended");
    expect((await cmd("toggle-freezes")).freezesSuspended).toBe(true);
    await expect(notice).toBeVisible();
    expect((await cmd("toggle-freezes")).freezesSuspended).toBe(false);
    await expect(notice).toBeHidden();

    await page.fill("#hotkeyCombo", "Alt+P");
    await page.selectOption("#hotkeyAction", "togglePause");
    await page.click("#hotkeyAdd");
    await expect(page.locator('#hotkeys tr[data-combo="Alt+P"]')).toHaveCount(1);
    await target.bringToFront();
    await target.keyboard.press("Alt+P");
    await expect.poll(speed).toBe(0);
    await expect(btn).toHaveText("Resume");
    e0 = await still();
    await target.keyboard.press("Alt+P");
    await expect.poll(speed).toBe(1);
    await runs(e0);

    await page.bringToFront();
    await page.click("#tabSearchButton");
    await page.evaluate(() => { const send = ui.send; window.sent = []; ui.send = (t, b) => (t === "scan" && sent.push(b), send.call(ui, t, b)); });
    await page.check("#searchPause");
    await page.fill("#searchParam", "100");
    await page.click("#searchButton");
    await expect(page.locator("#searchButton")).toHaveText("Next Scan");
    expect(await page.evaluate(() => sent.map(b => b.pause))).toEqual([true]);
    expect(await speed()).toBe(1);
    await expect(btn).toHaveText("Pause");
    expect(errors).toEqual([]);
  });

  test("value and command hotkeys from the form", async () => {
    const { page, add, target, game, stored, errors } = await open();
    const bind = async (combo, action, entry, value = "") => {
      await page.fill("#hotkeyCombo", combo);
      await page.selectOption("#hotkeyAction", action);
      if (entry) await page.selectOption("#hotkeyEntry", entry);
      await page.fill("#hotkeyValue", value);
      await page.click("#hotkeyAdd");
      await expect(page.locator(`#hotkeys tr[data-combo="${combo}"]`)).toHaveCount(1);
    };
    const press = async k => (await target.bringToFront(), target.keyboard.press(k));
    const state = () => page.evaluate(() => ui.request("state"));
    await bind("Alt+Z", "toggleSpeed");
    await bind("Alt+X", "toggleFreezes");
    await add("0x104", "u32");
    await add("0x100", "i32");
    await bind("Alt+I", "inc", "260:u32", "5");
    await bind("Alt+K", "set", "256:i32", "42");
    await expect(page.locator('#hotkeys tr[data-combo="Alt+I"] td').nth(3)).toHaveText("5");
    await expect(page.locator('#hotkeys tr[data-combo="Alt+I"] td').nth(2)).toHaveText("0x00000104 u32");
    expect((await stored("hotkeys"))[key()].filter(h => h.combo.startsWith("Alt+")).map(h => [h.combo, h.entry ?? null, h.value ?? null])).toEqual([
      ["Alt+Z", null, null], ["Alt+X", null, null], ["Alt+I", { address: 260, type: "u32" }, "5"], ["Alt+K", { address: 256, type: "i32" }, "42"]]);
    const gold = await game(() => game.readGold());
    await press("Alt+I");
    await expect.poll(() => game(() => game.readGold())).toBe(gold + 5);
    await press("Alt+K");
    await expect.poll(() => game(() => game.readHealth())).toBe(42);
    await press("Alt+Z");
    await expect.poll(() => state().then(s => s.speed)).toBe(2);
    await page.bringToFront();
    await page.click("#tabSpeedHackButton");
    await expect(page.locator("#toggleSpeedhack")).toHaveAttribute("enabled", "true");
    await press("Alt+X");
    await expect.poll(() => state().then(s => s.freezesSuspended)).toBe(true);
    expect(errors).toEqual([]);
  });

  test("invalid hotkey values are rejected and failing hotkeys toast", async () => {
    const { page, add, target, stored, errors } = await open(), toast = page.locator("#errorToast");
    await add("0x100", "i32");
    await page.fill("#hotkeyCombo", "Alt+J");
    await page.selectOption("#hotkeyAction", "set");
    await page.selectOption("#hotkeyEntry", "256:i32");
    await page.fill("#hotkeyValue", "abc");
    await page.click("#hotkeyAdd");
    await expect(toast).toHaveText("Invalid integer: abc");
    expect((await stored("hotkeys"))?.[key()] ?? []).toEqual([]);
    await page.evaluate(() => (view.toastTimer = clearTimeout(view.toastTimer), el("errorToast").hidden = true));
    await page.evaluate(() => ui.hotkeys(l => [...l, { combo: "Alt+J", action: "set", value: "5", entry: { pointer: { base: { kind: "static", address: 0x300 }, offsets: [1e9] }, type: "i32" } }]));
    await expect(page.locator('#hotkeys tr[data-combo="Alt+J"]')).toHaveCount(1);
    await target.bringToFront();
    await target.keyboard.press("Alt+J");
    await expect(toast).toBeVisible();
    await expect(toast).toHaveText("Hotkey Alt+J: Pointer does not resolve");
    expect(await target.evaluate(() => game.readHealth())).toBe(100);
    expect(errors).toEqual([]);
  });

  test("scan hotkeys run next scan and undo from the game page", async () => {
    const { page, target, tabId, stored, errors } = await open();
    const toast = page.locator("#errorToast"), title = "#resultsTitle";
    const bind = async (combo, action, compare) => {
      await page.fill("#hotkeyCombo", combo);
      await page.selectOption("#hotkeyAction", action);
      await expect(page.locator("#hotkeyCompare")).toBeVisible({ visible: action === "nextScan" });
      if (compare) await page.selectOption("#hotkeyCompare", compare);
      await page.click("#hotkeyAdd");
      await expect(page.locator(`#hotkeys tr[data-combo="${combo}"]`)).toHaveCount(1);
    };
    await bind("Ctrl+Shift+D", "nextScan", "decreased");
    await bind("Ctrl+Shift+Z", "undoScan");
    await expect(page.locator('#hotkeys tr[data-combo="Ctrl+Shift+D"] td').nth(2)).toHaveText("Decreased");
    expect((await stored("hotkeys"))[key()]).toEqual([
      { combo: "Ctrl+Shift+D", action: "nextScan", compare: "decreased" }, { combo: "Ctrl+Shift+Z", action: "undoScan" }]);
    const press = async k => (await target.bringToFront(), target.keyboard.press(k));
    await press("Control+Shift+D");
    await expect(toast).toHaveText("Hotkey Ctrl+Shift+D: No scan in progress");
    await page.bringToFront();
    await page.click("#tabSearchButton");
    await page.selectOption("#searchType", "i32");
    await page.selectOption("#searchCompare", "unknown");
    await page.click("#searchButton");
    await expect(page.locator(title)).toHaveText(/^Found \d+$/);
    const count = async p => Number((await p.locator(title).textContent()).slice(6)), first = await count(page);
    await target.evaluate(() => game.damage(5));
    await press("Control+Shift+D");
    await expect.poll(() => count(page)).toBeLessThan(first);
    await expect(page.locator('#results tr[data-address="256"]')).toHaveCount(1);
    const n = await count(page);
    await page.close();
    const u = await x.ui(tabId), p = u.page;
    await expect(p.locator("#lockOverlay")).toBeHidden();
    await expect(p.locator(title)).toHaveText(`Found ${n}`);
    await expect(p.locator('#results tr[data-address="256"]')).toHaveCount(1);
    await press("Control+Shift+Z");
    await expect(p.locator(title)).toHaveText(`Found ${first}`);
    await expect(p.locator("#resultsPage")).toHaveText(`1-100 of ${first}`);
    expect([...errors, ...u.errors]).toEqual([]);
  });

  test("toggleFreeze hotkey persists the freeze across reloads with the UI closed", async () => {
    const { page, add, target, tabId, stored, hold, errors } = await open();
    await add("0x100", "i32");
    await page.fill("#hotkeyCombo", "ctrl+shift+f");
    await page.selectOption("#hotkeyAction", "toggleFreeze");
    await page.selectOption("#hotkeyEntry", "256:i32");
    await page.click("#hotkeyAdd");
    await expect(page.locator('#hotkeys tr[data-combo="Ctrl+Shift+F"]')).toHaveCount(1);
    expect(errors).toEqual([]);
    await page.close();
    const entry = () => stored("cheatTables").then(t => t[key()].map(e => [e.frozen ?? false, e.freezeValue ?? null]));
    const reload = async () => {
      await target.reload();
      await target.waitForFunction(() => window.game?.readHealth);
      const u = await x.ui(tabId);
      await expect.poll(() => u.page.evaluate(() => ui.state?.instances.length ?? 0)).toBe(1);
      return u;
    };
    await target.bringToFront();
    await target.keyboard.press("Control+Shift+F");
    await expect.poll(entry).toEqual([[true, "100"]]);
    let u = await reload();
    await expect.poll(() => u.page.evaluate(() => ui.request("state").then(s => s.freezes.length))).toBe(1);
    await u.page.close();
    expect(await hold("damage", 30)).toBe(100);
    expect(await target.evaluate(() => game.readHealth())).toBe(100);
    await target.bringToFront();
    await target.keyboard.press("Control+Shift+F");
    await expect.poll(entry).toEqual([[false, null]]);
    u = await reload();
    await expect.poll(() => u.page.evaluate(() => ui.request("state").then(s => s.freezes.length))).toBe(0);
    await u.page.close();
    expect(await hold("damage", 30)).toBe(70);
  });
  test("group, speed and script hotkeys toggle, persist and export", async () => {
    const { page, add, target, tabId, stored, game, hold, errors } = await open();
    const frames = () => target.evaluate(() => new Promise(r => { let k = 0; const t = () => ++k > 3 ? r() : requestAnimationFrame(t); requestAnimationFrame(t); }));
    const press = async k => (await target.bringToFront(), target.keyboard.press(k));
    const state = p => p.evaluate(() => ui.request("state"));
    const bind = async (combo, action, pick) => {
      await page.fill("#hotkeyCombo", combo);
      await page.selectOption("#hotkeyAction", action);
      if (pick) await pick();
      await page.click("#hotkeyAdd");
      await expect(page.locator(`#hotkeys tr[data-combo="${combo}"]`)).toHaveCount(1);
    };
    for (const [a, t] of [["0x100", "i32"], ["0x104", "u32"]]) {
      const r = await add(a, t);
      await r.locator(".entry-group").fill("player");
      await r.locator(".entry-group").press("Enter");
      await expect(r.locator(".entry-group")).toHaveValue("player");
    }
    await expect(page.locator("#hotkeyGroup")).toBeHidden();
    await page.selectOption("#hotkeyAction", "toggleGroup");
    await expect(page.locator("#hotkeyGroup")).toBeVisible();
    await expect(page.locator("#hotkeyEntry")).toBeHidden();
    await expect(page.locator("#hotkeyScript")).toBeHidden();
    await bind("Ctrl+Shift+G", "toggleGroup", () => page.selectOption("#hotkeyGroup", "player"));
    await expect(page.locator('#hotkeys tr[data-combo="Ctrl+Shift+G"] td').nth(2)).toHaveText("Group player");
    for (const a of [256, 260]) await expect(page.locator(`#table tr[data-address="${a}"] .entry-hotkey`)).toHaveText("Ctrl+Shift+G");
    await press("Control+Shift+G");
    await expect.poll(() => state(page).then(s => s.freezes.length)).toBe(2);
    await expect.poll(() => stored("cheatTables").then(t => t[key()].map(e => [e.frozen, e.freezeValue]))).toEqual([[true, "100"], [true, "500"]]);
    await game(() => game.addGold(-1));
    expect(await hold("damage", 30)).toBe(100);
    expect(await game(() => game.readGold())).toBe(500);
    await expect(page.locator('#table tr.group[data-group="player"] .group-freeze')).toBeChecked();
    await press("Control+Shift+G");
    await expect.poll(() => state(page).then(s => s.freezes.length)).toBe(0);
    await expect.poll(() => stored("cheatTables").then(t => t[key()].map(e => e.frozen))).toEqual([false, false]);

    await page.bringToFront();
    await bind("Alt+S", "setSpeed", () => page.fill("#hotkeyValue", "3"));
    await press("Alt+S");
    await expect.poll(() => state(page).then(s => s.speed)).toBe(3);
    await page.bringToFront();
    await page.evaluate(() => ui.send("speed", { multiplier: 1 }));
    await bind("Alt+F", "freeze", async () => (await page.selectOption("#hotkeyEntry", "256:i32"), page.fill("#hotkeyValue", "120")));
    await bind("Alt+U", "unfreeze", () => page.selectOption("#hotkeyEntry", "256:i32"));
    await press("Alt+F");
    await expect.poll(() => stored("cheatTables").then(t => [t[key()][0].frozen, t[key()][0].freezeValue])).toEqual([true, "120"]);
    expect(await hold("damage", 30)).toBe(120);
    await press("Alt+U");
    await expect.poll(() => stored("cheatTables").then(t => [t[key()][0].frozen, t[key()][0].freezeValue])).toEqual([false, null]);
    expect(await hold("damage", 20)).toBe(100);
    await page.bringToFront();

    await page.click("#tabScriptsButton");
    await page.fill("#scriptName", "heal");
    await page.fill("#scriptCode", 'cetus.onTick(() => cetus.write(0x100, "i32", "55"))');
    await page.click("#scriptSave");
    await expect(page.locator('#scripts tr[data-name="heal"] .script-enable')).not.toBeChecked();
    await page.click("#tabTableButton");
    await page.selectOption("#hotkeyAction", "toggleScript");
    await expect(page.locator("#hotkeyScript")).toBeVisible();
    await expect(page.locator("#hotkeyGroup")).toBeHidden();
    await bind("Alt+T", "toggleScript", () => page.selectOption("#hotkeyScript", "heal"));
    await expect(page.locator('#hotkeys tr[data-combo="Alt+T"] td').nth(2)).toHaveText("Script heal");
    await press("Alt+T");
    await expect.poll(() => game(() => game.readHealth())).toBe(55);
    await page.bringToFront();
    await page.evaluate(() => ui.refresh());
    await page.click("#tabScriptsButton");
    await expect(page.locator('#scripts tr[data-name="heal"] .script-enable')).toBeChecked();
    await expect(page.locator('#scripts tr[data-name="heal"]')).toContainText("Running");
    await expect.poll(() => stored("scripts").then(s => s[key()][0].enabled)).toBe(true);
    await press("Alt+T");
    await expect.poll(() => state(page).then(s => s.scripts.length)).toBe(0);
    await game(() => game.setHealth(100));
    await frames();
    expect(await game(() => game.readHealth())).toBe(100);
    await page.bringToFront();
    await page.evaluate(() => ui.refresh());
    await expect(page.locator('#scripts tr[data-name="heal"] .script-enable')).not.toBeChecked();
    await expect.poll(() => stored("scripts").then(s => s[key()][0].enabled)).toBe(false);

    await page.click("#tabTableButton");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#tableExport")]);
    const file = JSON.parse(readFileSync(await download.path(), "utf8"));
    expect(file.hotkeys.map(({ combo, ...h }) => h)).toEqual([{ action: "toggleGroup", group: "player", entries: [{ address: 256, type: "i32" }, { address: 260, type: "u32" }] },
      { action: "setSpeed", value: "3" }, { action: "freeze", entry: { address: 256, type: "i32" }, value: "120" }, { action: "unfreeze", entry: { address: 256, type: "i32" } },
      { action: "toggleScript", script: "heal" }]);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#tableExportUserscript")]);
    const text = readFileSync(await dl.path(), "utf8");
    expect(errors).toEqual([]);

    await page.close();
    await target.reload();
    await target.waitForFunction(() => window.game?.readHealth);
    await target.evaluate(() => new Promise(r => requestAnimationFrame(r)));
    await press("Alt+T");
    await expect.poll(() => game(() => game.readHealth())).toBe(55);
    await expect.poll(() => stored("scripts").then(s => s[key()][0].enabled)).toBe(true);
    const u = await x.ui(tabId);
    await expect.poll(() => u.page.evaluate(() => ui.state?.scripts ?? [])).toEqual([{ name: "heal", running: true, error: null }]);
    await u.page.close();

    const browser = await chromium.launch({ channel: "chromium", headless: true }), ctx = await browser.newContext();
    try {
      await ctx.addInitScript({ content: text });
      const gp = await ctx.newPage(), keep = n => gp.evaluate(n => new Promise(r => { game.damage(n); game.addGold(-1); let k = 0; const t = () => ++k > 3 ? r([game.readHealth(), game.readGold()]) : requestAnimationFrame(t); requestAnimationFrame(t); }), n);
      await gp.goto(`${server.url}/`);
      await gp.waitForFunction(() => window.game?.readHealth);
      await expect.poll(() => gp.evaluate(() => new Promise(r => requestAnimationFrame(() => r(game.readHealth()))))).toBe(100);
      await gp.keyboard.press("Control+Shift+G");
      expect(await keep(30)).toEqual([100, 500]);
      await gp.keyboard.press("Control+Shift+G");
      await gp.keyboard.press("Alt+T");
      await expect.poll(() => gp.evaluate(() => game.readHealth())).toBe(55);
    } finally {
      await browser.close();
    }
  });
  test("no-increase and step freezes, and a decrement hotkey", async () => {
    const { page, target, add, game, hold, stored, errors } = await open();
    const hp = await add("0x100", "i32"), health = () => game(() => game.readHealth());
    await hp.locator(".entry-mode").selectOption("noIncrease");
    await hp.locator(".entry-freeze").check();
    await expect.poll(() => page.evaluate(() => ui.state.freezes[0]?.mode)).toBe("noIncrease");
    expect(await hold("setHealth", 150)).toBe(100);
    expect(await hold("damage", 30)).toBe(70);
    await hp.locator(".entry-freeze").uncheck();
    await expect.poll(() => page.evaluate(() => ui.state.freezes.length)).toBe(0);
    await game(() => game.setHealth(100));
    await hp.locator(".entry-mode").selectOption("step");
    const step = hp.locator(".entry-step");
    await expect(step).toHaveValue("1");
    await step.fill("5");
    await step.press("Enter");
    await expect.poll(async () => (await stored("cheatTables"))[key()][0].step).toBe("5");
    const start = await health();
    await hp.locator(".entry-freeze").check();
    await expect.poll(health).toBeGreaterThanOrEqual(start + 10);
    expect((await stored("cheatTables"))[key()][0]).toMatchObject({ mode: "step", step: "5" });
    await hp.locator(".entry-freeze").uncheck();
    await expect.poll(() => page.evaluate(() => ui.state.freezes.length)).toBe(0);
    await game(() => game.setHealth(100));
    await page.fill("#hotkeyCombo", "Alt+D");
    await page.selectOption("#hotkeyAction", "dec");
    await page.selectOption("#hotkeyEntry", "256:i32");
    await page.fill("#hotkeyValue", "7");
    await page.click("#hotkeyAdd");
    await expect(page.locator('#hotkeys tr[data-combo="Alt+D"]')).toHaveCount(1);
    await target.bringToFront();
    await target.keyboard.press("Alt+D");
    await expect.poll(health).toBe(93);
    expect(errors).toEqual([]);
  });
});

test.describe("memtools", () => {
  let x;
  test.beforeAll(async () => { x = await launch(); });
  test.afterAll(() => x.close());
  test.afterEach(async () => { for (const p of x.ctx.pages()) await p.close(); });

  const open = async tab => {
    await (await x.worker()).evaluate(() => chrome.storage.local.clear());
    const g = await x.game(`${server.url}/`), u = await x.ui(g.tabId), p = u.page;
    await expect(p.locator("#lockOverlay")).toBeHidden();
    await p.click(`#tab${tab}Button`);
    return { ...g, ...u, game: f => g.page.evaluate(f) };
  };

  test("hex paging, inspector, changes, follow, bookmarks, add entry and dump", async () => {
    const { page, game, target, tabId, errors } = await open("MemView");
    const byte = a => page.locator(`#memViewGrid span[data-address="${a}"]`), first = () => page.locator("#memViewGrid span[data-address]").first();
    await page.selectOption("#memViewPageSize", "4096");
    await page.fill("#memViewPage", "2");
    await page.press("#memViewPage", "Enter");
    await expect(first()).toHaveAttribute("data-address", "4096");
    await expect(page.locator("#memViewPageCount")).toHaveText("of 16");
    await page.selectOption("#memDumpRange", "page");
    const [pd] = await Promise.all([target.waitForEvent("download"), page.click("#memDump")]);
    const pageBytes = readFileSync(await pd.path());
    expect(pageBytes.length).toBe(4096);
    expect([...pageBytes]).toEqual(await game(() => [...new Uint8Array(game.raw.exports.memory.buffer, 4096, 4096)]));
    await page.selectOption("#memDumpRange", "all");
    await page.fill("#memViewPage", "1");
    await page.press("#memViewPage", "Enter");
    await expect(first()).toHaveAttribute("data-address", "0");
    await byte(0x108).click();
    await expect(page.locator('#memViewInspector tr[data-type="f32"] .inspect-value')).toHaveValue("1.5");
    await expect(page.locator('#memViewInspector tr[data-type="u8"] .inspect-value')).toHaveValue("0");
    await game(() => game.damage(1));
    await expect(page.locator('#memViewGrid span.changed[data-address="256"]')).toHaveCount(1);
    await byte(0x300).click();
    await page.click("#memViewFollow");
    await expect(first()).toHaveAttribute("data-address", "4096");
    await expect(page.locator('#memViewInspector tr[data-type="i32"] .inspect-value')).toHaveValue("0");
    await page.click("#memViewBack");
    await expect(first()).toHaveAttribute("data-address", "0");
    await expect(page.locator("#memViewBack")).toBeDisabled();
    await byte(0x100).click();
    await page.fill("#memViewBookmarkLabel", "health");
    await page.click("#memViewBookmark");
    await expect(page.locator('#memViewBookmarks tr[data-address="256"]')).toContainText("health");
    await expect(page.locator("#memViewTitle")).toContainText("health (0x100)");
    await expect(byte(0x100)).toHaveAttribute("title", "health");
    await page.click('#memViewInspector tr[data-type="u32"]');
    await page.click("#memViewAddEntry");
    await expect.poll(() => page.evaluate(() => ui.table())).toEqual([{ description: "", address: 256, type: "u32" }]);
    await page.click("#tabTableButton");
    await expect(page.locator('#table tr[data-address="256"]')).toHaveCount(1);
    const u = await x.ui(tabId);
    await u.page.click("#tabMemViewButton");
    await expect(u.page.locator('#memViewBookmarks tr[data-address="256"]')).toContainText("health");
    await u.page.click("#tabMemViewButton");
    const [dl] = await Promise.all([target.waitForEvent("download"), u.page.click("#memDump")]);
    expect(dl.suggestedFilename()).toMatch(/^memory-\d+\.bin$/);
    expect(readFileSync(await dl.path()).length).toBe(65536);
    expect([...errors, ...u.errors]).toEqual([]);
  });

  test("inspector edits, find, fill, copy and paste", async () => {
    const { page, game, errors } = await open("MemView");
    await x.ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
    const byte = a => page.locator(`#memViewGrid span[data-address="${a}"]`), f32 = page.locator('#memViewInspector tr[data-type="f32"] .inspect-value');
    const u32 = a => game(`new DataView(game.raw.exports.memory.buffer).getUint32(${a}, true)`);
    await byte(0x108).click();
    await expect(f32).toHaveValue("1.5");
    await f32.fill("2.5");
    await f32.press("Enter");
    await expect.poll(() => game(() => new DataView(game.raw.exports.memory.buffer).getFloat32(0x108, true))).toBe(2.5);
    await page.click("#undoButton");
    await expect.poll(() => game(() => new DataView(game.raw.exports.memory.buffer).getFloat32(0x108, true))).toBe(1.5);
    await f32.fill("1.5");
    await f32.press("Enter");
    await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.undo))).toBe(1);

    await page.selectOption("#memFindType", "ascii");
    await page.fill("#memFindQuery", "PLAYER");
    await page.click("#memFind");
    await expect(page.locator("#memViewStartAddress")).toHaveValue(/^0x0*220$/i);
    await expect(page.locator("#memViewGrid span.selected")).toHaveCount(6);
    await expect(page.locator("#memViewGrid span.selected").first()).toHaveAttribute("data-address", String(0x220));
    await expect(page.locator("#memViewInspector th").first()).toHaveText("Type at 0x220");
    await page.click("#memFindNext");
    await expect(page.locator("#errorToast")).toHaveText("Not found");
    await page.selectOption("#memFindType", "aob");
    await page.fill("#memFindQuery", "00 00");
    await page.click("#memFind");
    await expect(page.locator("#memViewInspector th").first()).toHaveText("Type at 0x0");
    await page.click("#memFindNext");
    await expect(page.locator("#memViewInspector th").first()).toHaveText("Type at 0x1");
    await page.selectOption("#memFindType", "i32");
    await page.fill("#memFindQuery", "500");
    await page.click("#memFind");
    await expect(page.locator("#memViewInspector th").first()).toHaveText("Type at 0x104");

    await page.fill("#memViewStartAddress", "0x100");
    await page.click("#memViewGo");
    await byte(0x100).click();
    await page.fill("#memFillLength", "4");
    await page.fill("#memFillBytes", "00");
    await page.click("#memFill");
    await expect.poll(() => game(() => game.readHealth())).toBe(0);
    await page.fill("#memFillLength", "8");
    await page.fill("#memFillBytes", "12 34");
    await page.click("#memFill");
    await expect.poll(() => u32(0x104)).toBe(0x34123412);
    await page.click("#undoButton");
    await expect.poll(() => u32(0x104)).toBe(500);
    await expect.poll(() => game(() => game.readHealth())).toBe(0);
    await page.click("#undoButton");
    await expect.poll(() => game(() => game.readHealth())).toBe(100);
    await page.fill("#memFillLength", "2000000");
    await page.click("#memFill");
    await expect(page.locator("#errorToast")).toHaveText("Length must be 1 to 1048576");

    await byte(0x240).click();
    await byte(0x243).click({ modifiers: ["Shift"] });
    await expect(page.locator("#memViewGrid span.selected")).toHaveCount(4);
    await page.locator("#memViewGrid").press("Control+c");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("DE AD BE EF");
    await byte(0x100).click();
    await page.evaluate(() => navigator.clipboard.writeText("01 02 03"));
    await page.locator("#memViewGrid").press("ControlOrMeta+v");
    await expect.poll(() => game(() => game.readHealth())).toBe(0x030201);
    await page.click("#undoButton");
    await expect.poll(() => game(() => game.readHealth())).toBe(100);
    expect(errors).toEqual([]);
  });

  test("hex grid display types render, select, copy, edit and undo per element", async () => {
    const { page, game, errors } = await open("MemView");
    await x.ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
    const cell = a => page.locator(`#memViewGrid span[data-address="${a}"]`), selected = page.locator("#memViewGrid span.selected");
    await expect(cell(0x100)).toHaveText("64");
    await page.selectOption("#memViewDisplay", "f32");
    await expect(cell(0x108)).toHaveText("1.5");
    await expect(cell(0x108)).toHaveAttribute("data-type", "f32");
    await expect(page.locator("#memViewGrid span[data-address]")).toHaveCount(128);
    await expect(cell(0x109)).toHaveCount(0);
    await page.selectOption("#memViewDisplay", "hex32");
    await expect(cell(0x104)).toHaveText("000001F4");
    await page.selectOption("#memViewDisplay", "i64");
    await expect(cell(0x100)).toHaveAttribute("data-type", "i64");
    await page.selectOption("#memViewDisplay", "i32");
    await expect(cell(0x100)).toHaveText("100");
    await expect(cell(0x104)).toHaveText("500");
    await cell(0x100).click();
    await expect(selected).toHaveCount(1);
    await cell(0x104).click({ modifiers: ["Shift"] });
    await expect(selected).toHaveCount(2);
    await page.locator("#memViewGrid").press("ControlOrMeta+c");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("64 00 00 00 F4 01 00 00");
    await game(() => game.damage(1));
    await expect(page.locator('#memViewGrid span.changed[data-address="256"]')).toHaveCount(1);
    await expect(cell(0x100)).toHaveText("99");
    await game(() => game.setHealth(100));
    await expect(cell(0x100)).toHaveText("100");
    await cell(0x100).dblclick();
    await page.fill("#memViewByteInput", "abc");
    await page.press("#memViewByteInput", "Enter");
    await expect(page.locator("#errorToast")).toHaveText("Invalid i32 value");
    await cell(0x100).dblclick();
    await page.fill("#memViewByteInput", "321");
    await page.press("#memViewByteInput", "Enter");
    await expect.poll(() => game(() => game.readHealth())).toBe(321);
    await expect(cell(0x100)).toHaveText("321");
    await page.click("#undoButton");
    await expect.poll(() => game(() => game.readHealth())).toBe(100);
    await expect(cell(0x100)).toHaveText("100");
    await page.fill("#memViewStartAddress", "0x300");
    await page.click("#memViewGo");
    await cell(0x300).click();
    await page.click("#memViewFollow");
    await expect(page.locator("#memViewGrid span[data-address]").first()).toHaveAttribute("data-address", "4096");
    await expect(page.locator("#memViewGrid span.selected")).toHaveAttribute("data-type", "i32");
    await page.click("#memViewBack");
    await page.fill("#memViewStartAddress", "0x0");
    await page.click("#memViewGo");
    await page.selectOption("#memViewDisplay", "u8");
    await expect(page.locator("#memViewGrid span[data-address]")).toHaveCount(512);
    for (const [i, v] of ["64", "00", "00", "00"].entries()) await expect(cell(0x100 + i)).toHaveText(v);
    await expect(cell(0x100)).toHaveAttribute("data-type", "u8");
    expect(errors).toEqual([]);
  });

  test("snapshots restore memory and globals and a file loads into memory", async () => {
    const { page, game, errors } = await open("MemView");
    const row = n => page.locator(`#snapshots tr[data-name="${n}"]`);
    await expect(page.locator("#memSnapForm")).toHaveAttribute("title", /lost on reload/);
    await page.fill("#snapName", "start");
    await page.click("#snapSave");
    await expect(row("start")).toBeVisible();
    await expect(page.locator("#snapName")).toHaveValue("");
    await game(() => game.damage(50));
    await page.evaluate(() => ui.request("setGlobal", { name: "lives", value: "9" }));
    await expect.poll(() => game(() => [game.readHealth(), game.getLives()])).toEqual([50, 9]);
    await row("start").locator(".snap-restore").click();
    await expect.poll(() => game(() => [game.readHealth(), game.getLives()])).toEqual([100, 3]);
    await page.fill("#snapName", "other");
    await page.click("#snapSave");
    await expect(page.locator("#snapshots tr[data-name]")).toHaveCount(2);
    await row("other").locator(".snap-remove").click();
    await expect(page.locator("#snapshots tr[data-name]")).toHaveCount(1);
    await page.click("#snapSave");
    await expect(page.locator("#errorToast")).toHaveText("Enter a snapshot name");

    await page.fill("#memLoadAddress", "0x100");
    await page.setInputFiles("#memLoadFile", { name: "hp.bin", mimeType: "application/octet-stream", buffer: Buffer.from([0x2A, 0, 0, 0]) });
    await expect.poll(() => game(() => game.readHealth())).toBe(42);
    await expect(page.locator("#errorToast")).toHaveText("Loaded 4 bytes at 0x100");
    await page.fill("#memLoadAddress", "0xFFFE");
    await page.setInputFiles("#memLoadFile", { name: "big.bin", mimeType: "application/octet-stream", buffer: Buffer.from([1, 2, 3, 4]) });
    await expect(page.locator("#errorToast")).toHaveText("File does not fit in memory at that address");
    await row("start").locator(".snap-restore").click();
    await expect.poll(() => game(() => game.readHealth())).toBe(100);
    expect(errors).toEqual([]);
  });

  test("memory growth is picked up without reloading the UI", async () => {
    const { page, game, tabId, errors } = await open("MemView");
    const other = await x.ui(tabId);
    await expect(page.locator("#instanceHeader")).toContainText("64 KiB memory");
    await expect(page.locator("#memViewPageCount")).toHaveText("of 128");
    await game(() => game.raw.exports.memory.grow(1));
    await expect(page.locator("#instanceHeader")).toContainText("128 KiB memory", { timeout: 5000 });
    await expect(page.locator("#memViewPageCount")).toHaveText("of 256");
    await page.fill("#memViewStartAddress", "0x10010");
    await page.click("#memViewGo");
    await expect(page.locator('#memViewGrid span[data-address="65552"]')).toHaveCount(1);
    await expect(other.page.locator("#instanceHeader")).toContainText("128 KiB memory", { timeout: 5000 });
    expect([...errors, ...other.errors]).toEqual([]);
  });

  test("dissector guesses, saves, loads and compares", async () => {
    const { page, game, errors } = await open("Struct");
    const row = o => page.locator(`#structRows tr[data-offset="${o}"]`);
    await page.fill("#structAddress", "0x1000");
    await page.fill("#structSize", "8");
    await page.click("#structGo");
    await expect(page.locator("#structRows tr[data-offset]")).toHaveCount(2);
    expect(await page.locator("#structRows tr[data-offset]").evaluateAll(r => r.map(e => e.dataset.offset))).toEqual(["0", "4"]);
    await page.fill("#structSize", "64");
    await page.click("#structGo");
    await expect(row(16).locator(".struct-type")).toHaveValue("i32");
    await expect(row(16).locator(".struct-value")).toHaveText("250");
    await row(16).locator(".struct-name").fill("hp");
    await row(16).locator(".struct-name").press("Enter");
    await row(0).locator(".struct-type").selectOption("f32");
    await page.fill("#structName", "Hero");
    await page.click("#structSave");
    await page.reload();
    await expect(page.locator("#lockOverlay")).toBeHidden();
    await page.click("#tabStructButton");
    await page.fill("#structAddress", "0x1000");
    await page.selectOption("#structLoad", "Hero");
    await expect(row(16).locator(".struct-name")).toHaveValue("hp");
    await expect(row(0).locator(".struct-type")).toHaveValue("f32");
    await game(() => { game.relocate(); new DataView(game.raw.exports.memory.buffer).setInt32(0x2008, 7, true); });
    await page.fill("#structCompareAddress", "0x2000");
    await page.click("#structGo");
    await expect(row(8)).toHaveClass(/diff/);
    await expect(page.locator("#structRows tr.diff")).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("dissector re-flows by field size, edits text lengths, expands pointers and adds nested entries", async () => {
    const { page, game, errors } = await open("Struct");
    const row = p => page.locator(`#structRows tr[data-path="${p}"]`), offsets = () => page.locator("#structRows tr[data-depth=\"0\"]").evaluateAll(r => r.map(e => +e.dataset.offset));
    const saved = () => page.evaluate(async () => (await ui.annotations()).structs);
    await page.fill("#structAddress", "0x100");
    await page.fill("#structSize", "64");
    await page.click("#structGo");
    await row(0).locator(".struct-type").selectOption("i16");
    await expect.poll(offsets).toEqual(expect.arrayContaining([0, 2, 6]));
    expect((await offsets()).slice(0, 2)).toEqual([0, 2]);
    await expect(row(0).locator(".struct-value")).toHaveText("100");
    await row(0).locator(".struct-type").selectOption("i32");
    await expect.poll(async () => (await offsets()).slice(0, 5)).toEqual([0, 4, 8, 12, 16]);
    await row(16).locator(".struct-type").selectOption("f64");
    await expect.poll(async () => (await offsets()).slice(4, 6)).toEqual([16, 24]);
    await row(32).locator(".struct-type").selectOption("ascii");
    await expect(row(32).locator(".struct-length")).toHaveValue("16");
    await row(32).locator(".struct-length").fill("10");
    await row(32).locator(".struct-length").press("Enter");
    await expect(row(42)).toHaveCount(1);
    await row(32).locator(".struct-length").fill("0");
    await row(32).locator(".struct-length").press("Enter");
    await expect(page.locator("#errorToast")).toHaveText("Length must be 1 to 4096");
    await page.fill("#structName", "Stats");
    await page.click("#structSave");
    await expect.poll(async () => (await saved()).find(s => s.name === "Stats")?.fields.filter(f => [0, 16, 32].includes(f.offset)))
      .toEqual([{ offset: 0, type: "i32", name: "", size: 4 }, { offset: 16, type: "f64", name: "", size: 8 }, { offset: 32, type: "ascii", name: "", size: 10, length: 10 }]);

    await page.fill("#structAddress", "0x200");
    await page.click("#structGo");
    await expect(row(32).locator(".struct-value")).toHaveText("PLAYER_ONE");
    await row(0).locator(".struct-type").selectOption("utf16");
    await row(0).locator(".struct-length").fill("8");
    await row(0).locator(".struct-length").press("Enter");
    await expect(row(0).locator(".struct-value")).toHaveText("Hero");
    await expect(row(8)).toHaveCount(1);
    await page.fill("#structSize", "16");

    await page.fill("#structAddress", "0x300");
    await page.click("#structGo");
    await row(0).locator(".struct-type").selectOption("ptr");
    await expect(row(0).locator(".struct-value")).toHaveText("0x1000");
    await row(0).locator(".struct-expand").click();
    await expect(row("0.16").locator(".struct-value")).toHaveText("250");
    await expect(row("0.16")).toHaveClass(/struct-child/);
    await row("0.16").locator(".struct-name").fill("hp");
    await row("0.16").locator(".struct-name").press("Enter");
    await row(0).locator(".struct-nested").fill("Hero2");
    await row(0).locator(".struct-nested").press("Enter");
    await row("0.16").locator(".struct-add").click();
    await expect.poll(() => page.evaluate(async () => (await ui.table()).map(e => [e.pointer, e.type, e.description])))
      .toEqual([[{ base: { kind: "static", address: 0x300 }, offsets: [16] }, "i32", "hp"]]);
    await row(4).locator(".struct-add").click();
    await expect.poll(() => page.evaluate(async () => (await ui.table()).at(-1))).toMatchObject({ address: 0x304, type: "i32" });
    await page.fill("#structName", "Root");
    await page.click("#structSave");
    await expect.poll(async () => (s => [s.find(x => x.name === "Root")?.fields[0], s.find(x => x.name === "Hero2")?.fields.find(f => f.offset === 16)])(await saved()))
      .toEqual([{ offset: 0, type: "ptr", name: "", size: 4, struct: "Hero2" }, { offset: 16, type: "i32", name: "hp", size: 4 }]);
    await game(() => { game.relocate(); new DataView(game.raw.exports.memory.buffer).setInt32(0x1010, 1, true); });
    await expect(row("0.16").locator(".struct-value")).toHaveText("250");
    await page.click("#tabTableButton");
    await expect(page.locator("#table tr[data-pointer] .entry-value")).toHaveValue("250");

    await page.reload();
    await expect(page.locator("#lockOverlay")).toBeHidden();
    await page.click("#tabStructButton");
    await page.fill("#structAddress", "0x300");
    await page.selectOption("#structLoad", "Root");
    await expect(row("0.16").locator(".struct-name")).toHaveValue("hp");
    await expect(row("0.16").locator(".struct-value")).toHaveText("250");
    await expect(row(0).locator(".struct-nested")).toHaveValue("Hero2");
    await page.selectOption("#structLoad", "Stats");
    await page.fill("#structAddress", "0x100");
    await page.click("#structGo");
    await expect(row(32).locator(".struct-length")).toHaveValue("10");
    await expect(row(16).locator(".struct-type")).toHaveValue("f64");
    await expect(row(24)).toHaveCount(1);

    await game(() => { const dv = new DataView(game.raw.exports.memory.buffer); dv.setUint32(0x4000, 0x4000, true); for (let i = 1; i < 6; i++) dv.setUint32(0x4000 + i * 0x100, 0x4000 + (i + 1) * 0x100, true); });
    await page.fill("#structAddress", "0x4000");
    await page.fill("#structSize", "8");
    await page.click("#structGo");
    await row(0).locator(".struct-type").selectOption("ptr");
    await row(0).locator(".struct-expand").click();
    await expect(page.locator("#errorToast")).toHaveText("Pointer cycle at 0x4000");
    await expect(page.locator("#structRows tr.struct-child")).toHaveCount(0);
    await page.fill("#structAddress", "0x4100");
    await page.click("#structGo");
    for (const p of ["0", "0.0", "0.0.0", "0.0.0.0"]) await row(p).locator(".struct-expand").click();
    await expect(row("0.0.0.0.0").locator(".struct-value")).toHaveText("0x4600");
    await expect(row("0.0.0.0.0").locator(".struct-expand")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("pointer scan, rescan and a frozen pointer entry follow a relocation", async () => {
    const { page, game, errors } = await open("Pointer");
    const chain = page.locator('#ptrResults tr[data-chain="[0x300] + 0x10"]');
    await page.fill("#ptrAddress", "0x1010");
    await page.fill("#ptrDepth", "2");
    await page.fill("#ptrOffset", "0x8");
    await page.click("#ptrScan");
    await expect(page.locator("#ptrCount")).toHaveText(/^Found \d+$/);
    await expect(chain).toHaveCount(0);
    await page.fill("#ptrOffset", "4096");
    await page.click("#ptrScan");
    await expect(chain).toHaveCount(1);
    await expect(page.locator("#ptrCount")).toHaveText(/^Found \d+$/);
    await game(() => game.relocate());
    await page.fill("#ptrAddress", "0x2010");
    await page.click("#ptrRescan");
    await expect(chain).toHaveCount(1);
    await page.selectOption("#ptrType", "u32");
    await chain.locator(".add-entry").click();
    await expect.poll(() => page.evaluate(async () => (await ui.table()).map(e => e.type))).toEqual(["u32"]);
    await page.click("#tabTableButton");
    const entry = page.locator("#table tr[data-pointer]");
    await expect(entry.locator(".entry-value")).toHaveValue("250");
    await entry.locator(".entry-freeze").check();
    await expect.poll(() => page.evaluate(() => ui.state.freezes.length)).toBe(1);
    await game(() => { game.relocate(); new DataView(game.raw.exports.memory.buffer).setInt32(0x2010, 1, true); });
    await expect.poll(() => game(() => game.readHeroHp())).toBe(250);
    await game(() => { new Uint8Array(game.raw.exports.memory.buffer).copyWithin(0x3000, 0x2000, 0x2020); new DataView(game.raw.exports.memory.buffer).setUint32(0x300, 0x3000, true); });
    await game(() => new DataView(game.raw.exports.memory.buffer).setInt32(0x3010, 1, true));
    await expect.poll(() => game(() => game.readHeroHp())).toBe(250);
    await expect(entry.locator(".entry-address")).toHaveValue("[0x300] + 0x10");
    expect(errors).toEqual([]);
  });

  test("pointer scans persist per site, page, filter, rescan after a game reload and rescan by value", async () => {
    const { page, game, target, tabId, errors } = await open("Pointer");
    const chain = p => p.locator('#ptrResults tr[data-chain="[0x300] + 0x10"]'), count = async () => +(await page.locator("#ptrCount").textContent()).match(/^Found (\d+)/)[1];
    await game(() => { const dv = new DataView(game.raw.exports.memory.buffer); for (let a = 0x4000; a < 0x4400; a += 4) dv.setUint32(a, 0x1010, true); dv.setUint32(0x2f0, 0x4000, true); });
    await page.fill("#ptrAddress", "0x1010");
    await page.fill("#ptrDepth", "2");
    await page.fill("#ptrOffset", "4096");
    await page.click("#ptrScan");
    await expect(page.locator("#ptrPage")).toHaveText(/^1-100 of \d+$/);
    const n = await count();
    expect(n).toBeGreaterThan(256);
    await expect(page.locator("#ptrResults tr[data-chain]")).toHaveCount(100);
    await expect(chain(page)).toHaveCount(1);
    await page.click("#ptrNext");
    await expect(page.locator("#ptrPage")).toHaveText(`101-200 of ${n}`);
    await expect(chain(page)).toHaveCount(0);
    await page.click("#ptrPrev");
    await expect(chain(page)).toHaveCount(1);
    await page.fill("#ptrMaxLevel", "1");
    await expect(page.locator("#ptrCount")).toHaveText(new RegExp(`^Found ${n}, \\d+ match the filters$`));
    await expect(page.locator("#ptrResults tr[data-chain^='[[']")).toHaveCount(0);
    await expect(page.locator("#ptrNext")).toBeDisabled();
    await page.selectOption("#ptrBaseFilter", "global");
    await expect(page.locator("#ptrResults tr[data-chain]")).toHaveCount(0);
    await expect(page.locator("#ptrAddAll")).toBeDisabled();
    await page.selectOption("#ptrBaseFilter", "static");
    await expect(chain(page)).toHaveCount(1);
    await page.fill("#ptrMaxLevel", "");
    await page.selectOption("#ptrBaseFilter", "");
    await expect(page.locator("#ptrPage")).toHaveText(`1-100 of ${n}`);
    await expect.poll(() => page.evaluate(async () => (s => s && [s.target, s.type, s.rows.length, s.rows.some(p => p.base.address === 0x300 && p.offsets.join() === "16")])(await ui.pointerScan()))).toEqual([0x1010, "i32", n, true]);
    await page.click("#ptrAddAll");
    await expect(page.locator("#errorToast")).toContainText(`${n} chains match`);
    await page.evaluate(() => { window.lockSeen = false; new MutationObserver(() => lockSeen ||= !lockOverlay.hidden).observe(lockOverlay, { attributes: true }); });
    await target.reload();
    await target.waitForFunction(() => window.game?.readHealth);
    await expect.poll(() => page.evaluate(() => lockSeen && !!ui.state)).toBe(true);
    await game(() => game.relocate());
    await expect.poll(() => page.evaluate(() => ui.request("pointerRescan", { address: 0x2010 }).then(r => r.count, e => e.message))).toBe(0);
    const rescan = async () => (await page.evaluate(() => ptrCount.textContent = ""), await page.click("#ptrRescan"), await expect(page.locator("#ptrCount")).toHaveText(/^Found/));
    await page.fill("#ptrAddress", "0x2010");
    await rescan();
    await expect(chain(page)).toHaveCount(1);
    const m = await count();
    expect(m).toBeLessThan(n);
    await page.fill("#ptrRescanValue", "250");
    await rescan();
    await expect(chain(page)).toHaveCount(1);
    await expect.poll(() => page.evaluate(async () => (await ui.pointerScan())?.rows.length)).toBe(await count());
    const v = await x.ui(tabId);
    await expect(v.page.locator("#lockOverlay")).toBeHidden();
    await v.page.click("#tabPointerButton");
    await expect(chain(v.page)).toHaveCount(1);
    await expect(v.page.locator("#ptrAddress")).toHaveValue("0x2010");
    await expect(v.page.locator("#ptrType")).toHaveValue("i32");
    await v.page.click("#ptrAddAll");
    await expect.poll(() => v.page.evaluate(async () => (await ui.table()).length)).toBe(await v.page.locator("#ptrResults tr[data-chain]").count());
    expect(await v.page.evaluate(async () => (await ui.table()).find(e => e.pointer?.base.address === 0x300))).toEqual({ description: "", address: 0x2010, type: "i32", pointer: { base: { kind: "static", address: 0x300 }, offsets: [0x10] } });
    await v.page.fill("#ptrRescanValue", "999");
    await v.page.click("#ptrRescan");
    await expect(v.page.locator("#ptrCount")).toHaveText("Found 0");
    await expect(v.page.locator("#ptrRescan")).toBeDisabled();
    expect([...errors, ...v.errors]).toEqual([]);
  });

  test("hotkeys bind to pointer entries and follow a relocation", async () => {
    const { page, game, target, errors } = await open("Pointer");
    await page.fill("#ptrAddress", "0x1010");
    await page.fill("#ptrDepth", "2");
    await page.fill("#ptrOffset", "4096");
    await page.click("#ptrScan");
    await page.selectOption("#ptrType", "i32");
    await page.locator('#ptrResults tr[data-chain="[0x300] + 0x10"] .add-entry').click();
    await page.click("#tabTableButton");
    for (const a of ["0x100", "0x1010"]) {
      await page.fill("#tableAddAddress", a);
      await page.selectOption("#tableAddType", "i32");
      await page.click("#tableAddButton");
    }
    const ptr = page.locator("#table tr[data-pointer]"), health = page.locator('#table tr[data-address="256"]'), plain = page.locator('#table tr[data-address="4112"]:not([data-pointer])');
    await expect(plain).toHaveCount(1);
    await expect(page.locator("#hotkeyEntry option")).toHaveText(["[0x300] + 0x10 (i32)", "0x00000100 (i32)", "0x00001010 (i32)"]);
    const bind = async (combo, action, value = "") => {
      await page.fill("#hotkeyCombo", combo);
      await page.selectOption("#hotkeyAction", action);
      await page.selectOption("#hotkeyEntry", { label: "[0x300] + 0x10 (i32)" });
      await page.fill("#hotkeyValue", value);
      await page.click("#hotkeyAdd");
    };
    await bind("ctrl+shift+g", "set", "999");
    await bind("ctrl+shift+u", "toggleFreeze");
    const pointer = { base: { kind: "static", address: 0x300 }, offsets: [0x10] };
    expect((await page.evaluate(() => ui.hotkeys())).map(h => h.entry)).toEqual([{ pointer, type: "i32" }, { pointer, type: "i32" }]);
    await expect(ptr.locator(".entry-hotkey")).toHaveText("Ctrl+Shift+G, Ctrl+Shift+U");
    await expect(health.locator(".entry-hotkey")).toHaveText("");
    await expect(plain.locator(".entry-hotkey")).toHaveText("");
    await expect(page.locator('#hotkeys tr[data-combo="Ctrl+Shift+G"] td').nth(2)).toHaveText("[0x300] + 0x10 i32");
    await target.bringToFront();
    await target.keyboard.press("Control+Shift+G");
    await expect.poll(() => game(() => game.readHeroHp())).toBe(999);
    await game(() => { game.relocate(); const dv = new DataView(game.raw.exports.memory.buffer); dv.setInt32(0x2010, 1, true); dv.setInt32(0x1010, 5, true); });
    await target.keyboard.press("Control+Shift+G");
    await expect.poll(() => game(() => game.readHeroHp())).toBe(999);
    expect(await game(() => new DataView(game.raw.exports.memory.buffer).getInt32(0x1010, true))).toBe(5);
    await target.keyboard.press("Control+Shift+U");
    await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.freezes.map(f => f.pointer)))).toEqual([pointer]);
    await expect(ptr.locator(".entry-freeze")).toBeChecked();
    await expect(plain.locator(".entry-freeze")).not.toBeChecked();
    await game(() => new DataView(game.raw.exports.memory.buffer).setInt32(0x2010, 1, true));
    await expect.poll(() => game(() => game.readHeroHp())).toBe(999);
    await target.keyboard.press("Control+Shift+U");
    await expect.poll(() => page.evaluate(() => ui.request("state").then(s => s.freezes.length))).toBe(0);
    await expect(ptr.locator(".entry-freeze")).not.toBeChecked();
    expect(errors).toEqual([]);
  });
});

test.describe("modtools", () => {
  let x;
  test.beforeAll(async () => { x = await launch(); });
  test.afterAll(() => x.close());
  test.afterEach(async () => { for (const p of x.ctx.pages()) await p.close(); });

  const open = async tab => {
    await (await x.worker()).evaluate(() => chrome.storage.local.clear());
    const g = await x.game(`${server.url}/`), u = await x.ui(g.tabId), p = u.page;
    await expect(p.locator("#lockOverlay")).toBeHidden();
    await p.click(`#tab${tab}Button`);
    const reload = async () => {
      await g.page.reload();
      await g.page.waitForFunction(() => window.game?.readHealth);
    };
    return { ...g, ...u, reload, game: f => g.page.evaluate(f) };
  };

  test("function list, text and aob code search, comments and templates", async () => {
    const { page, tabId, reload, game, errors } = await open("Patch");
    const code = page.locator("#codeDisassembly");
    await page.fill("#functionFilter", "dam");
    await expect(page.locator("#functionList tr[data-index]")).toHaveCount(1);
    await expect(page.locator('#functionList tr[data-index="4"] .fn-name')).toHaveText("damage");
    await page.click('#functionList tr[data-index="4"]');
    await expect(code).toHaveValue(/i32\.store/);
    await expect(page.locator("#functionTitle")).toHaveText("Function 4: damage (i32) -> ()");
    await page.fill("#codeSearchQuery", "i32.store");
    await page.click("#codeSearchButton");
    const hit = page.locator('#codeResults tr[data-func="4"]');
    await expect(hit).toHaveCount(1);
    await expect(hit).toContainText("damage");
    await page.click('#functionList tr[data-index="4"]');
    await expect(code).not.toHaveAttribute("data-line");
    await hit.click();
    await expect(code).toHaveAttribute("data-line", /^\d+$/);
    const line = +(await code.getAttribute("data-line"));
    expect((await code.inputValue()).split("\n")[line - 1]).toContain("i32.store");
    await page.selectOption("#codeSearchMode", "aob");
    await page.fill("#codeSearchQuery", "41 F0 01 C0");
    await page.click("#codeSearchButton");
    await expect(page.locator("#codeResults tr[data-func]")).toHaveCount(1);
    await page.click('#codeResults tr[data-func="8"]');
    await expect(page.locator("#functionTitle")).toContainText("magic");
    await expect(code).toHaveAttribute("data-line", "1");
    await page.fill("#codeCommentText", "sign extend");
    await page.click("#codeComment");
    await expect(code).toHaveValue(/i32\.const 240 ;; sign extend/);
    await expect.poll(() => page.evaluate(() => ui.annotations().then(n => n.code))).toEqual([{ func: 8, offset: 0, comment: "sign extend" }]);

    const u = await x.ui(tabId), p = u.page;
    await p.click("#tabPatchButton");
    await p.fill("#functionFilter", "magic");
    await p.click('#functionList tr[data-index="8"]');
    await expect(p.locator("#codeDisassembly")).toHaveValue("i32.const 240 ;; sign extend\ni32.extend8_s\nend");
    await p.click("#openSavePatchModalButton");
    await p.fill("#patchName", "commented");
    await p.click("#savePatchButton");
    await expect(p.locator("#savePatchModal")).toHaveClass(/modal-hidden/);
    await expect.poll(() => p.evaluate(() => ui.patches().then(l => l[0]?.functionPatches))).toEqual([{ index: 6, bytes: [0x41, 0xF0, 0x01, 0xC0, 0x0B], space: "original" }]);

    await p.fill("#patchTemplateValue", "5");
    await p.selectOption("#patchTemplate", "return");
    await expect(p.locator("#codeDisassembly")).toHaveValue("i32.const 5\nend");
    await p.fill("#codeCommentText", "x");
    await p.click("#codeComment");
    await expect(p.locator("#codeDisassembly")).toHaveValue("i32.const 5\nend");
    await p.fill("#codeCommentText", "");
    await p.click("#openSavePatchModalButton");
    await p.fill("#patchName", "five");
    await p.click("#savePatchButton");
    await expect(p.locator("#savePatchModal")).toHaveClass(/modal-hidden/);
    await reload();
    expect(await game(() => game.magic())).toBe(5);
    await expect(p.locator("#lockOverlay")).toBeHidden();
    await p.click('#functionList tr[data-index="8"]');
    await expect(p.locator("#codeDisassembly")).toHaveValue(/^i32\.const 5 ;; sign extend\nend$/);
    await p.selectOption("#patchTemplate", "original");
    await expect(p.locator("#codeDisassembly")).toHaveValue("i32.const 240\ni32.extend8_s\nend");
    await p.click("#openSavePatchModalButton");
    await p.fill("#patchName", "five");
    await p.click("#savePatchButton");
    await expect(p.locator("#savePatchModal")).toHaveClass(/modal-hidden/);
    await reload();
    expect(await game(() => game.magic())).toBe(-16);
    await p.selectOption("#patchTemplate", "nop");
    await expect(p.locator("#codeDisassembly")).toHaveValue("i32.const 0\nend");
    await p.evaluate(() => view.fns = []);
    await p.selectOption("#patchTemplate", "return");
    await expect(p.locator("#errorToast")).toHaveText("Function signature is unknown");
    await expect(p.locator("#codeDisassembly")).toHaveValue("i32.const 0\nend");
    await p.evaluate(() => (view.toastTimer = clearTimeout(view.toastTimer), el("errorToast").hidden = true, cetusLib.disassemble = () => { throw new Error("Bad body"); }));
    await p.selectOption("#patchTemplate", "original");
    await expect(p.locator("#errorToast")).toHaveText("Bad body");
    expect([...errors, ...u.errors]).toEqual([]);
  });

  test("exports tab calls functions and dump buttons download modules", async () => {
    const { page, target, game, errors } = await open("Exports");
    const row = i => page.locator(`#exports tr[data-index="${i}"]`);
    await expect(row(3)).toContainText("setHealth");
    await row(3).locator(".fn-args input").fill("42");
    await row(3).locator(".fn-call").click();
    await expect(row(3).locator(".fn-result")).toHaveText("Done");
    expect(await game(() => game.readHealth())).toBe(42);
    const args = row(12).locator(".fn-args input");
    for (let i = 0; i < 4; i++) await args.nth(i).fill(String(i + 1));
    await row(12).locator(".fn-call").click();
    await expect(row(12).locator(".fn-result")).toHaveText("10");
    await page.fill("#exportsFilter", "secret");
    await expect(page.locator("#exports tr[data-index]")).toHaveCount(1);
    await row(15).locator(".fn-args input").fill("5");
    await row(15).locator(".fn-call").click();
    await expect(row(15).locator(".fn-result")).toHaveText("1005");
    await expect(row(15).locator(".fn-kind")).toHaveText("internal");
    await page.fill("#exportsFilter", "hiddenCalc");
    await expect(page.locator("#exports tr[data-index]")).toHaveCount(1);
    await expect(row(18).locator(".fn-kind")).toHaveText("internal");
    const probe = () => [typeof game.raw.exports.hiddenCalc, game.raw.exports.tbl.length];
    expect(await target.evaluate(probe)).toEqual(["undefined", 2]);
    await row(18).locator(".fn-args input").fill("5");
    await row(18).locator(".fn-call").click();
    await expect(row(18).locator(".fn-result")).toHaveText("22");
    await page.fill("#exportsFilter", "setHealth");
    await expect(row(3).locator(".fn-kind")).toHaveText("");
    await page.click("#tabPatchButton");
    const size = buildGame().length;
    for (const [id, name] of [["#dumpOriginal", /^module-\d+\.wasm$/], ["#dumpInstrumented", /^module-\d+\.instrumented\.wasm$/]]) {
      const [dl] = await Promise.all([target.waitForEvent("download"), page.click(id)]);
      expect(dl.suggestedFilename()).toMatch(name);
      const b = readFileSync(await dl.path());
      expect(await target.evaluate(a => WebAssembly.validate(new Uint8Array(a)), [...b])).toBe(true);
      id === "#dumpOriginal" ? expect(b.length).toBe(size) : expect(b.length).toBeGreaterThan(size);
    }
    expect(errors).toEqual([]);
  });
});
test.describe("scripts", () => {
  let x;
  test.beforeAll(async () => { x = await launch(); });
  test.afterAll(() => x.close());
  test.afterEach(async () => { for (const p of x.ctx.pages()) await p.close(); });

  const open = async (storage = {}) => {
    const sw = await x.worker();
    await sw.evaluate(s => chrome.storage.local.clear().then(() => chrome.storage.local.set(s)), storage);
    const g = await x.game(`${server.url}/`), u = await x.ui(g.tabId), p = u.page;
    await expect(p.locator("#lockOverlay")).toBeHidden();
    const hold = (pg, n) => pg.evaluate(n => new Promise(r => { game.damage(n); let k = 0; const t = () => ++k > 3 ? r(game.readHealth()) : requestAnimationFrame(t); requestAnimationFrame(t); }), n);
    const script = async (name, code) => {
      await p.click("#tabScriptsButton");
      await p.fill("#scriptName", name);
      await p.fill("#scriptCode", code);
      await p.click("#scriptSave");
      await p.locator(`#scripts tr[data-name="${name}"] .script-enable`).check();
      await expect(p.locator(`#scripts tr[data-name="${name}"]`)).toContainText("Running");
    };
    return { ...g, ...u, sw, hold, script, game: f => g.page.evaluate(f) };
  };

  test("scripts run, persist, log, bind hotkeys and round-trip through export", async () => {
    const { page, script, hold, game, errors } = await open();
    await script("health", 'cetus.onTick(() => cetus.write(0x100, "i32", "100"))');
    const gp = page.context().pages().find(p => p.url().startsWith(server.url));
    expect(await hold(gp, 50)).toBe(100);
    await gp.reload();
    await gp.waitForFunction(() => window.game?.readHealth);
    expect(await hold(gp, 50)).toBe(100);
    await expect(page.locator("#lockOverlay")).toBeHidden();
    await script("hello", 'cetus.log("hi")');
    await expect(page.locator("#scriptLog")).toContainText("hello: hi");
    await script("keys", 'cetus.hotkey("Ctrl+Shift+H", () => cetus.write(0x104, "u32", 7))');
    await gp.bringToFront();
    await gp.keyboard.press("Control+Shift+H");
    await expect.poll(() => game(() => game.readGold())).toBe(7);
    await page.click("#tabTableButton");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#tableExport")]);
    const file = JSON.parse(readFileSync(await download.path(), "utf8"));
    expect(file.scripts.map(s => [s.name, s.enabled])).toEqual([["health", true], ["hello", true], ["keys", true]]);
    await page.click("#tabScriptsButton");
    for (const n of ["health", "hello", "keys"]) await page.locator(`#scripts tr[data-name="${n}"] .script-remove`).click();
    await expect(page.locator("#scripts tr[data-name]")).toHaveCount(0);
    const dialogs = [];
    page.on("dialog", d => (dialogs.push(d.message()), d.accept()));
    await page.setInputFiles("#tableImport", await download.path());
    await expect(page.locator("#scripts tr[data-name]")).toHaveCount(3);
    expect(dialogs).toEqual(["This file contains JavaScript that will run on the game page. Import it?"]);
    await page.click('#scripts tr[data-name="health"] td:nth-child(2)');
    await expect(page.locator("#scriptCode")).toHaveValue(/onTick/);
    expect(errors).toEqual([]);
  });

  test("custom and big-endian types scan, freeze, export and import", async () => {
    const { page, game, errors } = await open(), rows = page.locator("#results tr[data-address]"), raw = 1234 ^ 0x5A5A5A5A;
    const xor = { name: "xor", size: 4, decode: "new DataView(bytes.buffer).getInt32(0,true)^0x5A5A5A5A",
      encode: "const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, value ^ 0x5A5A5A5A, true); return [...b];" };
    const scan = async (type, value) => {
      await page.click("#tabSearchButton");
      await page.selectOption("#searchType", type);
      await page.selectOption("#searchCompare", "eq");
      await page.fill("#searchParam", value);
      await page.evaluate(() => resultsTitle.textContent = "");
      await page.click("#searchButton");
      await expect(page.locator("#resultsTitle")).toHaveText("Found 1");
    };
    await page.click("#tabScriptsButton");
    for (const k of ["Name", "Size", "Decode", "Encode"]) await page.fill(`#customType${k}`, String(xor[k.toLowerCase()]));
    await page.click("#customTypeSave");
    await expect(page.locator('#customTypes tr[data-name="xor"]')).toContainText("4");
    for (const id of ["#searchType", "#tableAddType", "#memFindType", "#ptrType"]) {
      await expect(page.locator(`${id} option[value="xor"], ${id} option[value="u32be"], ${id} option[value="f64be"]`)).toHaveCount(3);
    }
    await game(() => game.setHealth(1234 ^ 0x5A5A5A5A));
    await scan("xor", "1234");
    await expect(rows.first()).toHaveAttribute("data-address", String(GAME.HEALTH));
    await expect(rows.first()).toContainText("1234");
    await rows.first().locator(".add-entry").click();
    await page.click("#tabTableButton");
    const tr = page.locator(`#table tr[data-address="${GAME.HEALTH}"]`);
    await expect(tr.locator(".entry-type")).toHaveValue("xor");
    await expect(tr.locator(".entry-value")).toHaveValue("1234");
    await tr.locator(".entry-freeze").check();
    const bytes = () => game(() => [...new Uint8Array(game.raw.exports.memory.buffer, 0x100, 4)]);
    await game(() => game.setHealth(5));
    await expect.poll(bytes).toEqual([...new Uint8Array(new Int32Array([raw]).buffer)]);
    await expect.poll(() => game(() => game.readHealth())).toBe(raw);
    await tr.locator(".entry-freeze").uncheck();
    await page.click("#tabSearchButton");
    await page.click("#restartBtn");
    await expect(page.locator("#searchButton")).toHaveText("First Scan");
    await scan("u32be", "287454020");
    await expect(rows.first()).toHaveAttribute("data-address", String(GAME.BE));
    await page.click("#tabTableButton");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#tableExport")]);
    expect(JSON.parse(readFileSync(await download.path(), "utf8")).customTypes).toEqual([xor]);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#tableExportUserscript")]);
    const cfg = /detail: ("\{\\"type\\":\\"config\\".*") \}\)\);/.exec(readFileSync(await dl.path(), "utf8"))[1];
    expect(JSON.parse(JSON.parse(cfg)).body.customTypes).toEqual([xor]);
    await page.click("#tabScriptsButton");
    await page.locator('#customTypes tr[data-name="xor"] .custom-type-remove').click();
    await expect(page.locator("#customTypes tr[data-name]")).toHaveCount(0);
    await expect(page.locator('#searchType option[value="xor"]')).toHaveCount(0);
    const dialogs = [];
    page.on("dialog", d => (dialogs.push(d.message()), d.accept()));
    await page.setInputFiles("#tableImport", await download.path());
    await expect(page.locator('#customTypes tr[data-name="xor"]')).toHaveCount(1);
    expect(dialogs).toEqual(["This file contains JavaScript that will run on the game page. Import it?"]);
    await page.click('#customTypes tr[data-name="xor"] td:first-child');
    await expect(page.locator("#customTypeDecode")).toHaveValue(xor.decode);
    const bundle = (customTypes, name) => ({ name: `${name}.cetus.json`, mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ format: "cetus-remastered", version: 2, customTypes, scripts: [{ name, code: "1" }] })) });
    await page.setInputFiles("#tableImport", bundle([{ ...xor, name: "broken", decode: "(" }], "never"));
    await expect(page.locator("#errorToast")).toContainText("Custom type broken");
    await expect(page.locator("#customTypes tr[data-name]")).toHaveCount(1);
    const dup = { ...xor, decode: `${xor.decode} ` };
    await page.setInputFiles("#tableImport", bundle([xor, dup], "dup"));
    await expect(page.locator('#scripts tr[data-name="dup"]')).toHaveCount(1);
    await expect(page.locator("#customTypes tr[data-name]")).toHaveCount(1);
    await page.click('#customTypes tr[data-name="xor"] td:first-child');
    await expect(page.locator("#customTypeDecode")).toHaveValue(dup.decode);
    await expect(page.locator('#scripts tr[data-name="never"]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a throwing export hook logs one error line, is removed and the original export runs", async () => {
    const { page, script, game, errors } = await open();
    await script("bad", "cetus.hookExport(\"addGold\", { before() { throw new Error(\"boom\") } })");
    const g0 = await game(() => game.readGold());
    await game(() => { game.raw.exports.addGold(5); game.raw.exports.addGold(5); });
    const line = page.locator("#scriptLog div.error", { hasText: "bad: " }).filter({ hasText: "boom" });
    await expect(line).toHaveCount(1);
    await page.waitForTimeout(300);
    await expect(line).toHaveCount(1);
    expect(await game(() => game.readGold())).toBe(g0 + 10);
    expect(errors).toEqual([]);
  });

  test("scripts call internal functions by index", async () => {
    const { page, script, errors } = await open();
    await script("calc", "cetus.log(cetus.call(18, 5), cetus.call(15, 1))");
    await expect(page.locator("#scriptLog")).toContainText("calc: 22 1001");
    expect(errors).toEqual([]);
  });

  test("disabling or removing a script undoes its freezes, watches, hooks, ticks, hotkeys and patches", async () => {
    const key = `${new URL(server.url).host}/`;
    const { page, script, game, errors } = await open({ cheatTables: { [key]: [{ description: "hp", address: 0x100, type: "i32" }, { description: "gold", address: 0x104, type: "u32" }] } });
    const gp = page.context().pages().find(p => p.url().startsWith(server.url)), frames = n => gp.evaluate(n => new Promise(r => { let k = 0; const t = () => ++k > n ? r() : requestAnimationFrame(t); requestAnimationFrame(t); }), n);
    const row = a => page.locator(`#table tr[data-address="${a}"]`), level = page.locator('#globals tr[data-name="level"] .global-freeze');
    const on = async () => {
      await script("all", `globalThis.ticks = 0; cetus.freeze(0x100, "i32", 999); cetus.freezeGlobal("level", 9); cetus.watch(0x104, 4); cetus.patch(0x220, "ascii", "XX");
        cetus.hookExport("addGold", { before: () => [1000] }); cetus.onTick(() => ticks++); cetus.hotkey("Ctrl+Shift+J", () => cetus.write(0x104, "u32", 5)); return () => cetus.log("undo")`);
      await game(() => (game.raw.exports.damage(50), game.raw.exports.addGold(1)));
      await frames(3);
      expect(await game(() => [game.readHealth(), game.readGold(), game.level(), window.ticks > 0])).toEqual([999, 1500, 9, true]);
      expect(await gp.evaluate(() => cetusLib.handle("readValues", { items: [{ address: 0x220, type: "ascii", length: 10 }] }).then(r => r.values[0]))).toBe("XXAYER_ONE");
      await gp.bringToFront();
      await gp.keyboard.press("Control+Shift+J");
      await expect.poll(() => game(() => game.readGold())).toBe(5);
      await page.click("#tabTableButton");
      await expect(row(256).locator(".entry-freeze")).toBeChecked();
      await expect(row(260).locator(".entry-watch-write")).toBeChecked();
      await expect(page.locator("#hits tr[data-func]")).not.toHaveCount(0);
      await page.click("#tabGlobalsButton");
      await expect(level).toBeChecked();
      await page.click("#tabScriptsButton");
    };
    const off = async () => {
      await expect(page.locator("#scriptLog")).toContainText("all: undo");
      await page.click("#tabTableButton");
      await expect(row(256).locator(".entry-freeze")).not.toBeChecked();
      await expect(row(260).locator(".entry-watch-write")).not.toBeChecked();
      await expect(page.locator("#hits tr[data-func]")).toHaveCount(0);
      await page.click("#tabGlobalsButton");
      await expect(level).not.toBeChecked();
      const t = await game(() => window.ticks);
      await game(() => (game.raw.exports.damage(50), game.raw.exports.level.value = 3, game.raw.exports.addGold(1)));
      await frames(3);
      expect(await game(() => [game.readHealth(), game.readGold(), game.level(), window.ticks])).toEqual([949, 6, 3, t]);
      await gp.bringToFront();
      await gp.keyboard.press("Control+Shift+J");
      await frames(2);
      expect(await game(() => game.readGold())).toBe(6);
      expect(await gp.evaluate(() => cetusLib.handle("state", {}).then(s => [s.freezes, s.watches, s.scripts]))).toEqual([[], [], []]);
      expect(await gp.evaluate(() => cetusLib.handle("readValues", { items: [{ address: 0x220, type: "ascii", length: 10 }] }).then(r => r.values[0]))).toBe("PLAYER_ONE");
      await page.click("#tabScriptsButton");
      await page.evaluate(() => document.getElementById("scriptLog").replaceChildren());
    };
    await on();
    await page.locator('#scripts tr[data-name="all"] .script-enable').uncheck();
    await off();
    await gp.evaluate(() => cetusLib.handle("write", { address: 0x104, type: "u32", value: "500" }));
    await on();
    await page.locator('#scripts tr[data-name="all"] .script-remove').click();
    await expect(page.locator("#scripts tr[data-name]")).toHaveCount(0);
    await off();
    expect(errors).toEqual([]);
  });

  test("JS tab finds and freezes a game object value", async () => {
    const { page, game, errors, tabId } = await open();
    await page.click("#tabJsButton");
    await page.selectOption("#jsCompare", "eq");
    await page.fill("#jsValue", "77");
    await page.click("#jsScanButton");
    const row = page.locator('#jsResults tr[data-path="game.js.player.hp"]');
    await expect(row).toHaveCount(1);
    await game(() => game.jsHit(7));
    await page.selectOption("#jsCompare", "decreased");
    await page.fill("#jsValue", "");
    await page.click("#jsScanButton");
    await expect(row.locator(".js-value")).toHaveValue("70");
    await row.locator(".js-freeze").check();
    await game(() => game.jsHit(7));
    expect(await game(() => game.js.player.hp)).toBe(70);
    await row.locator(".js-value").fill("90");
    await row.locator(".js-value").press("Enter");
    await expect.poll(() => game(() => game.js.player.hp)).toBe(90);
    await row.locator(".js-freeze").uncheck();
    await game(() => game.jsHit(1));
    expect(await game(() => game.js.player.hp)).toBe(89);
    await row.locator(".js-freeze").check();
    await expect(page.locator('#jsFrozen tr[data-path="game.js.player.hp"] .js-freeze')).toBeChecked();
    await page.click("#jsResetButton");
    await expect(page.locator("#jsCount")).toHaveText("");
    await expect(page.locator("#jsResults tr")).toHaveCount(0);
    await page.selectOption("#jsCompare", "eq");
    await page.fill("#jsValue", "90");
    await page.click("#jsScanButton");
    await expect(row.locator(".js-freeze")).toBeChecked();
    await page.close();
    const u = await x.ui(tabId), p = u.page, frozen = p.locator('#jsFrozen tr[data-path="game.js.player.hp"]'), hp = p.locator('#jsResults tr[data-path="game.js.player.hp"]');
    await expect(p.locator("#lockOverlay")).toBeHidden();
    await p.click("#tabJsButton");
    await expect(frozen.locator(".js-value")).toHaveValue("90");
    await expect(frozen.locator(".js-freeze")).toBeChecked();
    await game(() => game.jsHit(7));
    expect(await game(() => game.js.player.hp)).toBe(90);
    await frozen.locator(".js-value").fill("95");
    await frozen.locator(".js-value").press("Enter");
    await expect.poll(() => game(() => game.js.player.hp)).toBe(95);
    await frozen.locator(".js-freeze").click();
    await expect(p.locator("#jsFrozen tr[data-path]")).toHaveCount(0);
    await game(() => game.jsHit(7));
    expect(await game(() => game.js.player.hp)).toBe(88);
    await game(() => game.jsHit(11));
    await p.selectOption("#jsCompare", "eq");
    await p.fill("#jsValue", "89");
    await p.click("#jsScanButton");
    await expect(p.locator("#jsCount")).toHaveText(/^Found \d+$/);
    await expect(hp).toHaveCount(0);
    await p.click("#jsResetButton");
    await expect(p.locator("#jsCount")).toHaveText("");
    await expect(p.locator("#jsResults tr")).toHaveCount(0);
    await p.fill("#jsValue", "77");
    await p.click("#jsScanButton");
    await expect(hp).toHaveCount(1);
    await expect(hp.locator(".js-freeze")).not.toBeChecked();
    expect([...errors, ...u.errors]).toEqual([]);
  });

  test("trainer userscript applies patches and freezes without the extension", async () => {
    const key = `${new URL(server.url).host}/`;
    const { page, errors } = await open({ savedPatches: [{ name: "p1", url: key, enabled: true, version: 2, functionPatches: [{ index: 8, bytes: [0x41, 0xE7, 0x07, 0x0B] }] }],
      cheatTables: { [key]: [{ description: "hp", address: 0x100, type: "i32", frozen: true, freezeValue: "100" }] }, globalFreezes: { [key]: [{ global: "lives", value: "42", hash: null }] } });
    await page.click("#tabTableButton");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#tableExportUserscript")]);
    expect(dl.suggestedFilename()).toMatch(/\.user\.js$/);
    const text = readFileSync(await dl.path(), "utf8");
    expect(text.split("\n").slice(0, 8).join("\n")).toMatch(/^\/\/ ==UserScript==[^]*@match \*:\/\/localhost\/\*[^]*@run-at document-start[^]*\/\/ ==\/UserScript==$/);
    const browser = await chromium.launch({ channel: "chromium", headless: true }), ctx = await browser.newContext();
    try {
      await ctx.addInitScript({ content: text });
      const gp = await ctx.newPage();
      await gp.goto(`${server.url}/?early=1&own=1`);
      await gp.waitForFunction(() => window.game?.readHealth);
      expect(await gp.evaluate(() => game.magic())).toBe(999);
      await expect.poll(() => gp.evaluate(() => game.getLives())).toBe(42);
      expect(await gp.evaluate(async () => [await game.pong, await game.startWorker() ?? 0, await game.workerDamage(1)])).toEqual([true, 0, 99]);
      await expect.poll(() => gp.evaluate(() => cetusLib.handle("state", {}).then(s => s.instances.map(i => i.worker)))).toEqual([false, true]);
      expect(await gp.evaluate(() => new Promise(r => { game.damage(50); let k = 0; const t = () => ++k > 3 ? r(game.readHealth()) : requestAnimationFrame(t); requestAnimationFrame(t); }))).toBe(100);
    } finally {
      await browser.close();
    }
    expect(errors).toEqual([]);
  });

  test("trainer userscript shows a draggable in-page panel that freezes entries and hides on its key", async () => {
    const key = `${new URL(server.url).host}/`, hold = pg => pg.evaluate(() => new Promise(r => {
      game.damage(10);
      let k = 0;
      const t = () => ++k > 3 ? r(game.readHealth()) : requestAnimationFrame(t);
      requestAnimationFrame(t);
    }));
    const { page, game: inTab, errors } = await open({ cheatTables: { [key]: [{ description: "HEALTH", address: GAME.HEALTH, type: "i32" }, { description: "GOLD", address: GAME.GOLD, type: "u32", group: "loot" }] },
      hotkeys: { [key]: [{ combo: "Alt+H", action: "toggleFreeze", entry: { address: GAME.HEALTH, type: "i32" } }] } });
    await page.click("#tabTableButton");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#tableExportUserscript")]);
    const text = readFileSync(await dl.path(), "utf8");
    expect(await inTab(() => [...document.documentElement.children].map(n => n.tagName))).toEqual(["HEAD", "BODY"]);
    expect(errors).toEqual([]);
    const browser = await chromium.launch({ channel: "chromium", headless: true }), ctx = await browser.newContext();
    try {
      await ctx.addInitScript(() => {
        const a = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function (o) { return (window.roots ??= []).push(a.call(this, o)), window.roots.at(-1); };
      });
      await ctx.addInitScript({ content: text });
      const gp = await ctx.newPage();
      await gp.goto(`${server.url}/`);
      await gp.waitForFunction(() => window.game?.readHealth && window.roots?.length);
      const root = await gp.evaluateHandle(() => roots[0]);
      const q = async (sel, d) => (await root.evaluateHandle((r, [sel, d]) => d ? [...r.querySelectorAll(".r")].find(n => n.firstChild.textContent === d).querySelector(sel) : r.querySelector(sel), [sel, d])).asElement();
      expect(await root.evaluate(r => [r.mode, r.host.parentNode === document.documentElement, [...r.querySelectorAll(".r .d")].map(n => n.textContent), r.querySelector(".r .k").textContent]))
        .toEqual(["closed", true, ["HEALTH", "GOLD"], "Alt+H"]);
      await expect.poll(() => root.evaluate(r => r.querySelector(".r .v").textContent)).toBe("100");
      await (await q(".f", "HEALTH")).click();
      expect(await hold(gp)).toBe(100);
      await (await q("input[type=text]", "GOLD")).fill("777");
      await gp.keyboard.press("Enter");
      await expect.poll(() => gp.evaluate(() => game.readGold())).toBe(777);
      const bar = await (await q(".h")).boundingBox(), top = () => root.evaluate(r => Math.round(r.host.getBoundingClientRect().top)), top0 = await top();
      await gp.mouse.move(bar.x + 20, bar.y + 5);
      await gp.mouse.down();
      await gp.mouse.move(bar.x - 180, bar.y + 205, { steps: 4 });
      await gp.mouse.up();
      expect(await top()).toBe(top0 + 200);
      await (await q("button")).click();
      expect(await root.evaluate(r => r.querySelector(".r").checkVisibility())).toBe(false);
      await gp.keyboard.press("Control+Shift+T");
      expect(await root.evaluate(r => r.host.checkVisibility())).toBe(false);
      expect(await hold(gp)).toBe(100);
      await gp.keyboard.press("Control+Shift+T");
      expect(await root.evaluate(r => r.host.checkVisibility())).toBe(true);
    } finally {
      await browser.close();
    }
  });

  test("trainer userscript panel toggles scripts and runs value hotkeys", async () => {
    const key = `${new URL(server.url).host}/`;
    const { page, errors } = await open({ cheatTables: { [key]: [{ description: "GOLD", address: GAME.GOLD, type: "u32" }] },
      scripts: { [key]: [{ name: "heal", code: `cetus.write(${GAME.HEALTH}, "i32", 55)`, enabled: false }] },
      hotkeys: { [key]: [{ combo: "Alt+G", action: "set", value: "321", entry: { address: GAME.GOLD, type: "u32" } }] } });
    await page.click("#tabTableButton");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#tableExportUserscript")]);
    const text = readFileSync(await dl.path(), "utf8");
    const browser = await chromium.launch({ channel: "chromium", headless: true }), ctx = await browser.newContext(), pageErrors = [];
    try {
      await ctx.addInitScript(() => {
        const a = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function (o) { return (window.roots ??= []).push(a.call(this, o)), window.roots.at(-1); };
      });
      await ctx.addInitScript({ content: text });
      const gp = await ctx.newPage();
      gp.on("pageerror", e => pageErrors.push(e.message));
      await gp.goto(`${server.url}/`);
      await gp.waitForFunction(() => window.game?.readHealth && window.roots?.length);
      const root = await gp.evaluateHandle(() => roots[0]);
      const row = d => root.evaluateHandle((r, d) => [...r.querySelectorAll(".r")].find(n => n.querySelector(".d")?.textContent === d), d);
      expect(await (await row("heal")).evaluate(n => !!n.querySelector("input.s"))).toBe(true);
      await (await (await row("heal")).evaluateHandle(n => n.querySelector("input.s"))).asElement().check();
      await expect.poll(() => gp.evaluate(() => game.readHealth())).toBe(55);
      await gp.mouse.click(5, 5);
      await gp.keyboard.press("Alt+G");
      await expect.poll(() => gp.evaluate(() => game.readGold())).toBe(321);
      expect(await (await row("GOLD")).evaluate(n => n.querySelector(".k")?.textContent)).toBe("Alt+G");
    } finally {
      await browser.close();
    }
    expect([...errors, ...pageErrors]).toEqual([]);
  });
});

test.describe("memory64", () => {
  let x;
  test.beforeAll(async () => { x = await launch(); });
  test.afterAll(() => x.close());

  test("memory64 games are instrumented, report writers and scan, follow and dissect 8-byte pointers", async () => {
    await (await x.worker()).evaluate(() => chrome.storage.local.clear());
    const g = await x.game(`${server.url}/?mem64=1`), { page, errors } = await x.ui(g.tabId), game = f => g.page.evaluate(f);
    await expect(page.locator("#lockOverlay")).toBeHidden();
    await expect(page.locator("#instanceHeader")).toContainText("instrumented");
    await expect(page.locator("#instanceHeader")).not.toContainText("not instrumented");
    expect(await page.evaluate(() => [ui.state.instances[0].memory64, ui.state.instances[0].memories[0].i64])).toEqual([true, true]);

    await page.click("#tabTableButton");
    await page.fill("#tableAddAddress", "0x100");
    await page.selectOption("#tableAddType", "i32");
    await page.click("#tableAddButton");
    await page.locator('#table tr[data-address="256"] .entry-watch-write').check();
    await expect.poll(() => page.evaluate(() => ui.state.watches.length)).toBe(1);
    await game(() => game.damage(1));
    const hit = page.locator("#hits tr[data-func][data-offset]");
    await expect(hit).toContainText("damage");
    await expect(hit.locator(".hit-last")).toHaveText("100 -> 99");
    await page.locator('#table tr[data-address="256"] .entry-watch-write').uncheck();

    await page.click("#tabPointerButton");
    await page.fill("#ptrAddress", "0x1010");
    await page.fill("#ptrDepth", "2");
    await page.fill("#ptrOffset", "4096");
    await page.click("#ptrScan");
    await expect(page.locator('#ptrResults tr[data-chain="[0x300] + 0x10"]')).toBeVisible();

    await page.click("#tabStructButton");
    const row = p => page.locator(`#structRows tr[data-path="${p}"]`);
    await page.fill("#structAddress", "0x300");
    await page.fill("#structSize", "16");
    await page.click("#structGo");
    await expect(row(0).locator(".struct-type")).toHaveValue("ptr");
    await expect(row(0).locator(".struct-value")).toHaveText("0x1000");
    await expect.poll(() => page.locator('#structRows tr[data-depth="0"]').evaluateAll(r => r.map(e => +e.dataset.offset))).toEqual([0, 8, 12]);
    await row(0).locator(".struct-expand").click();
    await expect(row("0.16").locator(".struct-value")).toHaveText("250");
    await row("0.16").locator(".struct-add").click();
    await expect.poll(() => page.evaluate(async () => (await ui.table()).at(-1)))
      .toMatchObject({ pointer: { base: { kind: "static", address: 0x300 }, offsets: [16] }, type: "i32" });

    await page.click("#tabMemViewButton");
    await page.fill("#memViewStartAddress", "0x300");
    await page.click("#memViewGo");
    await page.locator('#memViewGrid span[data-address="768"]').click();
    await page.click("#memViewFollow");
    await expect(page.locator("#memViewGrid span[data-address]").first()).toHaveAttribute("data-address", "4096");
    await page.click("#memViewBack");
    await game(() => new DataView(game.raw.exports.memory.buffer).setUint32(0x304, 1, true));
    await page.locator('#memViewGrid span[data-address="768"]').click();
    await page.click("#memViewFollow");
    await expect(page.locator("#errorToast")).toHaveText("Pointer is outside memory");
    expect(errors).toEqual([]);
  });
});
