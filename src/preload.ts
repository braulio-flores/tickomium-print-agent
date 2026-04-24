import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  saveConfig: (config: { printer: string; port: number }) =>
    ipcRenderer.invoke("save-config", config),
  getPrinters: () => ipcRenderer.invoke("get-printers"),
  getHealth: () => ipcRenderer.invoke("get-health"),
  testPrint: () => ipcRenderer.invoke("test-print"),
});
