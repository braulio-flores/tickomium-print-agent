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

let currentPort = 6441;
let currentPrinter = "";
let server: Server | null = null;

const app = express();

app.use(
  cors({
    origin: (_origin, cb) => cb(null, true),
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
      return stdout.toLowerCase().includes("disabled") ? "disabled" : "enabled";
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
  res.json({ status: "ok", printer: currentPrinter || null, printerStatus, port: currentPort });
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

export function setPort(port: number) {
  currentPort = port;
}

export function startServer(port?: number, printer?: string): Promise<Server> {
  if (port) currentPort = port;
  if (printer) currentPrinter = printer;

  return new Promise((resolve) => {
    server = app.listen(currentPort, "127.0.0.1", () => {
      console.log(`Print Agent corriendo en http://127.0.0.1:${currentPort}`);
      console.log(`Impresora: ${currentPrinter || "(no configurada)"}`);
      resolve(server!);
    });
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
  const port = parseInt(process.env.PRINT_AGENT_PORT || "6441", 10);
  const printer = process.env.PRINTER_NAME || "";
  startServer(port, printer);
}
