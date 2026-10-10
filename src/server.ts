import express from "express";
import cors from "cors";
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Server } from "http";

const execFileAsync = promisify(execFile);
const isWin = process.platform === "win32";

// Puerto fijo: Tickomium (web) siempre busca la app aquí. No es configurable
// porque cambiarlo en un solo lado deja de imprimir sin explicación.
export const PRINT_AGENT_PORT = 6441;

let currentPort = PRINT_AGENT_PORT;
let currentPrinter = "";
let server: Server | null = null;

// Versión instalada y la última publicada (la llena el actualizador). Tickomium
// las lee de /health para avisar cuando la app está desactualizada.
let versionInfo: { version: string | null; latestVersion: string | null } = {
  version: process.env.npm_package_version ?? null,
  latestVersion: null,
};

export function setVersionInfo(info: Partial<typeof versionInfo>) {
  versionInfo = { ...versionInfo, ...info };
}

// Solo Tickomium puede usar la impresora. Sin esto, cualquier página que abra
// el cajero podría mandar impresiones o leer la lista de impresoras.
// - https://www.tickomium.com (producción; tickomium.com redirige ahí) y
//   https://tickomium.com por si algún día se invierte la redirección
// - localhost / 127.0.0.1 en cualquier puerto, para desarrollo
// Las peticiones sin Origin (la propia app, curl) no vienen de un navegador.
const PRODUCTION_HOSTS = new Set(["www.tickomium.com", "tickomium.com"]);

export function isAllowedOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    if (hostname === "localhost" || hostname === "127.0.0.1") return true;
    return protocol === "https:" && PRODUCTION_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

const app = express();

// Se rechaza en el servidor (no solo vía CORS): CORS solo impide LEER la
// respuesta; una petición simple igual llegaría a imprimir.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !isAllowedOrigin(origin)) {
    res.status(403).json({ success: false, message: "Origen no permitido" });
    return;
  }
  next();
});

app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || isAllowedOrigin(origin)),
    methods: ["GET", "POST"],
  })
);

// Cross-platform: listar impresoras
async function listPrinters(): Promise<string[]> {
  try {
    if (isWin) {
      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile", "-Command",
        "Get-Printer | Select-Object -ExpandProperty Name",
      ]);
      return stdout.trim().split("\n").map((s) => s.trim()).filter(Boolean);
    } else {
      const { stdout } = await execFileAsync("lpstat", ["-a"]);
      return stdout.trim().split("\n").filter(Boolean).map((line) => line.split(" ")[0]);
    }
  } catch {
    return [];
  }
}

