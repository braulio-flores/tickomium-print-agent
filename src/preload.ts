import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  saveConfig: (config: { printer: string }) =>
    ipcRenderer.invoke("save-config", config),
  getPrinters: () => ipcRenderer.invoke("get-printers"),
  getHealth: () => ipcRenderer.invoke("get-health"),
  testPrint: () => ipcRenderer.invoke("test-print"),
  getUpdateState: () => ipcRenderer.invoke("get-update-state"),
  startUpdate: () => ipcRenderer.invoke("start-update"),
  checkUpdates: () => ipcRenderer.invoke("check-updates"),
  onUpdateState: (callback: (state: unknown) => void) => {
    ipcRenderer.on("update-state", (_event, state) => callback(state));
  },
});
