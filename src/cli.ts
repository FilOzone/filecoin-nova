#!/usr/bin/env node

import { existsSync, statSync, readdirSync, lstatSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { deploy } from "./deploy.js";
import { getEnsContenthash, updateEnsContenthash } from "./ens.js";
import {
  installFilecoinPin,
  setupFilecoinPinPayments,
  isFilecoinPinInstalled,
} from "./pin.js";
import { isArchive, extractArchive, cleanupExtracted } from "./archive.js";
import { resolveConfig } from "./config.js";
import { ask, close } from "./prompt.js";
import { c, fail, info, label, promptLabel, banner, success } from "./ui.js";

// Sentinel error for early exits — skips the error print in main().catch()
class ExitError extends Error {
  constructor(public exitCode: number) {
    super("");
  }
}

// Mute/unmute console for --json mode
let isJsonMode = false;
const originalLog = console.log;
const originalError = console.error;
function muteConsole() {
  isJsonMode = true;
  console.log = () => {};
  console.error = () => {};
}
function unmuteConsole() {
  console.log = originalLog;
  console.error = originalError;
}

function earlyExit(code: number): never {
  throw new ExitError(code);
}

const HELP = `
  ${c.cyan}${c.bold}Nova${c.reset} ${c.dim}— Deploy static websites to Filecoin Onchain Cloud${c.reset}

  ${c.bold}Usage${c.reset}

    ${c.cyan}nova deploy${c.reset} [path] [options]        Deploy a directory or archive
    ${c.cyan}nova ens${c.reset} <cid> --ens <name>         Point ENS domain to an IPFS CID
    ${c.cyan}nova status${c.reset} [--ens <name>]          Check ENS contenthash
    ${c.cyan}nova help${c.reset}                           Show this help
    ${c.cyan}nova --version${c.reset}                      Show version

  ${c.bold}Environment Variables${c.reset}

    ${c.cyan}NOVA_PIN_KEY${c.reset}         Filecoin wallet key (for deploying to FOC)
    ${c.cyan}NOVA_ENS_KEY${c.reset}         Ethereum wallet key (for ENS updates)
    ${c.cyan}NOVA_ENS_NAME${c.reset}        ENS domain (e.g. desite.ezpdpz.eth)
    ${c.cyan}NOVA_RPC_URL${c.reset}         Ethereum RPC URL (override default RPCs)
    ${c.cyan}NOVA_PROVIDER_ID${c.reset}     Storage provider ID

  ${c.bold}Options${c.reset}

    ${c.dim}--ens <name>${c.reset}          ENS domain (e.g. desite.ezpdpz.eth)
    ${c.dim}--rpc-url <url>${c.reset}       Ethereum RPC URL
    ${c.dim}--provider-id <id>${c.reset}    Storage provider ID
    ${c.dim}--calibration${c.reset}         Use calibration testnet (default: mainnet)
    ${c.dim}--json${c.reset}                Output result as JSON (for CI/scripts)

  ${c.bold}Supported Formats${c.reset}

    Directories, ${c.dim}.zip${c.reset}, ${c.dim}.tar.gz${c.reset}, ${c.dim}.tgz${c.reset}, ${c.dim}.tar${c.reset}

  ${c.bold}Examples${c.reset}

    ${c.dim}$${c.reset} nova deploy ./public --ens desite.ezpdpz.eth
    ${c.dim}$${c.reset} nova deploy site.zip
    ${c.dim}$${c.reset} nova deploy ./dist --json
    ${c.dim}$${c.reset} nova ens bafybei... --ens mysite.eth
    ${c.dim}$${c.reset} nova status --ens mysite.eth --json
`;

function dirSize(dir: string, seen = new Set<number>()): number {
  let total = 0;
  try {
    // Track inodes to avoid circular symlinks
    const dirStat = lstatSync(dir);
    if (seen.has(dirStat.ino)) return 0;
    seen.add(dirStat.ino);

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          total += dirSize(path, seen);
        } else {
          total += statSync(path).size;
        }
      } catch {
        // Skip files we can't stat (permission denied, etc.)
      }
    }
  } catch {
    // Skip directories we can't read
  }
  return total;
}

