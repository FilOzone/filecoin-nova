import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { success, working, c, gutterTop, gutterBottom, gutterLine } from "./ui.js";

const execFileAsync = promisify(execFile);

export interface PinConfig {
  directory: string;
  providerId?: number;
  mainnet?: boolean;
}

export interface PinResult {
  cid: string;
  directory: string;
}

/**
 * Parse filecoin-pin errors into user-friendly messages.
 */
function friendlyPinError(output: string, context: string): string {
  const msg = output.toLowerCase();

  if (msg.includes("insufficient") || msg.includes("usdfc") || msg.includes("balance")) {
    return (
      `${context}: Insufficient USDFC balance.\n\n` +
      "  Your Filecoin wallet needs USDFC to deploy to Filecoin Onchain Cloud.\n" +
      "  Get USDFC at: https://app.filecoin.io/bridge\n"
    );
  }

  if (msg.includes("authentication") || msg.includes("privatekey") || msg.includes("private key")) {
    return (
      `${context}: Invalid wallet key.\n\n` +
      "  The Filecoin wallet private key appears to be incorrect.\n"
    );
  }

  if (msg.includes("allowance") || msg.includes("approval")) {
    return (
      `${context}: Payment approval failed.\n\n` +
      "  The wallet may not have enough USDFC, or payments may not\n" +
      "  be set up yet. Try running:\n" +
      "    filecoin-pin payments setup --auto --mainnet\n" +
      "  Or wait a few minutes if a previous approval is pending.\n"
    );
  }

  if (msg.includes("econnrefused") || msg.includes("network") || msg.includes("timeout")) {
    return (
      `${context}: Network error.\n\n` +
      "  Could not reach the Filecoin network. Check your internet\n" +
      "  connection and try again."
    );
  }

  if (msg.includes("no such file") || msg.includes("enoent")) {
    return (
      `${context}: Directory not found.\n\n` +
      "  The directory you specified does not exist.\n" +
      "  Check the path and try again."
    );
  }

  // Fallback: include the original error
  return `${context}: ${output.trim()}`;
}

/**
 * Run a command with live output streaming in a gutter.
 * Forces colour output and returns combined stdout for parsing.
 */
const SUBPROCESS_TIMEOUT_MS = 300_000; // 5 minutes

function runStreaming(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  title?: string
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve, reject) => {
    const runEnv = { ...(env || process.env), FORCE_COLOR: "1" };
    const child = spawn(cmd, args, {
      env: runEnv,
      stdio: ["inherit", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    let started = false;
    let done = false;
    let gutterClosed = false;

    function closeGutter() {
      if (started && !gutterClosed) {
        gutterClosed = true;
        gutterBottom();
      }
    }

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill();
        if (lineBuffer.trim()) {
          flushLine(lineBuffer);
          lineBuffer = "";
        }
        closeGutter();
        reject(new Error(
          `Command timed out after ${SUBPROCESS_TIMEOUT_MS / 1000}s.\n` +
            "  The upload may still be in progress on the network."
        ));
      }
    }, SUBPROCESS_TIMEOUT_MS);

    function finish() {
      done = true;
      clearTimeout(timer);
    }

    function flushLine(line: string) {
      if (!started) {
        gutterTop(title);
        started = true;
      }
      gutterLine(line);
    }

    child.stdout.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      lineBuffer += text;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop()!;
      for (const line of lines) {
        flushLine(line);
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      lineBuffer += text;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop()!;
      for (const line of lines) {
        flushLine(line);
      }
    });

    child.on("close", (code) => {
      finish();
      if (lineBuffer.trim()) {
        flushLine(lineBuffer);
      }
      closeGutter();
      if (code !== 0) {
        reject(new Error(stderr || stdout || `Exit code ${code}`));
      } else {
        resolve({ stdout, code: code ?? 0 });
      }
    });

    child.on("error", (err) => {
      finish();
      closeGutter();
      reject(err);
    });
  });
}

/**
 * Install filecoin-pin globally if not already installed.
 */
export async function installFilecoinPin(): Promise<void> {
  const installed = await isFilecoinPinInstalled();
  if (installed) {
    success(`filecoin-pin ${installed}`);
    return;
  }

  working("Installing filecoin-pin...");
  try {
    await execFileAsync("npm", ["install", "-g", "filecoin-pin"]);
    success("filecoin-pin installed");
  } catch (err: any) {
    throw new Error(
      "Failed to install filecoin-pin.\n\n" +
        "  Try installing manually:\n" +
        "    npm install -g filecoin-pin\n" +
        "    # or with sudo if permission denied:\n" +
        "    sudo npm install -g filecoin-pin\n" +
        (err.stderr ? `\n  Detail: ${err.stderr.trim()}` : "")
    );
  }
}

