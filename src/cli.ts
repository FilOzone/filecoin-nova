#!/usr/bin/env node

import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { deploy, dirSize } from "./deploy.js";
import { demoDeploy, DEMO_SESSION_KEY, DEMO_WALLET_ADDRESS } from "./demo.js";
import { getEnsContenthash, updateEnsContenthash } from "./ens.js";
import { resolveConfig, hasSessionKeyAuth, hasStorageAuth } from "./config.js";
import { ensSigningUrl, sessionKeySigningUrl } from "./signing-url.js";
import { pollEnsContenthash, pollSessionKeyRegistered } from "./poll.js";
import { listPieces, cleanPieces, type PieceInfo } from "./manage.js";
import { relativeTime } from "./subgraph.js";
import { ask, close } from "./prompt.js";
import { c, fail, info, label, labelDim, promptLabel, banner, success, formatSize, link } from "./ui.js";
import { CID } from "multiformats/cid";

/** Normalize a CID string to CIDv1 base32 for consistent comparison. */
function toCidV1(cidStr: string): string {
  try {
    const parsed = CID.parse(cidStr);
    return parsed.toV1().toString();
  } catch {
    return cidStr;
  }
}

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
  // Redirect progress to stderr so JSON result is the only stdout output.
  // Callers (like focify-me) can stream stderr for live progress.
  console.log = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");
  console.error = (...args: unknown[]) => process.stderr.write(args.join(" ") + "\n");
}
function unmuteConsole() {
  console.log = originalLog;
  console.error = originalError;
}

function earlyExit(code: number, message?: string): never {
  throw new ExitError(code, message);
}

