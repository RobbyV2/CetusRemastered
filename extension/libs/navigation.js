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

const TABS = ["Search", "Strings", "Table", "MemView", "Struct", "Pointer", "Patch", "Exports", "Scripts", "Js", "Globals", "SpeedHack"];

const changeTab = name => {
    for (const t of TABS) {
        document.getElementById(`tab${t}`).hidden = t !== name;
        document.getElementById(`tab${t}Button`).parentElement.classList.toggle("is-active", t === name);
    }
};

for (const t of TABS) document.getElementById(`tab${t}Button`).onclick = e => {
    e.preventDefault();
    changeTab(t);
};