function humanSize(bytes: number): { size: string; unit: string } {
  if (bytes < 1024) return { size: String(bytes), unit: "B" };
  if (bytes < 1024 ** 2) return { size: (bytes / 1024).toFixed(1), unit: "KiB" };
  if (bytes < 1024 ** 3) return { size: (bytes / 1024 ** 2).toFixed(1), unit: "MiB" };
  return { size: (bytes / 1024 ** 3).toFixed(2), unit: "GiB" };
}

async function runDeploy(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    earlyExit(0);
  }

  const { values, positionals: pos } = parseArgs({
    args: args.slice(1),
    options: {
      ens: { type: "string" },
      "rpc-url": { type: "string" },
      "provider-id": { type: "string" },
      calibration: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const jsonMode = values.json!;
  if (jsonMode) muteConsole();

  banner();

  const config = resolveConfig(process.env);

  let directory: string | undefined = pos[0];
  let ensName = values.ens || config.ensName;

  // 1. Check filecoin-pin
  const fpVersion = await isFilecoinPinInstalled();
  if (!fpVersion) {
    info("Installing filecoin-pin (first time only)...");
    await installFilecoinPin();
  }

  // 2. Filecoin wallet key
  if (!config.pinKey) {
    if (!process.stdin.isTTY) {
      fail("NOVA_PIN_KEY env var is required.");
      info("Set it to your Filecoin wallet private key (needs USDFC).");
      earlyExit(1);
    }
    console.log("");
    info("NOVA_PIN_KEY not set — your Filecoin wallet key for");
    info("deploying to Filecoin Onchain Cloud (needs USDFC).");
    console.log("");
    const key = await ask(promptLabel("Filecoin wallet private key:"));
    if (!key) {
      fail("Cannot deploy without a Filecoin wallet key.");
      info("Set NOVA_PIN_KEY env var and try again.");
      earlyExit(1);
    }
    process.env.NOVA_PIN_KEY = key;
    config.pinKey = key;

    // Set up payments on first use
    console.log("");
    await setupFilecoinPinPayments(!values.calibration);
  }

  // 3. Directory
  if (!directory) {
    console.log("");
    const defaultDir = existsSync("./public") ? "./public" : ".";
    const input = await ask(promptLabel(`Directory or archive to deploy [${defaultDir}]:`));
    directory = input || defaultDir;
  }

  // 4. ENS name (optional — skip to deploy without ENS)
  if (!ensName) {
    console.log("");
    const input = await ask(promptLabel("ENS domain (leave blank to skip):"));
    ensName = input || undefined;
  }

  // Validate ENS name before asking for ETH key
  if (ensName && !ensName.endsWith(".eth")) {
    fail(`Invalid ENS domain: ${ensName}`);
    info("ENS domains must end with .eth (e.g. mysite.eth)");
    earlyExit(1);
  }

  // 5. Ethereum wallet key (only if ENS is being used)
  if (ensName && !config.ensKey) {
    if (!process.stdin.isTTY) {
      fail("NOVA_ENS_KEY env var is required for ENS updates.");
      info("Set it to your Ethereum wallet private key (needs ETH for gas).");
      earlyExit(1);
    }
    console.log("");
    info("NOVA_ENS_KEY not set — your Ethereum wallet key for");
    info("updating your ENS domain (needs ETH for gas).");
    console.log("");
    const key = await ask(promptLabel("Ethereum wallet private key:"));
    if (!key) {
      fail("Cannot deploy without an Ethereum wallet key.");
      info("Set NOVA_ENS_KEY env var and try again.");
      earlyExit(1);
    }
    process.env.NOVA_ENS_KEY = key;
    config.ensKey = key;
  }

  // Resolve to absolute path (expand ~ to home dir)
  if (directory === "~") {
    directory = homedir();
  } else if (directory.startsWith("~/")) {
    directory = join(homedir(), directory.slice(2));
  }
  directory = resolve(directory);
  if (!existsSync(directory)) {
    fail(`Not found: ${directory}`);
    earlyExit(1);
  }

  // If it's an archive, extract to temp dir
  let extractedDir: string | undefined;
  let deployDir = directory;
  if (isArchive(directory)) {
    info(`Extracting ${basename(directory)}...`);
    extractedDir = await extractArchive(directory);
    deployDir = extractedDir;
  }

  try {
    // Check for empty directory
    const bytes = dirSize(deployDir);
    if (bytes === 0) {
      fail(extractedDir ? `Archive is empty: ${basename(directory)}` : `Directory is empty: ${directory}`);
      earlyExit(1);
    }

    // Pre-deploy summary
    const { size, unit } = humanSize(bytes);
    const TIB = 1024 ** 4;
    const USDFC_PER_TIB = 5;
    const costPerMonth = (bytes / TIB) * USDFC_PER_TIB;
    const costStr = costPerMonth < 0.01 ? "< 0.01" : costPerMonth.toFixed(2);
    const isMainnet = !values.calibration;
    console.log("");
    label(extractedDir ? "File" : "Dir", directory);
    label("Size", `${size} ${unit} — ~${costStr} USDFC/month`);
    if (ensName) label("ENS", ensName);
    label("Net", isMainnet ? "mainnet" : "calibration");

    let parsedProviderId = config.providerId;
    if (values["provider-id"] !== undefined) {
      const n = Number(values["provider-id"]);
      if (isNaN(n)) {
        fail(`Invalid provider ID: ${values["provider-id"]}`);
        earlyExit(1);
      }
      parsedProviderId = n;
    }

    // Confirm before spending money (skip if stdin is not a TTY or --json)
    if (process.stdin.isTTY && !jsonMode) {
      console.log("");
      const confirm = await ask(promptLabel("Deploy? [Y/n]"));
      if (confirm && confirm.toLowerCase() !== "y" && confirm.toLowerCase() !== "yes") {
        info("Deploy cancelled.");
        earlyExit(0);
      }
    }

    close();

    const result = await deploy({
      directory: deployDir,
      ensName,
      ensKey: config.ensKey,
      rpcUrl: values["rpc-url"] || config.rpcUrl,
      providerId: parsedProviderId,
      mainnet: isMainnet,
    });

    if (jsonMode) {
      unmuteConsole();
      console.log(JSON.stringify({
        cid: result.cid,
        directory: result.directory,
        gatewayUrl: `https://${result.cid}.ipfs.dweb.link`,
        ...(result.ensName && { ensName: result.ensName }),
        ...(result.txHash && { txHash: result.txHash }),
        ...(result.ethLimoUrl && { ethLimoUrl: result.ethLimoUrl }),
      }));
    }
  } finally {
    if (extractedDir) {
      await cleanupExtracted(extractedDir);
    }
  }
}

async function runStatus(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    earlyExit(0);
  }

  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      ens: { type: "string" },
      "rpc-url": { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const jsonMode = values.json!;
  if (jsonMode) muteConsole();

  const config = resolveConfig(process.env);
  let ensName = values.ens || config.ensName;

  if (!ensName) {
    const input = await ask(promptLabel("ENS domain to check:"));
    if (!input) {
      fail("ENS domain required.");
      earlyExit(1);
    }
    ensName = input;
  }
  close();

  if (!ensName.endsWith(".eth")) {
    fail(`Invalid ENS domain: ${ensName}`);
    info("ENS domains must end with .eth (e.g. mysite.eth)");
    earlyExit(1);
  }

  const rpcUrl = values["rpc-url"] || config.rpcUrl;
  info(`Checking ${ensName}...`);
  const contenthash = await getEnsContenthash(ensName, rpcUrl);

  if (jsonMode) {
    unmuteConsole();
    console.log(JSON.stringify({
      ensName,
      contenthash: contenthash || null,
      url: contenthash ? `https://${ensName.replace(/\.eth$/, "")}.eth.limo` : null,
    }));
  } else {
    console.log("");
    if (contenthash) {
      label("ENS", ensName);
      label("Hash", contenthash);
      label("URL", `https://${ensName.replace(/\.eth$/, "")}.eth.limo`);
    } else {
      info(`No contenthash set for ${ensName}`);
    }
    console.log("");
  }
}

async function runEns(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    earlyExit(0);
  }

  const { values, positionals: pos } = parseArgs({
    args: args.slice(1),
    options: {
      ens: { type: "string" },
      "rpc-url": { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const jsonMode = values.json!;
  if (jsonMode) muteConsole();

  const config = resolveConfig(process.env);

  // CID is required as positional argument
  let cid = pos[0];
  if (!cid) {
    if (!process.stdin.isTTY) {
      fail("CID argument required.");
      info("Usage: nova ens <cid> --ens <name>");
      earlyExit(1);
    }
    const input = await ask(promptLabel("IPFS CID to point to:"));
    if (!input) {
      fail("CID required.");
      earlyExit(1);
    }
    cid = input;
  }

  // ENS name
  let ensName = values.ens || config.ensName;
  if (!ensName) {
    if (!process.stdin.isTTY) {
      fail("--ens flag or NOVA_ENS_NAME env var required.");
      earlyExit(1);
    }
    const input = await ask(promptLabel("ENS domain:"));
    if (!input) {
      fail("ENS domain required.");
      earlyExit(1);
    }
    ensName = input;
  }

  if (!ensName.endsWith(".eth")) {
    fail(`Invalid ENS domain: ${ensName}`);
    info("ENS domains must end with .eth (e.g. mysite.eth)");
    earlyExit(1);
  }

  // Ethereum wallet key
  if (!config.ensKey) {
    if (!process.stdin.isTTY) {
      fail("NOVA_ENS_KEY env var is required for ENS updates.");
      info("Set it to your Ethereum wallet private key (needs ETH for gas).");
      earlyExit(1);
    }
    console.log("");
    info("NOVA_ENS_KEY not set — your Ethereum wallet key for");
    info("updating your ENS domain (needs ETH for gas).");
    console.log("");
    const key = await ask(promptLabel("Ethereum wallet private key:"));
    if (!key) {
      fail("Cannot update ENS without an Ethereum wallet key.");
      info("Set NOVA_ENS_KEY env var and try again.");
      earlyExit(1);
    }
    config.ensKey = key;
  }

  close();

  // Summary
  console.log("");
  label("CID", cid);
  label("ENS", ensName);
  console.log("");

  const result = await updateEnsContenthash(
    {
      ensName,
      privateKey: config.ensKey,
      rpcUrl: values["rpc-url"] || config.rpcUrl,
    },
    cid
  );

  if (jsonMode) {
    unmuteConsole();
    console.log(JSON.stringify({
      ensName: result.ensName,
      cid,
      txHash: result.txHash,
      contenthash: result.contenthash,
      ethLimoUrl: result.ethLimoUrl,
    }));
  } else {
    console.log("");
    success("ENS domain updated");
    console.log("");
    label("ENS", result.ensName);
    label("TX", result.txHash);
    label("URL", result.ethLimoUrl);
    console.log("");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    process.exit(0);
  }

  if (command === "--version" || command === "-v") {
    const pkg = await import("../package.json", { with: { type: "json" } });
    console.log(pkg.default.version);
    process.exit(0);
  }

  switch (command) {
    case "deploy":
      await runDeploy(args);
      break;
    case "ens":
      await runEns(args);
      break;
    case "status":
      await runStatus(args);
      break;
    default:
      fail(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  close();
  if (err instanceof ExitError) {
    if (isJsonMode) {
      unmuteConsole();
      // ExitError with code 0 is not an error (e.g. cancelled deploy)
      if (err.exitCode !== 0) {
        console.log(JSON.stringify({ error: "Operation failed" }));
      }
    }
    process.exit(err.exitCode);
  }
  if (isJsonMode) {
    unmuteConsole();
    console.log(JSON.stringify({ error: err.message }));
  } else {
    console.log("");
    fail(err.message);
    if (err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      console.log(HELP);
    }
    console.log("");
  }
  process.exit(1);
});