// En Mac la impresora sigue "habilitada" aunque el cable esté desconectado
// (el sistema solo guarda el ticket y lo imprime al reconectarla). Para las
// impresoras USB se revisa el puerto directamente: si no hay ninguna impresora
// conectada por USB, no está. Ante cualquier duda (impresora de red, error al
// consultar) se asume conectada: es peor bloquear una impresora que sí sirve.
async function isMacUsbPrinterUnplugged(name: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  try {
    const { stdout: device } = await execFileAsync("lpstat", ["-v", name]);
    if (!/:\s*usb:\/\//i.test(device)) return false;
    // Clase 7 = impresora (la misma que usa el sistema para reconocerlas).
    const { stdout } = await execFileAsync(
      "ioreg",
      ["-r", "-c", "IOUSBHostInterface", "-l", "-w0"],
      { maxBuffer: 10 * 1024 * 1024 }
    );
    return !/"bInterfaceClass"\s*=\s*7\b/.test(stdout);
  } catch {
    return false;
  }
}

// Cross-platform: estado de impresora
async function getPrinterStatus(name: string): Promise<string> {
  if (!name) return "not_configured";
  try {
    if (isWin) {
      const { stdout } = await execFileAsync("powershell", [
        "-NoProfile", "-Command",
        `Get-Printer -Name '${name}' | Select-Object -ExpandProperty PrinterStatus`,
      ]);
      return stdout.trim().toLowerCase() === "normal" ? "enabled" : "disabled";
    } else {
      const { stdout } = await execFileAsync("lpstat", ["-p", name]);
      if (stdout.toLowerCase().includes("disabled")) return "disabled";
      return (await isMacUsbPrinterUnplugged(name)) ? "disconnected" : "enabled";
    }
  } catch {
    return "not_found";
  }
}

// Cross-platform: imprimir raw buffer
async function printRaw(printerName: string, filePath: string): Promise<void> {
  if (isWin) {
    await execFileAsync("powershell", [
      "-NoProfile", "-Command",
      `Copy-Item -Path '${filePath}' -Destination '\\\\localhost\\${printerName}' -Force`,
    ]);
  } else {
    await execFileAsync("lp", ["-d", printerName, "-o", "raw", filePath]);
  }
}

// GET /health
app.get("/health", async (_req, res) => {
  const printerStatus = await getPrinterStatus(currentPrinter);
  res.json({
    status: "ok",
    printer: currentPrinter || null,
    printerStatus,
    port: currentPort,
    version: versionInfo.version,
    latestVersion: versionInfo.latestVersion,
  });
});

// GET /printers
app.get("/printers", async (_req, res) => {
  const printers = await listPrinters();
  res.json({ printers });
});

// GET /config — obtener configuración actual
app.get("/config", (_req, res) => {
  res.json({ printer: currentPrinter, port: currentPort });
});

// POST /print — recibe buffer ESC/POS crudo y lo envía a la impresora
app.post(
  "/print",
  express.raw({ type: "application/octet-stream", limit: "10mb" }),
  async (req, res) => {
    if (!currentPrinter) {
      res.status(500).json({ success: false, message: "Impresora no configurada" });
      return;
    }

    const buffer = req.body as Buffer;
    if (!buffer || !buffer.length) {
      res.status(400).json({ success: false, message: "Buffer vacío" });
      return;
    }

    // Sin esto el ticket se queda en la cola del sistema y sale solo, horas
    // después, cuando alguien reconecta la impresora.
    if (await isMacUsbPrinterUnplugged(currentPrinter)) {
      res.status(503).json({ success: false, message: "La impresora no está conectada" });
      return;
    }

    const tmpFile = join(tmpdir(), `print-agent-${Date.now()}.bin`);
    try {
      await writeFile(tmpFile, buffer);
      await printRaw(currentPrinter, tmpFile);
      res.json({ success: true, message: "Impreso correctamente" });
    } catch (error: any) {
      console.error("Error al imprimir:", error.message);
      res.status(500).json({ success: false, message: error.message });
    } finally {
      unlink(tmpFile).catch(() => {});
    }
  }
);

export function setPrinter(name: string) {
  currentPrinter = name;
}

// `port` solo se cambia al correr el servidor suelto en desarrollo; la app
// instalada siempre usa PRINT_AGENT_PORT. Si el puerto está ocupado rechaza
// con el error de Node (code EADDRINUSE) para que la app lo explique.
export function startServer(printer?: string, port: number = PRINT_AGENT_PORT): Promise<Server> {
  currentPort = port;
  if (printer) currentPrinter = printer;

  return new Promise((resolve, reject) => {
    const s = app.listen(currentPort, "127.0.0.1", () => {
      server = s;
      console.log(`Print Agent corriendo en http://127.0.0.1:${currentPort}`);
      console.log(`Impresora: ${currentPrinter || "(no configurada)"}`);
      resolve(s);
    });
    s.once("error", reject);
  });
}

export function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
}

// Si se ejecuta directamente (sin Electron), arranca el servidor
if (require.main === module) {
  const port = parseInt(process.env.PRINT_AGENT_PORT || String(PRINT_AGENT_PORT), 10);
  const printer = process.env.PRINTER_NAME || "";
  startServer(printer, port).catch((err) => {
    console.error("No se pudo iniciar el servidor:", err.message);
    process.exit(1);
  });
}
