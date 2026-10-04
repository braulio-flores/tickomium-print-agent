import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, MenuItemConstructorOptions } from "electron";
import * as path from "path";
import { startServer, stopServer, setPrinter, setVersionInfo, PRINT_AGENT_PORT } from "./server";
import {
  checkForUpdate,
  downloadAndInstall,
  getUpdateState,
  latestKnownVersion,
  onUpdateState,
} from "./updater";

// Se revisa al arrancar (con margen para no competir con el inicio de la
// computadora) y luego cada 6 horas. Nunca se instala solo.
const FIRST_UPDATE_CHECK_MS = 30_000;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

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

function updateMenuItem(): MenuItemConstructorOptions {
  const update = getUpdateState();
  switch (update.status) {
    case "available":
      return { label: `Actualizar a la versión ${update.update.version}…`, click: () => confirmAndUpdate() };
    case "downloading":
      return { label: `Descargando actualización… ${update.progress}%`, enabled: false };
    case "installing":
      return { label: "Instalando actualización…", enabled: false };
    case "checking":
      return { label: "Buscando actualizaciones…", enabled: false };
    default:
      return { label: "Buscar actualizaciones", click: () => manualUpdateCheck() };
  }
}

function updateTrayMenu() {
  const printer = store?.get("printer") || "(sin configurar)";
  const contextMenu = Menu.buildFromTemplate([
    { label: `Tickomium Print Agent v${app.getVersion()}`, enabled: false },
    { type: "separator" },
    { label: `Impresora: ${printer}`, enabled: false },
    { type: "separator" },
    {
      label: "Configurar",
      click: () => showConfigWindow(),
    },
    updateMenuItem(),
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
    height: 540,
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

// ───────────────────────────── actualizaciones ─────────────────────────────

let updateInProgress = false;

async function confirmAndUpdate() {
  const update = getUpdateState();
  if (update.status !== "available" || updateInProgress) return;
  const { version } = update.update;

  const { response } = await dialog.showMessageBox({
    type: "question",
    title: "Actualizar la app de impresión",
    message: `¿Instalar la versión ${version}?`,
    detail:
      "La app se cerrará y se volverá a abrir sola en unos segundos. Mientras tanto no saldrán tickets.\n\n" +
      "Tu impresora elegida se conserva. Si algo falla, se queda la versión que tienes ahora.",
    buttons: ["Actualizar ahora", "Más tarde"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;

  updateInProgress = true;
  try {
    const outcome = await downloadAndInstall(update.update);
    if (outcome === "restarting") {
      app.quit();
      return;
    }
    await dialog.showMessageBox({
      type: "info",
      title: "Actualizar la app de impresión",
      message: "Termina la actualización a mano",
      detail:
        "Se abrió el instalador de la versión nueva. Cierra esta app (ícono junto al reloj → Salir), " +
        "arrastra la app nueva a Aplicaciones y elige «Reemplazar». Si al abrirla sale un aviso de Apple, " +
        "permítela en Configuración del Sistema → Privacidad y seguridad → «Abrir igualmente».\n\n" +
        "Tu impresora elegida se conserva.",
    });
  } catch (err: any) {
    console.error("No se pudo actualizar:", err);
    dialog.showErrorBox(
      "No se pudo actualizar",
      "La app de impresión sigue funcionando con la versión que tienes. Revisa tu conexión a internet e intenta más tarde."
    );
  } finally {
    updateInProgress = false;
  }
}

async function manualUpdateCheck() {
  const result = await checkForUpdate();
  if (result.status === "available") {
    await confirmAndUpdate();
  } else if (result.status === "up_to_date") {
    await dialog.showMessageBox({
      type: "info",
      title: "Tickomium Print Agent",
      message: "Ya tienes la versión más reciente",
      detail: `Versión ${app.getVersion()}`,
    });
  } else if (result.status === "error") {
    dialog.showErrorBox(
      "No se pudo revisar",
      "No se pudo revisar si hay una versión nueva. Revisa tu conexión a internet e intenta más tarde."
    );
  }
}

function setupUpdates() {
  onUpdateState((update) => {
    setVersionInfo({ latestVersion: latestKnownVersion() });
    updateTrayMenu();
    configWindow?.webContents.send("update-state", update);
  });
  setTimeout(() => checkForUpdate(), FIRST_UPDATE_CHECK_MS);
  setInterval(() => checkForUpdate(), UPDATE_CHECK_INTERVAL_MS);
}

// IPC handlers
function setupIPC() {
  ipcMain.handle("get-update-state", () => getUpdateState());
  ipcMain.handle("start-update", () => confirmAndUpdate());
  ipcMain.handle("check-updates", () => manualUpdateCheck());

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
  setVersionInfo({ version: app.getVersion() });

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
  setupUpdates();

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
