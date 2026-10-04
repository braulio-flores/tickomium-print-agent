import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog } from "electron";
import * as path from "path";
import { startServer, stopServer, setPrinter, PRINT_AGENT_PORT } from "./server";

// electron-store is ESM-only in v8+, use dynamic import
let store: any;

let tray: Tray | null = null;
let configWindow: BrowserWindow | null = null;

async function initStore() {
  const Store = (await import("electron-store")).default;
  store = new Store({
    defaults: {
      printer: "",
      openAtLogin: true,
    },
  });
  // Versiones anteriores dejaban elegir el puerto; Tickomium siempre busca la
  // app en PRINT_AGENT_PORT, así que se descarta cualquier puerto guardado.
  store.delete("port");
}

// Arrancar con la sesión del sistema: si la app no está abierta, el navegador
// no puede imprimir y el ticket no sale. Solo en la app instalada; en
// desarrollo registraría el binario de Electron.
function applyOpenAtLogin(enabled: boolean) {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: enabled });
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
    {
      label: "Abrir al encender la computadora",
      type: "checkbox",
      checked: store?.get("openAtLogin") !== false,
      click: (item) => {
        store?.set("openAtLogin", item.checked);
        applyOpenAtLogin(item.checked);
      },
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
      version: app.getVersion(),
    };
  });

  ipcMain.handle("save-config", async (_event, config: { printer: string }) => {
    store?.set("printer", config.printer);
    setPrinter(config.printer);
    updateTrayMenu();
    return { success: true };
  });

  ipcMain.handle("get-printers", async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PRINT_AGENT_PORT}/printers`);
      const data = (await res.json()) as { printers?: string[] };
      return data.printers || [];
    } catch {
      return [];
    }
  });

  ipcMain.handle("get-health", async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${PRINT_AGENT_PORT}/health`);
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
      const res = await fetch(`http://127.0.0.1:${PRINT_AGENT_PORT}/print`, {
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

// Una sola instancia: con el arranque automático es fácil que el usuario la
// abra otra vez sin saber que ya corre; la segunda chocaría por el puerto.
// En lugar de eso se muestra la ventana de la que ya está abierta.
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) {
  app.quit();
}

app.on("second-instance", () => {
  showConfigWindow();
});

// App lifecycle
app.on("ready", async () => {
  if (!isPrimaryInstance) return;
  await initStore();
  setupIPC();
  applyOpenAtLogin(store.get("openAtLogin") !== false);

  const printer = store.get("printer") || "";

  try {
    await startServer(printer);
  } catch (err: any) {
    // Con instancia única, quien ocupa el puerto es otro programa (o una
    // versión vieja de esta app que sigue abierta).
    dialog.showErrorBox(
      "Tickomium Print Agent",
      err?.code === "EADDRINUSE"
        ? `No se pudo iniciar porque otro programa está usando el puerto ${PRINT_AGENT_PORT}.\n\n` +
            "Cierra cualquier otra copia de Tickomium Print Agent o reinicia la computadora y vuelve a abrir la app."
        : `No se pudo iniciar la app de impresión.\n\n${err?.message ?? ""}`
    );
    app.quit();
    return;
  }
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
