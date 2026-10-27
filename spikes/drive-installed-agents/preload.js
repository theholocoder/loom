const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("spike", { onLog: (cb) => ipcRenderer.on("log", (_e, msg) => cb(msg)) });
