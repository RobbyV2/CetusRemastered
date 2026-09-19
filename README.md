# Cetus Remastered

![Logo](/icons/logo.png)

## Overview

Check out the slides for [Hacking WebAssembly Games with Binary Instrumentation](https://media.defcon.org/DEF%20CON%2027/DEF%20CON%2027%20presentations/DEFCON-27-Jack-Baker-Hacking-Web-Assembly-Games.pdf) at Defcon 27.

Cetus Remastered is a browser extension (Tested on Chrome and Firefox) for hacking WebAssembly games. Cetus Remastered implements a number of features familiar to [Cheat Engine](https://www.cheatengine.org) users

- Memory searching: exact, unknown initial value, changed, unchanged, increased, decreased, between, increased/decreased by a value or percent and "not" scans over i8 to u64, f32, f64, their big-endian variants (`i16be` to `f64be`, for emulators that keep guest RAM big-endian), custom types, binary and all types (with float tolerance or truncation), aligned or not, within an address range, against the previous or first scan or one of up to 3 named saved scans (Save Scan), with paging, scan undo and worker scans for large memories
- Custom types per site (Scripts tab, Types section, like Cheat Engine's custom types): a name, a size and two JavaScript snippets, `decode` (from `bytes`, a Uint8Array, to a number) and `encode` (from `value` to a byte array), run on the game page, for obfuscated or packed values; custom and big-endian types work everywhere a numeric type does (scans, table, freezes, hotkeys, structure dissector, find, pointer rescans) and travel with exports and trainers; a decode that throws shows as `?`
- String and array-of-bytes searching (ASCII, UTF-16, UTF-8, case-insensitive ASCII letters, AOB with `??` and nibble wildcards)
- Group scans for structures: `4:100 4:500 f:1.5` finds addresses where those values sit next to each other (types `1 2 4 8 f d` or full type names, `*` for any value, `@offset` to place an element); next scans re-check new values or whether the whole block changed, and adding a result puts every element in the cheat table as one group
- Cheat table with descriptions, groups, hex display, value lists (`value=Label; value=Label`), live values, editing and memory freezing (exact, no decrease, no increase, step); addresses or pointer chains (`[0x300] + 0x10`) can be added by hand, and an entry's address, type and length can be edited in place, moving its freeze and watches along; watches on pointer entries follow the address at enable time; selected entries can be set, frozen or removed together; freezes and watches persist per site and a warning shows when the module changed
- Watchpoints for reads and writes with per-instruction hit counts, the last old and new value and call stack of each hit (clicking a frame opens its code), an optional break into the page debugger on each hit, gated by a JS condition on `hit` (`{count, old, new, address, locals}`) when one is given, execute breakpoints on any instruction (set from the Patch tab, applied on reload) that count hits, keep the call stack, report the function's numeric params and locals of each hit and can break into the debugger under their own condition, a step trace that lists the branches and calls a chosen function ran in its last call and jumps to each one in the disassembly, coverage of every memory access (scalar, SIMD including lanes, atomic, and `memory.fill`/`copy`/`init`), a precise mode that also reports same-value writes, and access tracing of the addresses an instruction touches, armed from a hit or any load or store in the disassembly, with each address addable to the table (Implemented via binary instrumentation using [WAIL](https://github.com/Qwokka/wail), which also handles WasmGC, typed function references and exception handling modules)
- Hex editor with paging, a display type (bytes, 16, 32 and 64-bit integers, floats or 32-bit hex) whose cells select, copy and edit as whole values, an editable data inspector, find (byte patterns with wildcards, text or numbers) with find next, fill with a repeated byte pattern, range selection with hex copy and paste, change highlighting, pointer following, bookmarks, memory dumps and loading a file into memory at an address; edits, fills and pastes are undoable
- Memory snapshots: save up to 4 named copies of memory and every mutable numeric global (256 MiB in total) and restore them at any time; snapshots last for the page session and are lost on reload
- Structure dissector with variable-size fields (ascii, utf16 and utf8 lengths), nested pointer expansion up to 4 levels, adding any field (or a pointer chain to a nested field) to the table, saved layouts with nested structs and a compare address
- Pointer scanner (up to 100,000 chains) with paging, filters by chain length and base kind (static address or global), rescans by address or by the value the chain points at, and pointer entries in the cheat table; the last scan per site is saved, restored when the UI opens and rescanned against the reloaded game
- Scan, string and pointer results can be multi-selected and added to the cheat table together, or all at once (up to 500 rows)
- Globals editor listing every global (imported and defined) with its declared type (i32, i64, f32, f64, v128 or reference type) and mutability read from the module, including global freezes that persist per site and are re-applied on reload, with a warning when they were saved for a different build of the module, a list of the functions that read or write each global, and global write watches (after a reload, every instruction that sets a watched mutable numeric global is listed with its hit count and last value; clicking one opens its code)
- Code disassembly and assembly covering every Wasm 3.0 opcode (SIMD and relaxed SIMD, atomics, bulk memory, reference types, GC, tail calls, exception handling, multi-memory), with function names from the name section, a function list, code search (text or AOB), cross-references (callers, `ref.func`, table entries and the start function), double-click navigation through `call` lines with a back button, comments, call tracing with arguments and a code filter (after a reload with call counting on, narrow every function down to those that did or did not run since the last step, such as the one handling a game action, with their call counts; clicking one opens its code)
- Code patching, saved per site in the module's original function index space and applied on load (also when instrumentation fails, and unaffected by instrumentation options), with templates (nop, return, original), one-click replacement of a single instruction (from a watch hit or the selected line) with a stack-neutral equivalent, patch history and revert; a patch can declare scratch locals with a leading `local <type> ...` line (appended after the function's own locals, so existing local indices keep working), and the Save Patch dialog takes optional `processor` (JavaScript that gets the WAIL parser as `processor` before parsing, for example to add functions, globals or exports) and `preinstantiate` (JavaScript that gets the `module` bytes and `importObject`) callbacks, reopened (and editable on their own, whatever function is open) by clicking a patch name in the patch list; errors thrown by those callbacks are shown in the Patch tab
- Calling any function with arguments, including internal ones that are neither exported nor in a table (instrumented instances; the Exports tab marks them `internal`)
- Module dumps of the original and instrumented wasm
- Multiple instances and instances in dedicated, module, nested and shared workers and audio worklets, including shared memory, whenever they are created; a worker instance (a game running entirely in a worker, with its own memory, included, also inside an iframe) is selected like any other (a worker that is terminated, closed or crashes leaves the open list at once, and a respawned one takes over; its tables, patches, hotkeys and scripts are saved under the page's address, so they load again after a reload) and supports scans, reads and writes, freezes (run in the worker), the hex editor, globals, pointer scans, the structure dissector, snapshots, dumps, the function list, disassembly, patching, calls, watches and access tracing; the speedhack and pause also apply to workers, while scripts and the trainer's scripts act on page instances; freezes and watches stay on the instance that was active when they were set, and access tracing follows the active page instance
- Memory64 (64-bit memory) games are instrumented like any other, so watchpoints, access and call tracing, breakpoints, coverage and global watches work; pointer scans, pointer entries, the structure dissector and hex editor pointer following read 8-byte pointers there
- Multi-memory modules: every memory (imported, exported or internal) is listed, and a memory selector points scans, strings, the hex editor, find, fill, snapshots, dumps, pointer scans and new table entries at the chosen memory; script `cetus` calls use the selected memory; table entries, freezes, hotkeys, bookmarks, string results and pointer scans keep their memory, and watchpoints work on memory 0
- Speedhack from 0.1x to 16x (scales every timer and interval whenever it was created, `Date` and `performance.now`, and audio, event and animation timelines, in workers too)
- Pause: the Pause button next to Undo (or `Alt+Shift+P`) stops the game clock, holds animation frames and timers until Resume and then continues at the previous speed; a Search option pauses the game while a scan runs
- Write and patch undo
- Hotkeys in the page (freeze toggle, freeze, unfreeze, set, increase, decrease, set speed, speedhack, pause and freeze toggles, a whole table group's freeze toggle and a script on/off toggle, on plain or pointer entries, a pointer binding following the chain as it moves; next scan with any next-scan compare, and undo scan, on the current scan; freezes and script states changed by hotkey are saved and survive a reload even with the UI closed; a value that does not fit the entry type is refused when binding, and a hotkey that fails when pressed, such as on a pointer that does not resolve, shows its error in the UI and on the trainer panel row) and browser shortcuts: `Alt+Shift+S` toggles the speedhack, `Alt+Shift+P` pauses or resumes the game and `Alt+Shift+F` suspends or resumes all freezes; an open Cetus Remastered UI updates at once and the Table tab shows a notice with a Resume button while freezes are suspended (change them at `chrome://extensions/shortcuts` in Chrome or about:addons > Manage Extension Shortcuts in Firefox)
- JavaScript value scanning, editing and freezing on page objects
- Scripting: per-site scripts run on the game page with a `cetus` object offering `read(addr, type)`, `write(addr, type, value)`, `call(nameOrIndex, ...args)`, `hookExport(name, {before, after})`, `onTick(fn)`, `onHit(fn)` (every watch, access, global write and breakpoint hit), `hotkey(combo, fn)`, `scan(params)`, `pointer(base, offsets)`, `patch(addr, type, value)`, `freeze(addr, type, value, mode)`, `freezeGlobal(name, value, mode)`, `watch(addr, size, kind)`, `memory()` and `log(...args)`; disabling or removing a script runs its returned function, then undoes its freezes, global freezes, watches, export hooks, ticks, hit callbacks, hotkeys and patches (restoring any freeze or watch it replaced), and later `cetus` calls from it throw; a callback or export hook that throws is reported once per second at most and removed, so the game keeps running the original export
- Trainer export as a userscript that bundles the site's patches, table, global freezes, hotkeys, scripts, custom types and instrumentation options; on the game page it shows a draggable, collapsible trainer panel listing every table entry (live value, freeze toggle, value input) and script (on/off toggle) with their hotkeys, shown or hidden with `Ctrl+Shift+T`
- JSON import and export of cheat tables, global freezes, patches, hotkeys, scripts, custom types, annotations and instrumentation options (importing scripts, custom types or patch callbacks asks first)

The name Cetus comes from the Latin word for "sea monster"

## Examples

[Read the Tutorial](https://github.com/Qwokka/Cetus/wiki/Cetus-101---Invincibility)

[Check out some CTF Writeups](https://github.com/Qwokka/Cetus/wiki/CTF-Writeups)

[Or watch this video](https://www.youtube.com/watch?v=V8UkCsPzbhQ)

## Installation

Cetus Remastered is installed as a developer extension.

Clone this repository, or download it as a zip file and unpack it.

### Chrome

- Requires Chrome 121 or later
- Open `chrome://extensions` and enable Developer mode
- Click *Load unpacked* and select the repository folder

### Firefox

- Requires Firefox 128 or later
- Open `about:debugging`, then *This Firefox*
- Click *Load Temporary Add-on* and select `manifest.json`
- Grant site access if prompted
- Use *Open in tab* (Table tab) from the popup to import files, since the popup closes when the file picker opens

## Development

```sh
npm install
npx playwright install chromium
npm test
npm run e2e
```

## Credits

Original Cetus by [Jack Baker](https://github.com/Qwokka): https://github.com/Qwokka/Cetus

[Jack Baker](https://github.com/Qwokka): Development

[Tigran Tumasov](https://github.com/Shugar): UI, UX, CSS, front end design

[Bradlee Keith Setliff](http://bradsetliff.com/): WAIL and Cetus logo designs

[wasm-cheat-engine](https://github.com/vakzz/wasm-cheat-engine): Inspiration, a little bit of derivative code

### Major Contributors

@nailgg (Real-Time Memory Viewer)

## License

Cetus Remastered is licensed under [Apache License 2.0](/LICENSE)

[WAIL](https://github.com/Qwokka/wail) is licensed under the [Apache License 2.0](shared/wail.min.js/LICENSE)

[prism.js](https://prismjs.com/) is licensed under the [MIT License](extension/thirdparty/prism/LICENSE)

[bliss.js](https://blissfuljs.com/) is licensed under the [MIT License](extension/thirdparty/bliss/LICENSE)

[wasm-cheat-engine](https://github.com/vakzz/wasm-cheat-engine) is licensed under the [MIT License](https://github.com/vakzz/wasm-cheat-engine/blob/master/LICENSE.txt)
