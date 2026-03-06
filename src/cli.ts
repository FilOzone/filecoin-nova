#!/usr/bin/env node

import { existsSync, statSync, readdirSync, lstatSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { deploy } from "./deploy.js";
import { getEnsContenthash, updateEnsContenthash } from "./ens.js";
import { setupFilecoinPinPayments } from "./pin.js";
import { resolveConfig, readCredentials, writeCredentials, credentialsPath } from "./config.js";
import { listPieces, cleanPieces, type PieceInfo } from "./manage.js";
import { ask, close } from "./prompt.js";
import { c, fail, info, label, labelDim, promptLabel, banner, success } from "./ui.js";

// BigInt-safe JSON serializer (converts bigint to number for output)
function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    typeof val === "bigint" ? Number(val) : val, 2);
}

// Sentinel error for early exits — skips the error print in main().catch()
class ExitError extends Error {
  constructor(public exitCode: number, message?: string) {
    super(message || "");
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

function earlyExit(code: number, message?: string): never {
  throw new ExitError(code, message);
}

const HELP = `
  ${c.cyan}${c.bold}Nova${c.reset} ${c.dim}- Deploy static websites to Filecoin Onchain Cloud${c.reset}

  ${c.bold}Usage${c.reset}

    ${c.cyan}nova deploy${c.reset} [path] [options]        Deploy a directory or archive
    ${c.cyan}nova ens${c.reset} <cid> --ens <name>         Point ENS domain to an IPFS CID
    ${c.cyan}nova status${c.reset} [--ens <name>]          Check ENS contenthash
    ${c.cyan}nova manage${c.reset} [clean]                 Manage pinned pieces and storage costs
    ${c.cyan}nova config${c.reset}                         Set up wallet keys and defaults
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
    ${c.dim}--clean${c.reset}               After deploying, remove ALL other pieces (only the new deploy is kept)
    ${c.dim}--calibration${c.reset}         Use calibration testnet (default: mainnet)
    ${c.dim}--json${c.reset}                Output result as JSON (for CI/scripts)

  ${c.bold}Supported Formats${c.reset}

    Directories, ${c.dim}.zip${c.reset}, ${c.dim}.tar.gz${c.reset}, ${c.dim}.tgz${c.reset}, ${c.dim}.tar${c.reset}

  ${c.bold}Examples${c.reset}

    ${c.dim}$${c.reset} nova deploy ./public --ens desite.ezpdpz.eth
    ${c.dim}$${c.reset} nova deploy site.zip
    ${c.dim}$${c.reset} nova deploy ./dist --json
    ${c.dim}$${c.reset} nova deploy ./dist --clean          ${c.dim}# Deploy and remove ALL old pieces${c.reset}
    ${c.dim}$${c.reset} nova ens bafybei... --ens mysite.eth
    ${c.dim}$${c.reset} nova status --ens mysite.eth --json
    ${c.dim}$${c.reset} nova manage
    ${c.dim}$${c.reset} nova manage clean --really-do-it
`;

function dirSize(dir: string, seen = new Set<number>()): number {
  let total = 0;
  try {
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

/**
 * Resolve a user-provided path: expand ~, make absolute.
 */
function resolvePath(input: string): string {
  let p = input;
  if (p === "~") {
    p = homedir();
  } else if (p.startsWith("~/")) {
    p = join(homedir(), p.slice(2));
  }
  return resolve(p);
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
      clean: { type: "boolean", default: false },
      calibration: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const jsonMode = values.json!;
  const cleanAfterDeploy = values.clean!;
  if (jsonMode) muteConsole();

  banner();

  const config = resolveConfig(process.env);

  let directory: string | undefined = pos[0];
  let ensName = values.ens || config.ensName;

  // 1. Filecoin wallet key
  if (!config.pinKey) {
    if (!process.stdin.isTTY) {
      fail("NOVA_PIN_KEY env var is required.");
      info("Set it to your Filecoin wallet private key (needs USDFC).");
      earlyExit(1, "NOVA_PIN_KEY env var is required.");
    }
    console.log("");
    info("NOVA_PIN_KEY not set. Run 'nova config' to save your keys,");
    info("or enter your Filecoin wallet key below (needs USDFC).");
    console.log("");
    const key = await ask(promptLabel("Filecoin wallet private key:"));
    if (!key) {
      fail("Cannot deploy without a Filecoin wallet key.");
      info("Set NOVA_PIN_KEY env var and try again.");
      earlyExit(1, "Cannot deploy without a Filecoin wallet key.");
    }
    process.env.NOVA_PIN_KEY = key;
    config.pinKey = key;

    // Set up payments on first use
    console.log("");
    await setupFilecoinPinPayments(!values.calibration);
  }

  // 2. Directory or archive
  if (!directory) {
    console.log("");
    const defaultDir = existsSync("./public") ? "./public" : ".";
    const input = await ask(promptLabel(`Directory or archive to deploy [${defaultDir}]:`));
    directory = input || defaultDir;
  }

  // 3. ENS name (optional — skip to deploy without ENS)
  if (!ensName) {
    console.log("");
    const input = await ask(promptLabel("ENS domain (leave blank to skip):"));
    ensName = input || undefined;
  }

  // Validate ENS name before asking for ETH key
  if (ensName && !ensName.endsWith(".eth")) {
    fail(`Invalid ENS domain: ${ensName}`);
    info("ENS domains must end with .eth (e.g. mysite.eth)");
    earlyExit(1, `Invalid ENS domain: ${ensName}`);
  }

  // 4. Ethereum wallet key (only if ENS is being used)
  if (ensName && !config.ensKey) {
    if (!process.stdin.isTTY) {
      fail("NOVA_ENS_KEY env var is required for ENS updates.");
      info("Set it to your Ethereum wallet private key (needs ETH for gas).");
      earlyExit(1, "NOVA_ENS_KEY env var is required for ENS updates.");
    }
    console.log("");
    info("NOVA_ENS_KEY not set. Run 'nova config' to save your keys,");
    info("or enter your Ethereum wallet key below (needs ETH for gas).");
    console.log("");
    const key = await ask(promptLabel("Ethereum wallet private key:"));
    if (!key) {
      fail("Cannot deploy without an Ethereum wallet key.");
      info("Set NOVA_ENS_KEY env var or run 'nova config'.");
      earlyExit(1, "Cannot deploy without an Ethereum wallet key.");
    }
    process.env.NOVA_ENS_KEY = key;
    config.ensKey = key;
  }

  // Validate path exists before showing summary
  const resolved = resolvePath(directory);
  if (!existsSync(resolved)) {
    fail(`Not found: ${resolved}`);
    earlyExit(1, `Not found: ${resolved}`);
  }

  // Pre-deploy summary (size estimate from the raw input, before archive extraction)
  const bytes = dirSize(resolved);
  const { size, unit } = humanSize(bytes);
  const TIB = 1024 ** 4;
  const USDFC_PER_TIB = 5;
  const costPerMonth = (bytes / TIB) * USDFC_PER_TIB;
  const costStr = costPerMonth < 0.01 ? "< 0.01" : costPerMonth.toFixed(2);
  const isMainnet = !values.calibration;
  console.log("");
  label("Path", resolved);
  label("Size", `${size} ${unit} - ~${costStr} USDFC/month`);
  if (ensName) label("ENS", ensName);
  label("Net", isMainnet ? "mainnet" : "calibration");

  let parsedProviderId = config.providerId;
  if (values["provider-id"] !== undefined) {
    const n = Number(values["provider-id"]);
    if (isNaN(n)) {
      fail(`Invalid provider ID: ${values["provider-id"]}`);
      earlyExit(1, `Invalid provider ID: ${values["provider-id"]}`);
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
    path: directory,
    pinKey: config.pinKey,
    ensName,
    ensKey: config.ensKey,
    rpcUrl: values["rpc-url"] || config.rpcUrl,
    providerId: parsedProviderId,
    mainnet: isMainnet,
  });

  // Post-deploy cleanup
  let cleanedResult: { removed: number; failed: number; keptCids: string[]; error?: string } | undefined;
  if (cleanAfterDeploy && config.pinKey) {
    if (!jsonMode) {
      console.log("");
      info("Cleaning up old pieces...");
    }

    try {
      const cleanResult = await cleanPieces({
        pinKey: config.pinKey,
        mainnet: isMainnet,
        keepCids: [result.cid],
      });

      cleanedResult = { removed: cleanResult.removed, failed: cleanResult.failed, keptCids: cleanResult.keptCids, error: cleanResult.error };

      if (!jsonMode) {
        if (cleanResult.removed > 0) {
          success(`Removed ${cleanResult.removed} old piece(s)`);
          if (cleanResult.failed > 0) {
            info(`${cleanResult.failed} piece(s) failed - run 'nova manage clean' to retry`);
          }
        } else {
          info("No old pieces to clean up.");
        }
      }
    } catch (err: any) {
      if (!jsonMode) {
        info(`Cleanup skipped: ${err.message}`);
      }
      cleanedResult = { removed: 0, failed: 0, keptCids: [], error: err.message };
    }
  }

  if (jsonMode) {
    unmuteConsole();
    console.log(JSON.stringify({
      cid: result.cid,
      directory: result.directory,
      gatewayUrl: `https://${result.cid}.ipfs.dweb.link`,
      ...(result.ensName && { ensName: result.ensName }),
      ...(result.txHash && { txHash: result.txHash }),
      ...(result.ethLimoUrl && { ethLimoUrl: result.ethLimoUrl }),
      ...(cleanedResult && { cleaned: cleanedResult }),
    }));
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
    if (!process.stdin.isTTY) {
      fail("--ens flag or NOVA_ENS_NAME env var required.");
      earlyExit(1, "--ens flag or NOVA_ENS_NAME env var required.");
    }
    const input = await ask(promptLabel("ENS domain to check:"));
    if (!input) {
      fail("ENS domain required.");
      earlyExit(1, "ENS domain required.");
    }
    ensName = input;
  }
  close();

  if (!ensName.endsWith(".eth")) {
    fail(`Invalid ENS domain: ${ensName}`);
    info("ENS domains must end with .eth (e.g. mysite.eth)");
    earlyExit(1, `Invalid ENS domain: ${ensName}`);
  }

  const rpcUrl = values["rpc-url"] || config.rpcUrl;
  info(`Checking ${ensName}...`);
  const contenthash = await getEnsContenthash(ensName, rpcUrl);

  // Extract CID from contenthash (format: "ipfs://bafybei...")
  const cid = contenthash?.startsWith("ipfs://") ? contenthash.slice(7) : null;

  // Check pin status if we have credentials and a CID
  let pinStatus: { totalPieces: number; activePieces: number; pendingRemoval: number } | null = null;
  if (cid && config.pinKey) {
    try {
      const summaries = await listPieces({ pinKey: config.pinKey, mainnet: true });
      for (const ds of summaries) {
        const group = ds.groups.find((g) => g.ipfsRootCID === cid);
        if (group) {
          const pending = group.pieces.filter((p) => p.pendingRemoval).length;
          pinStatus = {
            totalPieces: group.totalPieces,
            activePieces: group.totalPieces - pending,
            pendingRemoval: pending,
          };
          break;
        }
      }
    } catch {
      // Silently skip — pin status is supplementary
    }
  }

  if (jsonMode) {
    unmuteConsole();
    console.log(JSON.stringify({
      ensName,
      contenthash: contenthash || null,
      url: contenthash ? `https://${ensName.replace(/\.eth$/, "")}.eth.limo` : null,
      ...(cid && { cid }),
      ...(pinStatus && { pinStatus }),
    }));
  } else {
    console.log("");
    if (contenthash) {
      label("ENS", ensName);
      label("Hash", contenthash);
      label("URL", `https://${ensName.replace(/\.eth$/, "")}.eth.limo`);
      if (pinStatus) {
        const parts = [`${pinStatus.activePieces} active`];
        if (pinStatus.pendingRemoval > 0) parts.push(`${pinStatus.pendingRemoval} removing`);
        label("Pins", parts.join(", "));
      }
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
      earlyExit(1, "CID argument required.");
    }
    const input = await ask(promptLabel("IPFS CID to point to:"));
    if (!input) {
      fail("CID required.");
      earlyExit(1, "CID required.");
    }
    cid = input;
  }

  // ENS name
  let ensName = values.ens || config.ensName;
  if (!ensName) {
    if (!process.stdin.isTTY) {
      fail("--ens flag or NOVA_ENS_NAME env var required.");
      earlyExit(1, "--ens flag or NOVA_ENS_NAME env var required.");
    }
    const input = await ask(promptLabel("ENS domain:"));
    if (!input) {
      fail("ENS domain required.");
      earlyExit(1, "ENS domain required.");
    }
    ensName = input;
  }

  if (!ensName.endsWith(".eth")) {
    fail(`Invalid ENS domain: ${ensName}`);
    info("ENS domains must end with .eth (e.g. mysite.eth)");
    earlyExit(1, `Invalid ENS domain: ${ensName}`);
  }

  // Ethereum wallet key
  if (!config.ensKey) {
    if (!process.stdin.isTTY) {
      fail("NOVA_ENS_KEY env var is required for ENS updates.");
      info("Set it to your Ethereum wallet private key (needs ETH for gas).");
      earlyExit(1, "NOVA_ENS_KEY env var is required for ENS updates.");
    }
    console.log("");
    info("NOVA_ENS_KEY not set. Run 'nova config' to save your keys,");
    info("or enter your Ethereum wallet key below (needs ETH for gas).");
    console.log("");
    const key = await ask(promptLabel("Ethereum wallet private key:"));
    if (!key) {
      fail("Cannot update ENS without an Ethereum wallet key.");
      info("Set NOVA_ENS_KEY env var or run 'nova config'.");
      earlyExit(1, "Cannot update ENS without an Ethereum wallet key.");
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

async function runManage(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
  ${c.cyan}${c.bold}Nova Manage${c.reset} ${c.dim}- Manage pinned pieces and storage costs${c.reset}

  ${c.bold}Usage${c.reset}

    ${c.cyan}nova manage${c.reset}                         List all pieces grouped by IPFS CID
    ${c.cyan}nova manage clean${c.reset}                   Preview what would be removed (dry run)
    ${c.cyan}nova manage clean --really-do-it${c.reset}     Remove old pieces and duplicate uploads

  ${c.bold}Options (clean)${c.reset}

    ${c.dim}--really-do-it${c.reset}        Required - confirms you want to delete pieces
    ${c.dim}--keep <cid,...>${c.reset}      Keep these CIDs, remove everything else
                         ${c.dim}(default: keep the latest CID only)${c.reset}
    ${c.dim}--remove <cid,...>${c.reset}    Remove only these CIDs, keep everything else
    ${c.dim}--keep-copies${c.reset}         Keep all copies of the same content
                         ${c.dim}(default: duplicate uploads are removed)${c.reset}
    ${c.dim}--dataset-id <id>${c.reset}     Target a specific dataset (if wallet has multiple)

  ${c.bold}Options (shared)${c.reset}

    ${c.dim}--calibration${c.reset}         Use calibration testnet (default: mainnet)
    ${c.dim}--json${c.reset}                Output as JSON

  ${c.bold}Examples${c.reset}

    ${c.dim}$${c.reset} nova manage                             ${c.dim}# List all pieces${c.reset}
    ${c.dim}$${c.reset} nova manage clean                       ${c.dim}# Preview cleanup (dry run)${c.reset}
    ${c.dim}$${c.reset} nova manage clean --really-do-it        ${c.dim}# Keep latest, remove the rest${c.reset}
    ${c.dim}$${c.reset} nova manage clean --remove bafybei... --really-do-it
                                              ${c.dim}# Remove a specific CID${c.reset}
    ${c.dim}$${c.reset} nova manage clean --remove bafybei...,bafybei... --really-do-it
                                              ${c.dim}# Remove multiple CIDs${c.reset}
    ${c.dim}$${c.reset} nova manage clean --keep bafybei...,bafybei... --really-do-it
                                              ${c.dim}# Keep multiple CIDs, remove the rest${c.reset}
    ${c.dim}$${c.reset} nova manage clean --keep-copies --really-do-it
                                              ${c.dim}# Keep all copies (skip dedup)${c.reset}
`);
    earlyExit(0);
  }

  const { values, positionals: pos } = parseArgs({
    args: args.slice(1),
    options: {
      keep: { type: "string" },
      remove: { type: "string" },
      "keep-copies": { type: "boolean", default: false },
      "really-do-it": { type: "boolean", default: false },
      "dataset-id": { type: "string" },
      calibration: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const jsonMode = values.json!;
  if (jsonMode) muteConsole();

  const config = resolveConfig(process.env);
  const mainnet = !values.calibration;

  if (!config.pinKey) {
    if (!process.stdin.isTTY) {
      fail("NOVA_PIN_KEY env var is required.");
      earlyExit(1, "NOVA_PIN_KEY env var is required.");
    }
    console.log("");
    info("NOVA_PIN_KEY not set. Run 'nova config' to save your keys,");
    info("or enter your Filecoin wallet key below.");
    console.log("");
    const key = await ask(promptLabel("Filecoin wallet private key:"));
    if (!key) {
      fail("Cannot manage without a Filecoin wallet key.");
      earlyExit(1, "Cannot manage without a Filecoin wallet key.");
    }
    config.pinKey = key;
  }

  close();

  const subcommand = pos[0];

  if (!subcommand) {
    info(`Querying ${mainnet ? "mainnet" : "calibration"}...`);
    console.log("");

    const summaries = await listPieces({ pinKey: config.pinKey, mainnet });

    if (summaries.length === 0) {
      if (jsonMode) {
        unmuteConsole();
        console.log(JSON.stringify({ datasets: [] }));
      } else {
        info("No datasets found for this wallet.");
      }
      return;
    }

    if (jsonMode) {
      unmuteConsole();
      console.log(jsonStringify({ datasets: summaries }));
      return;
    }

    function formatSize(bytes: number): string {
      if (bytes === 0) return "-";
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
      if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
      return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
    }

    function center(text: string, width: number): string {
      const pad = Math.max(0, width - text.length);
      const left = Math.floor(pad / 2);
      return " ".repeat(left) + text + " ".repeat(pad - left);
    }

    for (const ds of summaries) {
      console.log(`  ${c.cyan}${c.bold}Dataset ${ds.dataSetId}${c.reset} ${c.dim}(${ds.providerName}, ${ds.activePieceCount} pieces)${c.reset}`);
      console.log("");

      if (ds.groups.length === 0) {
        info("  No piece groups found.");
        continue;
      }

      // Table layout
      const cidW = 59;
      const pcsW = 5;
      const sizeW = 10;
      const statusW = 8;

      console.log(`  ${c.dim}${center("CID", cidW)}  ${center("Pcs", pcsW)}  ${center("Size", sizeW)}  ${center("Status", statusW)}${c.reset}`);
      console.log(`  ${c.dim}${"─".repeat(cidW)}  ${"─".repeat(pcsW)}  ${"─".repeat(sizeW)}  ${"─".repeat(statusW)}${c.reset}`);

      let totalSize = 0;

      for (let i = 0; i < ds.groups.length; i++) {
        const g = ds.groups[i];
        const isLatest = i === 0;
        const pendingCount = g.pieces.filter((p) => p.pendingRemoval).length;
        const allPending = pendingCount === g.totalPieces;
        let tag: string;
        if (allPending) {
          tag = `${c.dim}${center("removing", statusW)}${c.reset}`;
        } else if (pendingCount > 0) {
          tag = isLatest
            ? `${c.green}${center("latest", statusW)}${c.reset}`
            : `${c.yellow}${center("old", statusW)}${c.reset}`;
        } else {
          tag = isLatest ? `${c.green}${center("latest", statusW)}${c.reset}` : `${c.yellow}${center("old", statusW)}${c.reset}`;
        }
        const pcsStr = String(g.totalPieces);
        const sizeStr = formatSize(g.totalSizeBytes);
        totalSize += g.totalSizeBytes;
        const cidLink = `\x1b]8;;https://${g.ipfsRootCID}.ipfs.dweb.link\x07${center(g.ipfsRootCID, cidW)}\x1b]8;;\x07`;
        console.log(`  ${c.bold}${cidLink}${c.reset}  ${c.dim}${center(pcsStr, pcsW)}${c.reset}  ${c.dim}${center(sizeStr, sizeW)}${c.reset}  ${tag}`);
      }

      if (ds.orphanPieces.length > 0) {
        const orphanSize = ds.orphanPieces.reduce((s, p) => s + p.sizeBytes, 0);
        totalSize += orphanSize;
        console.log(`  ${c.dim}${center("(no IPFS root CID)", cidW)}  ${center(String(ds.orphanPieces.length), pcsW)}  ${center(formatSize(orphanSize), sizeW)}${c.reset}  ${c.yellow}${center("orphan", statusW)}${c.reset}`);
      }

      // Totals row
      console.log(`  ${c.dim}${"─".repeat(cidW)}  ${"─".repeat(pcsW)}  ${"─".repeat(sizeW)}  ${"─".repeat(statusW)}${c.reset}`);
      console.log(`  ${center("Total", cidW)}  ${c.bold}${center(String(Number(ds.activePieceCount)), pcsW)}${c.reset}  ${c.bold}${center(formatSize(totalSize), sizeW)}${c.reset}`);

      console.log("");

      if (ds.pendingRemovalCount > 0) {
        console.log(`  ${c.dim}${ds.pendingRemovalCount} piece(s) pending removal - removals are processed by the provider on a schedule${c.reset}`);
        console.log("");
      }

      // Summary — count old pieces + duplicate uploads, excluding pending
      const activePieces = (p: PieceInfo) => !p.pendingRemoval;
      const oldPieces = ds.groups.slice(1).reduce((sum, g) => sum + g.pieces.filter(activePieces).length, 0)
        + ds.orphanPieces.filter(activePieces).length;
      const duplicates = ds.groups.reduce((sum, g) => {
        const active = g.pieces.filter(activePieces).length;
        return sum + Math.max(0, active - 1);
      }, 0);
      const removable = oldPieces + duplicates;
      if (removable > 0) {
        const oldSize = ds.groups.slice(1).reduce((s, g) =>
          s + g.pieces.filter(activePieces).reduce((ss, p) => ss + p.sizeBytes, 0), 0)
          + ds.orphanPieces.filter(activePieces).reduce((s, p) => s + p.sizeBytes, 0);
        const dupSize = ds.groups.reduce((s, g) => {
          const active = g.pieces.filter(activePieces);
          if (active.length <= 1) return s;
          const perPiece = active.reduce((ss, p) => ss + p.sizeBytes, 0) / active.length;
          return s + perPiece * (active.length - 1);
        }, 0);
        const savingStr = formatSize(oldSize + dupSize);
        if (oldPieces > 0 && duplicates > 0) {
          console.log(`  ${c.yellow}${oldPieces} old piece(s) + ${duplicates} duplicate upload(s) (${savingStr}) can be cleaned up${c.reset}`);
        } else if (duplicates > 0) {
          console.log(`  ${c.yellow}${duplicates} duplicate upload(s) (${savingStr}) can be cleaned up${c.reset}`);
        } else {
          console.log(`  ${c.yellow}${oldPieces} old piece(s) (${savingStr}) can be cleaned up${c.reset}`);
        }
        info(`  Run: nova manage clean${!mainnet ? " --calibration" : ""}`);
        console.log("");
      }
    }
  } else if (subcommand === "clean") {
    const reallyDoIt = values["really-do-it"]!;

    let dataSetId: bigint | undefined;
    if (values["dataset-id"] !== undefined) {
      const n = Number(values["dataset-id"]);
      if (isNaN(n)) {
        fail(`Invalid dataset ID: ${values["dataset-id"]}`);
        earlyExit(1, `Invalid dataset ID: ${values["dataset-id"]}`);
      }
      dataSetId = BigInt(n);
    }

    info(`Scanning ${mainnet ? "mainnet" : "calibration"}...`);
    console.log("");

    const summaries = await listPieces({ pinKey: config.pinKey, mainnet });
    if (summaries.length === 0) {
      info("No datasets found for this wallet.");
      return;
    }

    let target = summaries[0];
    if (dataSetId !== undefined) {
      const found = summaries.find((s) => s.dataSetId === dataSetId);
      if (!found) {
        fail(`Dataset ${dataSetId} not found.`);
        earlyExit(1, `Dataset ${dataSetId} not found.`);
      }
      target = found;
    } else if (summaries.length > 1) {
      fail(`Multiple datasets found. Specify one with --dataset-id.`);
      info(`IDs: ${summaries.map((s) => s.dataSetId).join(", ")}`);
      earlyExit(1, "Multiple datasets found.");
    }

    // Parse comma-separated CID lists
    const removeCids = values.remove ? values.remove.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const keepCids = values.keep ? values.keep.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const hasRemoveFlag = removeCids.length > 0;
    const hasKeepFlag = keepCids.length > 0;

    // Validate --keep and --remove are not used together
    if (hasKeepFlag && hasRemoveFlag) {
      fail("Cannot use --keep and --remove together.");
      info("Use --keep to keep specific CIDs and remove everything else,");
      info("or --remove to remove specific CIDs.");
      earlyExit(1, "Cannot use --keep and --remove together.");
    }

    const keepCopies = values["keep-copies"]!;

    // Helper: count active (non-pending) pieces in a group
    const activeCount = (g: { pieces: PieceInfo[] }) =>
      g.pieces.filter((p) => !p.pendingRemoval).length;

    // Determine what will be kept and removed (only counting active pieces)
    const keptCids: string[] = [];
    let piecesToRemove = 0;
    let duplicatesToRemove = 0;
    const removedGroups: { cid: string; pieces: number }[] = [];

    if (hasRemoveFlag) {
      for (const cid of removeCids) {
        if (!target.groups.find((g) => g.ipfsRootCID === cid)) {
          fail(`CID not found in dataset: ${cid}`);
          earlyExit(1, `CID not found: ${cid}`);
        }
      }
      const removeSet = new Set(removeCids);
      for (const g of target.groups) {
        if (removeSet.has(g.ipfsRootCID)) {
          const active = activeCount(g);
          if (active > 0) {
            piecesToRemove += active;
            removedGroups.push({ cid: g.ipfsRootCID, pieces: active });
          }
        } else {
          keptCids.push(g.ipfsRootCID);
        }
      }
    } else {
      // Keep mode: keep specified CIDs (or latest), remove everything else
      const keepSet = hasKeepFlag
        ? new Set(keepCids)
        : new Set([target.groups[0]?.ipfsRootCID].filter(Boolean));

      if (keepSet.size === 0) {
        info("No piece groups found to clean.");
        return;
      }

      // Validate all keep CIDs exist
      for (const cid of keepSet) {
        if (!target.groups.find((g) => g.ipfsRootCID === cid)) {
          fail(`CID not found in dataset: ${cid}`);
          earlyExit(1, `CID not found: ${cid}`);
        }
      }

      for (const g of target.groups) {
        if (keepSet.has(g.ipfsRootCID)) {
          keptCids.push(g.ipfsRootCID);
          // Dedup within kept groups (only active pieces)
          const active = activeCount(g);
          if (!keepCopies && active > 1) {
            duplicatesToRemove += active - 1;
          }
        } else {
          const active = activeCount(g);
          if (active > 0) {
            piecesToRemove += active;
            removedGroups.push({ cid: g.ipfsRootCID, pieces: active });
          }
        }
      }
      const activeOrphans = target.orphanPieces.filter((p) => !p.pendingRemoval).length;
      piecesToRemove += activeOrphans;
    }

    const totalToRemove = piecesToRemove + duplicatesToRemove;

    if (totalToRemove === 0) {
      if (jsonMode) {
        unmuteConsole();
        console.log(JSON.stringify({ removed: 0 }));
      } else {
        success("Nothing to clean.");
      }
      return;
    }

    // Show the plan
    console.log(`  ${c.cyan}${c.bold}Clean Plan${c.reset} ${c.dim}(Dataset ${target.dataSetId})${c.reset}`);
    console.log("");
    if (!hasRemoveFlag) {
      for (const cid of keptCids) {
        label("Keep", `${cid} (1 piece)`);
      }
      console.log("");
    }
    if (removedGroups.length > 0) {
      for (const g of removedGroups) {
        labelDim("Delete", `${g.cid} (${g.pieces} piece${g.pieces > 1 ? "s" : ""})`);
      }
    }
    const activeOrphanCount = target.orphanPieces.filter((p) => !p.pendingRemoval).length;
    if (activeOrphanCount > 0 && !hasRemoveFlag) {
      labelDim("Delete", `${activeOrphanCount} orphan piece(s) (no IPFS root CID)`);
    }
    // Show duplicates per kept CID (only for default clean / --keep, not --remove)
    if (!keepCopies && !hasRemoveFlag) {
      for (const cid of keptCids) {
        const g = target.groups.find((g) => g.ipfsRootCID === cid);
        if (g) {
          const active = activeCount(g);
          if (active > 1) {
            labelDim("Delete", `${active - 1} duplicate upload(s) of ${cid}`);
          }
        }
      }
    }
    console.log("");
    label("Total", `${totalToRemove} piece(s) will be permanently deleted`);
    console.log("");

    if (!reallyDoIt) {
      // Dry run — show the plan and exit
      info("This is a preview. No pieces were deleted.");
      console.log("");
      if (hasRemoveFlag) {
        info(`To execute: nova manage clean --remove ${values.remove} --really-do-it${!mainnet ? " --calibration" : ""}`);
      } else if (values.keep) {
        info(`To execute: nova manage clean --keep ${values.keep} --really-do-it${!mainnet ? " --calibration" : ""}`);
      } else {
        info(`To execute: nova manage clean --really-do-it${!mainnet ? " --calibration" : ""}`);
      }
      console.log("");
      earlyExit(0);
    }

    // In non-TTY mode (CI), --really-do-it is sufficient
    // In TTY mode, also require interactive confirmation
    if (process.stdin.isTTY && !jsonMode) {
      const { ask: askPrompt, close: closePrompt } = await import("./prompt.js");
      const confirm = await askPrompt(promptLabel(`Permanently delete ${totalToRemove} piece(s)? Type 'yes' to confirm:`));
      closePrompt();
      if (confirm !== "yes") {
        info("Clean cancelled.");
        earlyExit(0);
      }
    }

    info(`Removing ${totalToRemove} piece(s) - each requires a separate transaction, this may take a while...`);
    const result = await cleanPieces({
      pinKey: config.pinKey,
      mainnet,
      keepCids: hasKeepFlag ? keepCids : undefined,
      removeCids: hasRemoveFlag ? removeCids : undefined,
      dataSetId,
      keepCopies,
      onProgress: (done, total) => {
        if (process.stderr.isTTY) {
          process.stderr.write(`\r  ${c.dim}${done}/${total}${c.reset}`);
          if (done === total) process.stderr.write("\r" + " ".repeat(20) + "\r");
        }
      },
    });

    if (jsonMode) {
      unmuteConsole();
      console.log(jsonStringify(result));
    } else {
      console.log("");
      if (result.failed > 0) {
        console.log(`  ${c.yellow}Partially completed: ${result.removed} of ${result.removed + result.failed} piece(s) removed${c.reset}`);
        fail(`Error: ${result.error}`);
        info("The pieces already removed are scheduled for deletion.");
        info("Run 'nova manage clean' again to retry the remaining pieces.");
      } else {
        success(`Removed ${result.removed} piece(s)`);
      }
      for (const cid of result.keptCids) {
        label("Kept", cid);
      }
      if (result.txHashes.length > 0) {
        labelDim("TXs", result.txHashes.length.toString());
      }
      console.log("");
      info("Removals take at least 30 seconds to appear in 'nova manage'.");
      info("Pieces will show as 'removing' until the provider fully processes them.");
      console.log("");
    }
  } else {
    fail(`Unknown manage subcommand: ${subcommand}`);
    info("Use: nova manage | nova manage clean");
    earlyExit(1, `Unknown manage subcommand: ${subcommand}`);
  }
}

async function runConfig() {
  if (!process.stdin.isTTY) {
    fail("'nova config' requires an interactive terminal.");
    info("In CI, use environment variables (NOVA_PIN_KEY, NOVA_ENS_KEY, etc.).");
    earlyExit(1, "'nova config' requires an interactive terminal.");
  }

  const creds = readCredentials();

  console.log("");
  console.log(`  ${c.cyan}${c.bold}Nova Config${c.reset}`);
  console.log(`  ${c.dim}Credentials stored in ${credentialsPath()}${c.reset}`);
  console.log("");
  info("Only the Filecoin wallet key is needed to deploy. The rest are optional.");
  info("Press Enter to skip or keep current value. Enter 'clear' to remove.");
  console.log("");

  const pinKey = await ask(promptLabel(`Filecoin wallet key${creds.pinKey ? ` [${c.dim}configured${c.reset}]` : ""}:`));
  if (pinKey === "clear") {
    delete creds.pinKey;
  } else if (pinKey) {
    creds.pinKey = pinKey;
  }

  const ensKey = await ask(promptLabel(`Ethereum wallet key${creds.ensKey ? ` [${c.dim}configured${c.reset}]` : ""}:`));
  if (ensKey === "clear") {
    delete creds.ensKey;
  } else if (ensKey) {
    creds.ensKey = ensKey;
  }

  const ensName = await ask(promptLabel(`Default ENS domain${creds.ensName ? ` [${creds.ensName}]` : ""}:`));
  if (ensName === "clear") {
    delete creds.ensName;
  } else if (ensName) {
    creds.ensName = ensName;
  }

  const providerId = await ask(promptLabel(`Provider ID${creds.providerId !== undefined ? ` [${creds.providerId}]` : ""}:`));
  if (providerId === "clear") {
    delete creds.providerId;
  } else if (providerId) {
    const n = Number(providerId);
    if (isNaN(n)) {
      fail("Invalid provider ID - must be a number.");
      earlyExit(1, "Invalid provider ID.");
    }
    creds.providerId = n;
  }

  const rpcUrl = await ask(promptLabel(`Ethereum RPC URL${creds.rpcUrl ? ` [${c.dim}configured${c.reset}]` : ""}:`));
  if (rpcUrl === "clear") {
    delete creds.rpcUrl;
  } else if (rpcUrl) {
    creds.rpcUrl = rpcUrl;
  }

  close();

  writeCredentials(creds);

  console.log("");
  success(`Saved to ${credentialsPath()}`);
  console.log("");
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
    case "manage":
      await runManage(args);
      break;
    case "config":
      await runConfig();
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
      if (err.exitCode !== 0) {
        console.log(JSON.stringify({ error: err.message || "Operation failed" }));
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