const HELP = `
  ${c.cyan}${c.bold}Nova${c.reset} ${c.dim}- Clone, deploy, and manage websites on Filecoin Onchain Cloud${c.reset}

  ${c.bold}Usage${c.reset}

    ${c.cyan}nova demo${c.reset} <url-or-path>              Try Nova instantly -- no wallet needed
    ${c.cyan}nova clone${c.reset} <url> [options]          Clone a website and deploy to Filecoin
    ${c.cyan}nova deploy${c.reset} [path] [options]        Deploy a directory or archive
    ${c.cyan}nova ens${c.reset} [name]                      Check ENS contenthash + pin status
    ${c.cyan}nova ens${c.reset} <cid> --ens <name>         Point ENS domain to an IPFS CID
    ${c.cyan}nova info${c.reset} <cid>                     Show details for a specific deployment
    ${c.cyan}nova wallet${c.reset}                          Show wallet balance and deposit status
    ${c.cyan}nova download${c.reset} <cid> [dir]              Download content from IPFS
    ${c.cyan}nova manage${c.reset} [clean]                 Manage pinned pieces and storage costs
    ${c.cyan}nova help${c.reset}                           Show this help
    ${c.cyan}nova --version${c.reset}                      Show version

  ${c.bold}Auth${c.reset}

    No private keys needed. Nova opens your browser for wallet signing via MetaMask.
    For CI/automation, set env vars instead:

    ${c.cyan}NOVA_SESSION_KEY${c.reset}     Session key for storage auth (scoped, safe)
    ${c.cyan}NOVA_WALLET_ADDRESS${c.reset}  Wallet address for session key auth
    ${c.cyan}NOVA_PIN_KEY${c.reset}         Filecoin wallet private key (CI fallback)
    ${c.cyan}NOVA_ENS_KEY${c.reset}         Ethereum wallet key (CI fallback for ENS)
    ${c.cyan}NOVA_ENS_NAME${c.reset}        Default ENS domain
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

    ${c.dim}$${c.reset} nova demo filoz.org                  ${c.dim}# Try instantly, no wallet needed${c.reset}
    ${c.dim}$${c.reset} nova clone https://example.com       ${c.dim}# Clone and deploy a website${c.reset}
    ${c.dim}$${c.reset} nova deploy ./public --ens mysite.eth
    ${c.dim}$${c.reset} nova deploy ./dist --clean           ${c.dim}# Deploy and remove ALL old pieces${c.reset}
    ${c.dim}$${c.reset} nova info bafybei...                  ${c.dim}# Show details for a deployment${c.reset}
    ${c.dim}$${c.reset} nova ens mysite.eth                  ${c.dim}# Check contenthash + pin status${c.reset}
    ${c.dim}$${c.reset} nova ens bafybei... --ens mysite.eth ${c.dim}# Update ENS to point to CID${c.reset}
    ${c.dim}$${c.reset} nova manage
    ${c.dim}$${c.reset} nova manage clean --really-do-it
`;



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
      "session-key": { type: "string" },
      "wallet-address": { type: "string" },
      label: { type: "string" },
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
  if (values["session-key"]) config.sessionKey = values["session-key"];
  if (values["wallet-address"]) config.walletAddress = values["wallet-address"];

  let directory: string | undefined = pos[0];
  let ensName = values.ens || config.ensName;

  // 1. Filecoin auth (session key preferred, env var fallback, browser signing)
  if (!hasStorageAuth(config)) {
    if (!process.stdin.isTTY) {
      fail("No Filecoin auth configured.");
      info("Set NOVA_SESSION_KEY + NOVA_WALLET_ADDRESS env vars.");
      earlyExit(1, "No Filecoin auth configured.");
    }
    const chain = values.calibration ? "calibration" : "mainnet";
    const url = sessionKeySigningUrl(chain);
    console.log("");
    info("No session key found. Create one in your browser:");
    console.log("");
    info(`  ${link(url)}`);
    console.log("");
    info("Connect your MetaMask wallet, sign the transaction, then paste the session key below.");
    console.log("");
    const sk = await ask(promptLabel("Session key:"));
    if (!sk) {
      fail("Cannot deploy without a session key.");
      earlyExit(1, "Cannot deploy without a session key.");
    }
    const wa = await ask(promptLabel("Wallet address:"));
    if (!wa) {
      fail("Wallet address is required with session key.");
      earlyExit(1, "Wallet address is required.");
    }
    config.sessionKey = sk;
    config.walletAddress = wa;
    process.env.NOVA_SESSION_KEY = sk;
    process.env.NOVA_WALLET_ADDRESS = wa;
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

  // 4. ENS: if no key, deploy will skip ENS step, we handle browser signing after

  // Validate path exists before showing summary
  const resolved = resolvePath(directory);
  if (!existsSync(resolved)) {
    fail(`Not found: ${resolved}`);
    earlyExit(1, `Not found: ${resolved}`);
  }

  // Pre-deploy summary (size estimate from the raw input, before archive extraction)
  const bytes = dirSize(resolved);
  const TIB = 1024 ** 4;
  const USDFC_PER_TIB = 5;
  const costPerMonth = (bytes / TIB) * USDFC_PER_TIB;
  const costStr = costPerMonth < 0.01 ? "< 0.01" : costPerMonth.toFixed(2);
  const isMainnet = !values.calibration;
  console.log("");
  label("Path", resolved);
  label("Size", `${formatSize(bytes)} - ~${costStr} USDFC/month`);
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
    sessionKey: config.sessionKey,
    walletAddress: config.walletAddress,
    ensName,
    ensKey: config.ensKey,
    rpcUrl: values["rpc-url"] || config.rpcUrl,
    providerId: parsedProviderId,
    mainnet: isMainnet,
    label: values.label,
  });

  // Post-deploy ENS via browser signing (when no ensKey)
  if (ensName && !config.ensKey && !result.txHash) {
    const url = ensSigningUrl(ensName, result.cid);
    console.log("");
    info(`Sign the ENS update in your browser:`);
    console.log("");
    info(`  ${link(url)}`);
    console.log("");

    if (process.stdin.isTTY && !jsonMode) {
      info("Waiting for ENS contenthash update...");
      const POLL_INTERVAL = 5_000;
      const POLL_TIMEOUT = 300_000; // 5 minutes
      const start = Date.now();
      let confirmed = false;
      while (Date.now() - start < POLL_TIMEOUT) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        const poll = await pollEnsContenthash(ensName, result.cid, values["rpc-url"] || config.rpcUrl);
        if (poll.confirmed) {
          confirmed = true;
          result.ensName = ensName;
          result.ethLimoUrl = `https://${ensName.replace(/\.eth$/, "")}.eth.limo`;
          success(`ENS updated: ${c.bold}${result.ethLimoUrl}${c.reset}`);
          break;
        }
        if (process.stderr.isTTY) {
          const elapsed = Math.round((Date.now() - start) / 1000);
          process.stderr.write(`\r  ${c.dim}Polling... ${elapsed}s${c.reset}`);
        }
      }
      if (process.stderr.isTTY) process.stderr.write("\r" + " ".repeat(30) + "\r");
      if (!confirmed) {
        info("ENS update not detected yet. It may still be pending.");
        info(`Check: nova ens ${ensName}`);
      }
    }
  }

  // Post-deploy cleanup
  let cleanedResult: { removed: number; failed: number; keptCids: string[]; error?: string } | undefined;
  if (cleanAfterDeploy && hasStorageAuth(config)) {
    if (!jsonMode) {
      console.log("");
      info("Cleaning up old pieces...");
    }

    try {
      const cleanResult = await cleanPieces({
        pinKey: config.pinKey,
        sessionKey: config.sessionKey,
        walletAddress: config.walletAddress,
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
  console.error(`  ${c.yellow}Note:${c.reset} ${c.dim}nova status is deprecated. Use ${c.reset}nova ens <name>${c.dim} instead.${c.reset}`);
  console.error("");

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

  // Check pin status if we have storage auth and a CID
  let pinStatus: { totalPieces: number; activePieces: number; pendingRemoval: number } | null = null;
  if (cid && hasStorageAuth(config)) {
    try {
      const cidV1 = toCidV1(cid);
      const summaries = await listPieces({ pinKey: config.pinKey, sessionKey: config.sessionKey, walletAddress: config.walletAddress, mainnet: true });
      for (const ds of summaries) {
        const group = ds.groups.find((g) => toCidV1(g.ipfsRootCID) === cidV1);
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

  // Detect read-only mode: positional is an ENS name, or no positional at all
  const firstPos = pos[0];
  const isReadMode = !firstPos || firstPos.endsWith(".eth");

  if (isReadMode) {
    // Read-only: show ENS contenthash + pin status
    let ensName = firstPos || values.ens || config.ensName;
    if (!ensName) {
      if (!process.stdin.isTTY) {
        fail("ENS name required.");
        info("Usage: nova ens <name>");
        earlyExit(1, "ENS name required.");
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
    const cid = contenthash?.startsWith("ipfs://") ? contenthash.slice(7) : null;

    // Check pin status if we have storage auth and a CID
    let pinStatus: { totalPieces: number; activePieces: number; pendingRemoval: number } | null = null;
    if (cid && hasStorageAuth(config)) {
      try {
        const cidV1 = toCidV1(cid);
        const summaries = await listPieces({ pinKey: config.pinKey, sessionKey: config.sessionKey, walletAddress: config.walletAddress, mainnet: true });
        for (const ds of summaries) {
          const group = ds.groups.find((g) => toCidV1(g.ipfsRootCID) === cidV1);
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
        // Silently skip -- pin status is supplementary
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
    return;
  }

  // Write mode: update ENS contenthash
  let cid = firstPos;

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

  close();

  // Summary
  console.log("");
  label("CID", cid);
  label("ENS", ensName);
  console.log("");

  if (config.ensKey) {
    // Direct execution with key
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
  } else {
    // Browser signing flow
    const url = ensSigningUrl(ensName, cid);

    if (jsonMode) {
      unmuteConsole();
      console.log(JSON.stringify({
        status: "awaiting_signature",
        signingUrl: url,
        ensName,
        cid,
      }));
    } else {
      info("Sign the ENS update in your browser:");
      console.log("");
      info(`  ${link(url)}`);
      console.log("");

      if (process.stdin.isTTY) {
        info("Waiting for ENS contenthash update...");
        const POLL_INTERVAL = 5_000;
        const POLL_TIMEOUT = 300_000;
        const start = Date.now();
        let confirmed = false;
        while (Date.now() - start < POLL_TIMEOUT) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL));
          const poll = await pollEnsContenthash(ensName, cid, values["rpc-url"] || config.rpcUrl);
          if (poll.confirmed) {
            confirmed = true;
            const ethLimoUrl = `https://${ensName.replace(/\.eth$/, "")}.eth.limo`;
            console.log("");
            success("ENS domain updated");
            console.log("");
            label("ENS", ensName);
            label("URL", ethLimoUrl);
            console.log("");
            break;
          }
          if (process.stderr.isTTY) {
            const elapsed = Math.round((Date.now() - start) / 1000);
            process.stderr.write(`\r  ${c.dim}Polling... ${elapsed}s${c.reset}`);
          }
        }
        if (process.stderr.isTTY) process.stderr.write("\r" + " ".repeat(30) + "\r");
        if (!confirmed) {
          console.log("");
          info("ENS update not detected yet. It may still be pending.");
          info(`Check: nova ens ${ensName}`);
          console.log("");
        }
      }
    }
  }
}

async function runDownload(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    earlyExit(0);
  }

  const { values, positionals: pos } = parseArgs({
    args: args.slice(1),
    options: {
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const jsonMode = values.json!;
  if (jsonMode) muteConsole();

  let cidStr = pos[0];
  if (!cidStr) {
    if (!process.stdin.isTTY) {
      fail("CID argument required.");
      info("Usage: nova download <cid> [directory]");
      earlyExit(1, "CID argument required.");
    }
    const input = await ask(promptLabel("IPFS CID:"));
    if (!input) {
      fail("CID required.");
      earlyExit(1, "CID required.");
    }
    cidStr = input;
  }

  const outDir = resolve(pos[1] || cidStr);
  close();

  const { mkdirSync, createWriteStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const { Readable } = await import("node:stream");
  const { execSync } = await import("node:child_process");

  // Download as tar from IPFS gateway (try multiple gateways)
  const gateways = [
    `https://${cidStr}.ipfs.w3s.link/?format=tar`,
    `https://${cidStr}.ipfs.dweb.link/?format=tar`,
    `https://ipfs.io/ipfs/${cidStr}?format=tar`,
  ];
  info(`Downloading ${cidStr}...`);

  let res: Response | null = null;
  for (let i = 0; i < gateways.length; i++) {
    try {
      if (i > 0) info(`Trying gateway ${i + 1}/${gateways.length}...`);
      const attempt = await fetch(gateways[i], {
        headers: { Accept: "application/x-tar" },
        redirect: "follow",
      });
      if (attempt.ok) {
        res = attempt;
        break;
      }
    } catch {
      // Try next gateway
    }
  }

  if (!res || !res.ok) {
    fail("All IPFS gateways failed. The content may not be available yet.");
    info("Wait a few minutes for IPNI propagation, then retry.");
    earlyExit(1, "Gateway error");
  }

  // Save tar to temp file, then extract
  const { tmpdir } = await import("node:os");
  const tarPath = join(tmpdir(), `nova-download-${Date.now()}.tar`);

  const contentLength = Number(res.headers.get("content-length") || 0);
  let downloaded = 0;

  // Stream response to temp tar file with progress
  const body = res.body;
  if (!body) {
    fail("Empty response from gateway.");
    earlyExit(1, "Empty response.");
  }

  const fileStream = createWriteStream(tarPath);
  const reader = body.getReader();
  const nodeStream = new Readable({
    async read() {
      const { done, value } = await reader.read();
      if (done) {
        this.push(null);
        return;
      }
      downloaded += value.byteLength;
      if (process.stderr.isTTY && contentLength > 0) {
        const pct = Math.min(100, Math.round((downloaded / contentLength) * 100));
        process.stderr.write(`\r  ${c.dim}Downloading... ${pct}% (${formatSize(downloaded)})${c.reset}`);
      } else if (process.stderr.isTTY && downloaded % (1024 * 256) < value.byteLength) {
        process.stderr.write(`\r  ${c.dim}Downloading... ${formatSize(downloaded)}${c.reset}`);
      }
      this.push(value);
    },
  });

  await pipeline(nodeStream, fileStream);
  if (process.stderr.isTTY) process.stderr.write("\r" + " ".repeat(60) + "\r");

  // Extract tar
  mkdirSync(outDir, { recursive: true });
  info(`Extracting to ${outDir}...`);
  execSync(`tar xf "${tarPath}" --strip-components=1 -C "${outDir}"`, { stdio: "pipe" });

  // Cleanup
  const { unlinkSync } = await import("node:fs");
  unlinkSync(tarPath);

  if (jsonMode) {
    unmuteConsole();
    console.log(JSON.stringify({ cid: cidStr, directory: outDir, size: downloaded }));
  } else {
    console.log("");
    success(`Downloaded to ${c.bold}${outDir}${c.reset}`);
    label("Size", formatSize(downloaded));
    console.log("");
  }
}

async function runWallet(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    earlyExit(0);
  }

  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      calibration: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const jsonMode = values.json!;
  if (jsonMode) muteConsole();

  const config = resolveConfig(process.env);
  if (!hasStorageAuth(config)) {
    fail("No Filecoin auth configured.");
    info("Set NOVA_SESSION_KEY + NOVA_WALLET_ADDRESS env vars.");
    earlyExit(1, "No Filecoin auth configured.");
  }

  const isMainnet = !values.calibration;
  const { createSynapse, resolveWalletAddress } = await import("./auth.js");
  const { getBalance } = await import("viem/actions");
  const { balance: erc20Balance } = await import("@filoz/synapse-core/erc20");
  const { accounts: payAccounts } = await import("@filoz/synapse-core/pay");

  const auth = { pinKey: config.pinKey, sessionKey: config.sessionKey, walletAddress: config.walletAddress };
  const walletAddr = resolveWalletAddress(auth);
  const synapse = createSynapse(auth, isMainnet);

  info(`Querying ${isMainnet ? "mainnet" : "calibration"}...`);

  // Fetch FIL balance, USDFC balance, and deposit info in parallel
  const [filBalance, usdfcInfo, depositInfo] = await Promise.all([
    getBalance(synapse.client, { address: walletAddr }).catch(() => null),
    erc20Balance(synapse.client, { address: walletAddr }).catch(() => null),
    payAccounts(synapse.client, { address: walletAddr }).catch(() => null),
  ]);

  // Format values (18 decimals for FIL, variable for USDFC)
  const formatToken = (val: bigint, decimals: number) => {
    const whole = val / BigInt(10 ** decimals);
    const frac = val % BigInt(10 ** decimals);
    const fracStr = frac.toString().padStart(decimals, "0").slice(0, 4);
    return `${whole}.${fracStr}`;
  };

  if (jsonMode) {
    unmuteConsole();
    console.log(jsonStringify({
      address: walletAddr,
      network: isMainnet ? "mainnet" : "calibration",
      fil: filBalance !== null ? formatToken(filBalance, 18) : null,
      usdfc: usdfcInfo ? { balance: formatToken(usdfcInfo.value, usdfcInfo.decimals), symbol: usdfcInfo.symbol } : null,
      deposit: depositInfo ? {
        funds: formatToken(depositInfo.funds, 6),
        available: formatToken(depositInfo.availableFunds, 6),
        locked: formatToken(depositInfo.lockupCurrent, 6),
      } : null,
    }));
    return;
  }

  console.log("");
  label("Wallet", walletAddr);
  label("Network", isMainnet ? "Filecoin Mainnet" : "Calibration Testnet");
  console.log("");

  if (filBalance !== null) {
    label("FIL", `${formatToken(filBalance, 18)} FIL`);
  }
  if (usdfcInfo) {
    label(usdfcInfo.symbol, `${formatToken(usdfcInfo.value, usdfcInfo.decimals)} ${usdfcInfo.symbol}`);
  }
  console.log("");

  if (depositInfo) {
    label("Deposit", `${formatToken(depositInfo.funds, 6)} USDFC`);
    label("Available", `${formatToken(depositInfo.availableFunds, 6)} USDFC`);
    if (depositInfo.lockupCurrent > 0n) {
      label("Locked", `${formatToken(depositInfo.lockupCurrent, 6)} USDFC`);
    }
  } else {
    info("No deposit account found.");
  }
  console.log("");
}

async function runInfo(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    earlyExit(0);
  }

  const { values, positionals: pos } = parseArgs({
    args: args.slice(1),
    options: {
      calibration: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const jsonMode = values.json!;
  if (jsonMode) muteConsole();

  let cidStr = pos[0];
  if (!cidStr) {
    if (!process.stdin.isTTY) {
      fail("CID argument required.");
      info("Usage: nova info <cid>");
      earlyExit(1, "CID argument required.");
    }
    const input = await ask(promptLabel("IPFS CID:"));
    if (!input) {
      fail("CID required.");
      earlyExit(1, "CID required.");
    }
    cidStr = input;
  }
  close();

  const config = resolveConfig(process.env);
  if (!hasStorageAuth(config)) {
    fail("No Filecoin auth configured.");
    info("Set NOVA_SESSION_KEY + NOVA_WALLET_ADDRESS env vars.");
    earlyExit(1, "No Filecoin auth configured.");
  }

  const isMainnet = !values.calibration;
  const targetCid = toCidV1(cidStr);

  info(`Looking up ${cidStr}...`);
  const summaries = await listPieces({
    pinKey: config.pinKey,
    sessionKey: config.sessionKey,
    walletAddress: config.walletAddress,
    mainnet: isMainnet,
  });

  // Find matching groups across all datasets
  const matches: Array<{
    dataSetId: bigint;
    providerName: string;
    group: typeof summaries[0]["groups"][0];
  }> = [];

  for (const ds of summaries) {
    for (const g of ds.groups) {
      if (toCidV1(g.ipfsRootCID) === targetCid) {
        matches.push({ dataSetId: ds.dataSetId, providerName: ds.providerName, group: g });
      }
    }
  }

  if (matches.length === 0) {
    if (jsonMode) {
      unmuteConsole();
      console.log(JSON.stringify({ cid: cidStr, found: false }));
    } else {
      console.log("");
      info(`CID not found in any dataset.`);
      console.log("");
    }
    return;
  }

  if (jsonMode) {
    unmuteConsole();
    console.log(jsonStringify({
      cid: cidStr,
      found: true,
      matches: matches.map((m) => ({
        dataSetId: Number(m.dataSetId),
        providerName: m.providerName,
        pieces: m.group.totalPieces,
        size: m.group.totalRawSizeBytes ?? m.group.totalSizeBytes,
        label: m.group.label,
        createdAt: m.group.createdAt,
        lastProvenAt: m.group.lastProvenAt,
        totalProofsSubmitted: m.group.totalProofsSubmitted,
        pendingRemoval: m.group.pieces.some((p) => p.pendingRemoval),
      })),
    }));
    return;
  }

  console.log("");
  label("CID", cidStr);
  label("Gateway", `https://${targetCid}.ipfs.dweb.link`);
  console.log("");

  for (const m of matches) {
    const g = m.group;
    const pending = g.pieces.filter((p) => p.pendingRemoval).length;
    const displaySize = g.totalRawSizeBytes ?? g.totalSizeBytes;

    label("Dataset", `${m.dataSetId} (${m.providerName})`);
    label("Pieces", `${g.totalPieces}${pending > 0 ? ` (${pending} removing)` : ""}`);
    label("Size", formatSize(displaySize));
    if (g.label) label("Label", g.label);
    if (g.createdAt) label("Deployed", relativeTime(g.createdAt));
    if (g.lastProvenAt && g.lastProvenAt > 0) label("Last proven", relativeTime(g.lastProvenAt));
    if (g.totalProofsSubmitted && g.totalProofsSubmitted > 0) label("Proofs", String(g.totalProofsSubmitted));

    if (pending === g.totalPieces) {
      info(`${c.yellow}All pieces pending removal${c.reset}`);
    }
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
      "session-key": { type: "string" },
      "wallet-address": { type: "string" },
      calibration: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const jsonMode = values.json!;
  if (jsonMode) muteConsole();

  const config = resolveConfig(process.env);
  if (values["session-key"]) config.sessionKey = values["session-key"];
  if (values["wallet-address"]) config.walletAddress = values["wallet-address"];
  const mainnet = !values.calibration;

  if (!hasStorageAuth(config)) {
    if (!process.stdin.isTTY) {
      fail("No Filecoin auth configured.");
      info("Set NOVA_SESSION_KEY + NOVA_WALLET_ADDRESS env vars.");
      earlyExit(1, "No Filecoin auth configured.");
    }
    const chain = values.calibration ? "calibration" : "mainnet";
    const url = sessionKeySigningUrl(chain);
    console.log("");
    info("No session key found. Create one in your browser:");
    console.log("");
    info(`  ${link(url)}`);
    console.log("");
    const sk = await ask(promptLabel("Session key:"));
    if (!sk) {
      fail("Cannot manage without a session key.");
      earlyExit(1, "Cannot manage without a session key.");
    }
    const wa = await ask(promptLabel("Wallet address:"));
    if (!wa) {
      fail("Wallet address is required.");
      earlyExit(1, "Wallet address is required.");
    }
    config.sessionKey = sk;
    config.walletAddress = wa;
  }

  close();

  const subcommand = pos[0];

  if (!subcommand) {
    info(`Querying ${mainnet ? "mainnet" : "calibration"}...`);
    console.log("");

    const summaries = await listPieces({ pinKey: config.pinKey, sessionKey: config.sessionKey, walletAddress: config.walletAddress, mainnet });

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

      // Table layout — show extra columns only if subgraph data is available
      const hasTimestamps = ds.groups.some((g) => g.createdAt !== null);
      const hasProofs = ds.groups.some((g) => g.lastProvenAt !== null && g.lastProvenAt > 0);
      const cidW = 59;
      const pcsW = 5;
      const sizeW = 10;
      const statusW = 8;
      const deployedW = 9;
      const provenW = 9;

      let headerExtra = "";
      let dividerExtra = "";
      if (hasTimestamps) {
        headerExtra += `  ${center("Deployed", deployedW)}`;
        dividerExtra += `  ${"─".repeat(deployedW)}`;
      }
      if (hasProofs) {
        headerExtra += `  ${center("Proven", provenW)}`;
        dividerExtra += `  ${"─".repeat(provenW)}`;
      }
      const headerCols = `${center("CID", cidW)}  ${center("Pcs", pcsW)}  ${center("Size", sizeW)}  ${center("Status", statusW)}`;
      const dividerCols = `${"─".repeat(cidW)}  ${"─".repeat(pcsW)}  ${"─".repeat(sizeW)}  ${"─".repeat(statusW)}`;
      console.log(`  ${c.dim}${headerCols}${headerExtra}${c.reset}`);
      console.log(`  ${c.dim}${dividerCols}${dividerExtra}${c.reset}`);

      let totalSize = 0;

      for (let i = 0; i < ds.groups.length; i++) {
        const g = ds.groups[i];
        const isLatest = i === 0;
        const pendingCount = g.pieces.filter((p) => p.pendingRemoval).length;
        const allPending = pendingCount === g.totalPieces;
        let tag: string;
        if (allPending) {
          tag = `${c.dim}${center("removing", statusW)}${c.reset}`;
        } else {
          tag = isLatest ? `${c.green}${center("latest", statusW)}${c.reset}` : `${c.yellow}${center("old", statusW)}${c.reset}`;
        }
        const pcsStr = String(g.totalPieces);
        // Prefer raw size (actual data) over padded piece size
        const displaySize = g.totalRawSizeBytes ?? g.totalSizeBytes;
        const sizeStr = formatSize(displaySize);
        totalSize += displaySize;
        const cidLink = `\x1b]8;;https://${g.ipfsRootCID}.ipfs.dweb.link\x07${center(g.ipfsRootCID, cidW)}\x1b]8;;\x07`;
        const labelSuffix = g.label ? `  ${c.dim}${g.label}${c.reset}` : "";
        const deployedStr = hasTimestamps && g.createdAt ? `  ${c.dim}${center(relativeTime(g.createdAt), deployedW)}${c.reset}` : "";
        const provenStr = hasProofs && g.lastProvenAt ? `  ${c.dim}${center(relativeTime(g.lastProvenAt), provenW)}${c.reset}` : "";
        console.log(`  ${c.bold}${cidLink}${c.reset}  ${c.dim}${center(pcsStr, pcsW)}${c.reset}  ${c.dim}${center(sizeStr, sizeW)}${c.reset}  ${tag}${deployedStr}${provenStr}${labelSuffix}`);
      }

      if (ds.orphanPieces.length > 0) {
        const orphanSize = ds.orphanPieces.reduce((s, p) => s + p.sizeBytes, 0);
        totalSize += orphanSize;
        console.log(`  ${c.dim}${center("(no IPFS root CID)", cidW)}  ${center(String(ds.orphanPieces.length), pcsW)}  ${center(formatSize(orphanSize), sizeW)}${c.reset}  ${c.yellow}${center("orphan", statusW)}${c.reset}`);
      }

      // Totals row
      console.log(`  ${c.dim}${dividerCols}${dividerExtra}${c.reset}`);
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

    const summaries = await listPieces({ pinKey: config.pinKey, sessionKey: config.sessionKey, walletAddress: config.walletAddress, mainnet });
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
        const cidV1 = toCidV1(cid);
        if (!target.groups.find((g) => toCidV1(g.ipfsRootCID) === cidV1)) {
          fail(`CID not found in dataset: ${cid}`);
          earlyExit(1, `CID not found: ${cid}`);
        }
      }
      const removeSetV1 = new Set(removeCids.map(toCidV1));
      for (const g of target.groups) {
        if (removeSetV1.has(toCidV1(g.ipfsRootCID))) {
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

      // Validate all keep CIDs exist (normalize to v1 for comparison)
      const keepSetV1 = new Set([...keepSet].map(toCidV1));
      for (const cid of keepSet) {
        const cidV1 = toCidV1(cid);
        if (!target.groups.find((g) => toCidV1(g.ipfsRootCID) === cidV1)) {
          fail(`CID not found in dataset: ${cid}`);
          earlyExit(1, `CID not found: ${cid}`);
        }
      }

      for (const g of target.groups) {
        if (keepSetV1.has(toCidV1(g.ipfsRootCID))) {
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
      sessionKey: config.sessionKey,
      walletAddress: config.walletAddress,
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

async function runClone(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
  ${c.cyan}${c.bold}Nova Clone${c.reset} ${c.dim}- Clone a website and deploy to Filecoin${c.reset}

  ${c.bold}Usage${c.reset}

    ${c.cyan}nova clone${c.reset} <url> [options]

  ${c.bold}Options${c.reset}

    ${c.dim}--no-deploy${c.reset}           Clone only, don't deploy to Filecoin
    ${c.dim}--output <dir>${c.reset}        Output directory (default: ./domain-timestamp/)
    ${c.dim}--max-pages <n>${c.reset}       Max pages to crawl (default: 50, 0 = unlimited)
    ${c.dim}--screenshots${c.reset}         Save before/after screenshot comparison
    ${c.dim}--ens <name>${c.reset}          ENS domain to update after deploy
    ${c.dim}--clean${c.reset}               Remove old pieces after deploy
    ${c.dim}--calibration${c.reset}         Deploy to calibration testnet
    ${c.dim}--json${c.reset}                Output result as JSON

  ${c.bold}Examples${c.reset}

    ${c.dim}$${c.reset} nova clone https://example.com
    ${c.dim}$${c.reset} nova clone https://example.com --ens mysite.eth
    ${c.dim}$${c.reset} nova clone https://example.com --no-deploy --output ./cloned
    ${c.dim}$${c.reset} nova clone https://example.com --max-pages 10
`);
    earlyExit(0);
  }

  const { values, positionals: pos } = parseArgs({
    args: args.slice(1),
    options: {
      output: { type: "string" },
      "max-pages": { type: "string" },
      "no-deploy": { type: "boolean", default: false },
      screenshots: { type: "boolean", default: false },
      ens: { type: "string" },
      "rpc-url": { type: "string" },
      "provider-id": { type: "string" },
      "session-key": { type: "string" },
      "wallet-address": { type: "string" },
      label: { type: "string" },
      clean: { type: "boolean", default: false },
      calibration: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const jsonMode = values.json!;
  if (jsonMode) muteConsole();

  banner();

  let url = pos[0];
  if (!url) {
    if (!process.stdin.isTTY) {
      fail("URL argument required.");
      info("Usage: nova clone <url>");
      earlyExit(1, "URL argument required.");
    }
    console.log("");
    const input = await ask(promptLabel("Website URL to clone:"));
    if (!input) {
      fail("URL required.");
      earlyExit(1, "URL required.");
    }
    url = input;
  }

  // Ensure URL has protocol
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = `https://${url}`;
  }

  // Validate URL
  try {
    new URL(url);
  } catch {
    fail(`Invalid URL: ${url}`);
    earlyExit(1, `Invalid URL: ${url}`);
  }

  close();

  const maxPagesRaw = values["max-pages"];
  let maxPages: number | undefined;
  if (maxPagesRaw !== undefined) {
    const n = Number(maxPagesRaw);
    if (isNaN(n)) {
      fail(`Invalid max-pages: ${maxPagesRaw}`);
      earlyExit(1, `Invalid max-pages: ${maxPagesRaw}`);
    }
    maxPages = n;
  }

  console.log("");
  label("URL", url);
  if (values.output) label("Output", values.output);
  if (maxPages !== undefined) label("Pages", maxPages === 0 ? "unlimited" : `max ${maxPages}`);
  label("Deploy", values["no-deploy"] ? "no" : "yes");
  console.log("");

  // Clone
  const { clone } = await import("./clone.js");
  const cloneResult = await clone({
    url,
    output: values.output,
    maxPages,
    screenshots: !!values.screenshots,
  });

  console.log("");
  success(`Cloned ${cloneResult.pages} page(s), ${cloneResult.assets} asset(s), ${formatSize(cloneResult.totalSize)}`);
  label("Dir", cloneResult.directory);

  if (cloneResult.screenshots && cloneResult.screenshots.length > 0) {
    info(`Screenshots saved to ${cloneResult.directory}_screenshots/`);
  }

  // Deploy unless --no-deploy
  if (!values["no-deploy"]) {
    const config = resolveConfig(process.env);
    if (values["session-key"]) config.sessionKey = values["session-key"];
    if (values["wallet-address"]) config.walletAddress = values["wallet-address"];
    let ensName = values.ens || config.ensName;
    const isMainnet = !values.calibration;

    if (!hasStorageAuth(config)) {
      if (!process.stdin.isTTY) {
        fail("No Filecoin auth configured.");
        info("Use --no-deploy to clone without deploying, or set NOVA_SESSION_KEY + NOVA_WALLET_ADDRESS.");
        earlyExit(1, "No Filecoin auth configured.");
      }
      const chain = values.calibration ? "calibration" : "mainnet";
      const url = sessionKeySigningUrl(chain);
      console.log("");
      info("No session key found. Create one in your browser:");
      console.log("");
      info(`  ${link(url)}`);
      console.log("");
      const { ask: askPrompt, close: closePrompt } = await import("./prompt.js");
      const sk = await askPrompt(promptLabel("Session key:"));
      if (!sk) {
        closePrompt();
        fail("Cannot deploy without a session key.");
        info("Use --no-deploy to clone without deploying.");
        earlyExit(1, "Cannot deploy without a session key.");
      }
      const wa = await askPrompt(promptLabel("Wallet address:"));
      closePrompt();
      if (!wa) {
        fail("Wallet address is required.");
        earlyExit(1, "Wallet address is required.");
      }
      config.sessionKey = sk;
      config.walletAddress = wa;
      process.env.NOVA_SESSION_KEY = sk;
      process.env.NOVA_WALLET_ADDRESS = wa;
    }

    console.log("");
    const deployResult = await deploy({
      path: cloneResult.directory,
      pinKey: config.pinKey,
      sessionKey: config.sessionKey,
      walletAddress: config.walletAddress,
      ensName,
      ensKey: config.ensKey,
      rpcUrl: values["rpc-url"] || config.rpcUrl,
      providerId: values["provider-id"] ? Number(values["provider-id"]) : config.providerId,
      mainnet: isMainnet,
      label: values.label,
    });

    // Prompt for ENS if not provided
    if (!ensName && process.stdin.isTTY && !jsonMode) {
      const { ask: askEns, close: closeEns } = await import("./prompt.js");
      console.log("");
      const ensInput = await askEns(promptLabel("Point an ENS domain to this site? (leave blank to skip):"));
      closeEns();
      if (ensInput && ensInput.trim()) {
        ensName = ensInput.trim();
      }
    }

    // Post-deploy ENS via browser signing (when no ensKey)
    if (ensName && !config.ensKey && !deployResult.txHash) {
      const ensUrl = ensSigningUrl(ensName, deployResult.cid);
      console.log("");
      info(`Sign the ENS update in your browser:`);
      console.log("");
      info(`  ${link(ensUrl)}`);
      console.log("");

      if (process.stdin.isTTY && !jsonMode) {
        info("Waiting for ENS contenthash update...");
        const POLL_INTERVAL = 5_000;
        const POLL_TIMEOUT = 300_000;
        const start = Date.now();
        let confirmed = false;
        while (Date.now() - start < POLL_TIMEOUT) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL));
          const poll = await pollEnsContenthash(ensName, deployResult.cid, values["rpc-url"] || config.rpcUrl);
          if (poll.confirmed) {
            confirmed = true;
            deployResult.ensName = ensName;
            deployResult.ethLimoUrl = `https://${ensName.replace(/\.eth$/, "")}.eth.limo`;
            success(`ENS updated: ${c.bold}${deployResult.ethLimoUrl}${c.reset}`);
            break;
          }
          if (process.stderr.isTTY) {
            const elapsed = Math.round((Date.now() - start) / 1000);
            process.stderr.write(`\r  ${c.dim}Polling... ${elapsed}s${c.reset}`);
          }
        }
        if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
        if (!confirmed) {
          info("ENS update not detected within 5 minutes. You can sign it later at the URL above.");
        }
      }
    }

    // Post-deploy cleanup
    if (values.clean && hasStorageAuth(config)) {
      console.log("");
      info("Cleaning up old pieces...");
      try {
        const cleanResult = await cleanPieces({
          pinKey: config.pinKey,
          sessionKey: config.sessionKey,
          walletAddress: config.walletAddress,
          mainnet: isMainnet,
          keepCids: [deployResult.cid],
        });
        if (cleanResult.removed > 0) {
          success(`Removed ${cleanResult.removed} old piece(s)`);
        }
      } catch (err: any) {
        info(`Cleanup skipped: ${err.message}`);
      }
    }

    if (jsonMode) {
      unmuteConsole();
      console.log(JSON.stringify({
        sourceUrl: cloneResult.sourceUrl,
        pages: cloneResult.pages,
        assets: cloneResult.assets,
        cloneDir: cloneResult.directory,
        cid: deployResult.cid,
        gatewayUrl: `https://${deployResult.cid}.ipfs.dweb.link`,
        ...(deployResult.ensName && { ensName: deployResult.ensName }),
        ...(deployResult.txHash && { txHash: deployResult.txHash }),
        ...(deployResult.ethLimoUrl && { ethLimoUrl: deployResult.ethLimoUrl }),
      }));
    }
  } else {
    if (jsonMode) {
      unmuteConsole();
      console.log(JSON.stringify({
        sourceUrl: cloneResult.sourceUrl,
        pages: cloneResult.pages,
        assets: cloneResult.assets,
        directory: cloneResult.directory,
      }));
    } else {
      console.log("");
      info("Cloned without deploying. To deploy:");
      console.log(`    ${c.cyan}nova deploy${c.reset} ${cloneResult.directory}`);
      console.log("");
    }
  }
}


function isUrl(input: string): boolean {
  return /^https?:\/\//i.test(input) || /^[a-z0-9-]+\.[a-z]{2,}/i.test(input);
}

async function runDemo(args: string[]) {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
  ${c.cyan}${c.bold}nova demo${c.reset} ${c.dim}-- Try Nova instantly, no wallet needed${c.reset}

  ${c.bold}Usage${c.reset}

    ${c.cyan}nova demo${c.reset} <url>              Clone a website and deploy to calibnet
    ${c.cyan}nova demo${c.reset} <path>             Deploy a directory to calibnet

  ${c.bold}Options${c.reset}

    ${c.cyan}--ens${c.reset} <name>                  ENS domain to update after deploy
    ${c.cyan}--max-pages${c.reset} <n>              Max pages to crawl (default: 50)
    ${c.cyan}--json${c.reset}                       Output result as JSON

  ${c.bold}Examples${c.reset}

    ${c.dim}$${c.reset} nova demo filoz.org
    ${c.dim}$${c.reset} nova demo ./dist
    ${c.dim}$${c.reset} nova demo filoz.org --ens mysite.eth
    ${c.dim}$${c.reset} nova demo https://example.com --max-pages 10
`);
    earlyExit(0);
  }

  const { positionals: pos, values } = parseArgs({
    args: args.slice(1),
    options: {
      ens: { type: "string" },
      "max-pages": { type: "string" },
      "provider-id": { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const jsonMode = values.json!;
  if (jsonMode) muteConsole();

  banner();

  let input = pos[0];

  if (!input) {
    if (!process.stdin.isTTY) {
      fail("URL or path required.");
      info("Usage: nova demo <url-or-path>");
      earlyExit(1, "URL or path required.");
    }
    console.log("");
    const prompted = await ask(promptLabel("Website URL or directory to deploy:"));
    if (!prompted) {
      fail("URL or path required.");
      earlyExit(1, "URL or path required.");
    }
    input = prompted;
  }

  const isUrlInput = isUrl(input);
  let maxPages: number | undefined;
  if (values["max-pages"]) {
    const n = Number(values["max-pages"]);
    if (isNaN(n)) {
      fail(`Invalid max-pages: ${values["max-pages"]}`);
      earlyExit(1, `Invalid max-pages: ${values["max-pages"]}`);
    }
    maxPages = n;
  }

  console.log("");
  info(`${c.bold}Demo mode${c.reset} ${c.dim}-- free calibnet deploy, no wallet needed${c.reset}`);
  console.log("");
  if (isUrlInput) {
    label("URL", input);
  } else {
    const resolved = resolvePath(input);
    label("Path", resolved);
    label("Size", formatSize(dirSize(resolved)));
  }
  label("Net", "calibration (demo)");
  console.log("");

  if (process.stdin.isTTY) {
    const confirm = await ask(promptLabel(isUrlInput ? "Clone and deploy? [Y/n]" : "Deploy? [Y/n]"));
    if (confirm && confirm.toLowerCase() !== "y" && confirm !== "") {
      info("Cancelled.");
      earlyExit(0);
    }
  }

  close();

  const providerId = values["provider-id"] ? Number(values["provider-id"]) : undefined;
  const result = await demoDeploy(input, { maxPages, providerId });

  if (jsonMode) {
    unmuteConsole();
    originalLog(JSON.stringify({
      cid: result.cid,
      gatewayUrl: result.gatewayUrl,
      dwebUrl: result.dwebUrl,
      directory: result.directory,
      sourceUrl: result.sourceUrl,
      pages: result.pages,
      network: "calibration",
      demo: true,
      ...(values.ens && { ensUpdateUrl: `https://ens.focify.eth.limo/?name=${encodeURIComponent(values.ens)}&cid=${encodeURIComponent(result.cid)}` }),
    }));
  } else {
    // Ask about ENS after deploy
    let ensName = values.ens;
    if (!ensName && process.stdin.isTTY) {
      // Re-open prompt (close() was called before deploy)
      const { ask: askAgain, close: closeAgain } = await import("./prompt.js");
      console.log("");
      const ensInput = await askAgain(promptLabel("Point an ENS domain to this site? (leave blank to skip):"));
      closeAgain();
      if (ensInput && ensInput.trim()) {
        ensName = ensInput.trim();
      }
    }

    if (ensName) {
      const ensUrl = `https://ens.focify.eth.limo/?name=${encodeURIComponent(ensName)}&cid=${encodeURIComponent(result.cid)}`;
      console.log("");
      info(`Point ${c.bold}${ensName}${c.reset} to your site:`);
      console.log("");
      info(`  ${link(ensUrl)}`);
      console.log("");
      info(`${c.dim}Open the link above and sign the transaction with your Ethereum wallet.${c.reset}`);
    }
    console.log("");
    info(`${c.dim}This is a demo deploy on calibnet. For permanent hosting:${c.reset}`);
    info(`${c.dim}1. Create a session key: ${c.cyan}https://session.focify.eth.limo${c.reset}`);
    info(`${c.dim}2. Run: ${c.cyan}nova deploy${result.sourceUrl ? "" : " " + input}${c.reset}`);
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
    case "demo":
      await runDemo(args);
      break;
    case "deploy":
      await runDeploy(args);
      break;
    case "clone":
      await runClone(args);
      break;
    case "ens":
      await runEns(args);
      break;
    case "info":
      await runInfo(args);
      break;
    case "wallet":
      await runWallet(args);
      break;
    case "download":
      await runDownload(args);
      break;
    case "status":
      await runStatus(args);
      break;
    case "manage":
      await runManage(args);
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