/**
 * Set up filecoin-pin payments (wallet authentication).
 * Streams output live with colours.
 */
export async function setupFilecoinPinPayments(
  mainnet: boolean
): Promise<void> {
  const args = ["payments", "setup", "--auto"];
  if (mainnet) {
    args.push("--mainnet");
  }

  const env = { ...process.env };
  if (env.NOVA_PIN_KEY) {
    env.PRIVATE_KEY = env.NOVA_PIN_KEY;
  }
  if (!env.PRIVATE_KEY) {
    throw new Error(
      "No Filecoin wallet key configured.\n\n" +
        "  Set NOVA_PIN_KEY env var with your Filecoin wallet private key."
    );
  }

  try {
    await runStreaming("filecoin-pin", args, env, "filecoin-pin payments setup");
    console.log("");
    success("Payments configured");
  } catch (err: any) {
    const output = err.message || "";
    throw new Error(friendlyPinError(output, "Payment setup failed"));
  }
}

/**
 * Check if filecoin-pin is installed and return the version.
 */
export async function isFilecoinPinInstalled(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("filecoin-pin", ["--version"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

const MIN_FP_VERSION = "0.17.0";

/**
 * Compare semver strings. Returns -1, 0, or 1.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Ensure filecoin-pin is installed and meets minimum version.
 */
export async function ensureFilecoinPin(): Promise<string> {
  const version = await isFilecoinPinInstalled();
  if (!version) {
    throw new Error(
      "filecoin-pin is not installed.\n\n" +
        "  Run 'nova deploy' and it will be installed automatically."
    );
  }

  // Extract semver from version string (e.g. "filecoin-pin 0.17.0" or "0.17.0")
  const semver = version.match(/(\d+\.\d+\.\d+)/)?.[1];
  if (semver && compareSemver(semver, MIN_FP_VERSION) < 0) {
    throw new Error(
      `filecoin-pin ${semver} is too old (need ${MIN_FP_VERSION}+).\n\n` +
        "  Older versions use incompatible contracts.\n" +
        "  Update with: npm install -g filecoin-pin"
    );
  }

  return version;
}

/**
 * Strip ANSI escape sequences from a string.
 * FORCE_COLOR=1 causes subprocess output to contain color codes
 * that would break CID regex matching (ANSI codes end with 'm',
 * a word character, preventing \b from matching).
 */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Extract the CID from filecoin-pin output.
 * Looks for CID patterns (bafyb..., bafy..., Qm...).
 */
function extractCid(output: string): string | null {
  const clean = stripAnsi(output);
  // Match CIDv1 (bafyb..., bafk...) or CIDv0 (Qm...)
  const cidMatch = clean.match(/\b(baf[a-z2-7]{50,}|Qm[a-zA-Z0-9]{44,})\b/);
  return cidMatch ? cidMatch[1] : null;
}

/**
 * Pin a directory to Filecoin Onchain Cloud using filecoin-pin CLI.
 * Streams output live so user sees progress and colours.
 */
export async function pinToFoc(config: PinConfig): Promise<PinResult> {
  const args = ["add", config.directory];

  if (config.mainnet !== false) {
    args.push("--mainnet");
  }

  if (config.providerId !== undefined) {
    args.push("--provider-id", String(config.providerId));
  }

  const env = { ...process.env };
  if (env.NOVA_PIN_KEY) {
    env.PRIVATE_KEY = env.NOVA_PIN_KEY;
  }
  if (!env.PRIVATE_KEY) {
    throw new Error(
      "No Filecoin wallet key configured.\n\n" +
        "  Set NOVA_PIN_KEY env var with your Filecoin wallet private key."
    );
  }

  try {
    const { stdout } = await runStreaming("filecoin-pin", args, env, "filecoin-pin add");

    const cid = extractCid(stdout);
    if (!cid) {
      throw new Error(
        "Upload appeared to succeed but no CID was found in the output.\n" +
          "  Check the output above for details."
      );
    }

    console.log("");
    success(`Deployed: ${c.bold}${cid}${c.reset}`);
    return { cid, directory: config.directory };
  } catch (err: any) {
    const output = err.message || "";
    throw new Error(friendlyPinError(output, "Deploy failed"));
  }
}
