import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } from "electron";
import * as path from "path";
import { startServer, stopServer, setPrinter, setPort } from "./server";

// electron-store is ESM-only in v8+, use dynamic import
let store: any;

let tray: Tray | null = null;
let configWindow: BrowserWindow | null = null;

async function initStore() {
  const Store = (await import("electron-store")).default;
  store = new Store({
    defaults: {
      printer: "",
      port: 6441,
    },
  });
}

function createTray() {
  const iconPath = path.join(__dirname, "..", "assets", "iconTemplate.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Tickomium Print Agent");

  updateTrayMenu();

  tray.on("click", () => {
    showConfigWindow();
  });
}

function updateTrayMenu() {
  const printer = store?.get("printer") || "(sin configurar)";
  const contextMenu = Menu.buildFromTemplate([
    { label: "Tickomium Print Agent", enabled: false },
    { type: "separator" },
    { label: `Impresora: ${printer}`, enabled: false },
    { type: "separator" },
    {
      label: "Configurar",
      click: () => showConfigWindow(),
    },
    { type: "separator" },
    {
      label: "Salir",
      click: () => {
        stopServer().then(() => app.quit());
      },
    },
  ]);
  tray?.setContextMenu(contextMenu);
}

function showConfigWindow() {
  if (configWindow) {
    configWindow.show();
    configWindow.focus();
    return;
  }

  configWindow = new BrowserWindow({
    width: 420,
    height: 460,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Tickomium Print Agent",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  configWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  configWindow.setMenuBarVisibility(false);

  configWindow.on("close", (e) => {
    e.preventDefault();
    configWindow?.hide();
  });

  configWindow.on("closed", () => {
    configWindow = null;
  });
}

// IPC handlers
function setupIPC() {
  ipcMain.handle("get-config", () => {
    return {
      printer: store?.get("printer") || "",
      port: store?.get("port") || 6441,
    };
  });

  ipcMain.handle("save-config", async (_event, config: { printer: string; port: number }) => {
    store?.set("printer", config.printer);
    store?.set("port", config.port);
    setPrinter(config.printer);
    setPort(config.port);
    updateTrayMenu();
    return { success: true };
  });

  ipcMain.handle("get-printers", async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${store?.get("port") || 6441}/printers`);
      const data = (await res.json()) as { printers?: string[] };
      return data.printers || [];
    } catch {
      return [];
    }
  });

  ipcMain.handle("get-health", async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${store?.get("port") || 6441}/health`);
      return await res.json();
    } catch {
      return { status: "error", printer: null, printerStatus: "not_found" };
    }
  });

  ipcMain.handle("test-print", async () => {
    try {
      // Send a simple test text as raw bytes
      const testText = "\n\n    *** Tickomium Print Agent ***\n    Prueba de impresion exitosa!\n\n\n\n";
      const buffer = Buffer.from(testText, "utf-8");
      const res = await fetch(`http://127.0.0.1:${store?.get("port") || 6441}/print`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: buffer,
      });
      return await res.json();
    } catch (err: any) {
      return { success: false, message: err.message };
    }
  });
}

// App lifecycle
app.on("ready", async () => {
  await initStore();
  setupIPC();

  const port = store.get("port") || 6441;
  const printer = store.get("printer") || "";

  await startServer(port, printer);
  createTray();

  // Don't show window on startup — tray only
  app.dock?.hide?.(); // macOS: hide dock icon
});

app.on("window-all-closed", () => {
  // Don't quit when window is closed
});

app.on("before-quit", () => {
  configWindow?.removeAllListeners("close");
  configWindow?.close();
});
