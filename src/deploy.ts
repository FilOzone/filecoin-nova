import { existsSync, readdirSync, statSync, lstatSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";
import { pinToFoc, ensureFilecoinPin, installFilecoinPin, isFilecoinPinInstalled } from "./pin.js";
import { updateEnsContenthash } from "./ens.js";
import { isArchive, extractArchive, cleanupExtracted } from "./archive.js";
import { deployComplete, step, success, info, c } from "./ui.js";

function elapsed(start: number): string {
  const s = ((Date.now() - start) / 1000).toFixed(1);
  return `${c.dim}(${s}s)${c.reset}`;
}

export interface DeployConfig {
  /** Path to a directory or archive (.zip, .tar.gz, .tgz, .tar) */
  path: string;
  pinKey?: string;
  sessionKey?: string;
  walletAddress?: string;
  ensName?: string;
  ensKey?: string;
  rpcUrl?: string;
  providerId?: number;
  mainnet?: boolean;
}

export interface DeployResult {
  cid: string;
  ensName?: string;
  txHash?: string;
  ethLimoUrl?: string;
  /** The directory that was actually deployed (may differ from input if archive) */
  directory: string;
}

export function dirSize(dir: string, seen = new Set<number>()): number {
  let total = 0;
  try {
    const dirStat = lstatSync(dir);
    if (seen.has(dirStat.ino)) return 0;
    seen.add(dirStat.ino);

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          total += dirSize(p, seen);
        } else {
          total += statSync(p).size;
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Skip directories we can't read
  }
  return total;
}

/**
 * Resolve a user-provided path: expand ~, make absolute, verify exists.
 */
function resolvePath(input: string): string {
  let p = input;
  if (p === "~") {
    p = homedir();
  } else if (p.startsWith("~/")) {
    p = join(homedir(), p.slice(2));
  }
  p = resolve(p);
  if (!existsSync(p)) {
    throw new Error(`Not found: ${p}`);
  }
  return p;
}

/**
 * Deploy a static website to Filecoin Onchain Cloud.
 * Accepts directories or archives (.zip, .tar.gz, .tgz, .tar).
 * Optionally update ENS contenthash to point to the new CID.
 */
export async function deploy(config: DeployConfig): Promise<DeployResult> {
  // 1. Ensure filecoin-pin is installed
  const fpVersion = await isFilecoinPinInstalled();
  if (!fpVersion) {
    info("Installing filecoin-pin (first time only)...");
    await installFilecoinPin();
  } else {
    await ensureFilecoinPin();
  }

  // Allow library callers to pass auth directly via env vars
  if (config.sessionKey && config.walletAddress) {
    process.env.NOVA_SESSION_KEY = config.sessionKey;
    process.env.NOVA_WALLET_ADDRESS = config.walletAddress;
  } else if (config.pinKey) {
    process.env.NOVA_PIN_KEY = config.pinKey;
  }

  // If ENS requested but no key, skip ENS step (caller handles browser signing flow)
  const skipEns = !!(config.ensName && !config.ensKey);

  // 2. Resolve path, handle archives
  const resolvedPath = resolvePath(config.path);
  let extractedDir: string | undefined;
  let deployDir = resolvedPath;

  if (isArchive(resolvedPath)) {
    info(`Extracting ${basename(resolvedPath)}...`);
    extractedDir = await extractArchive(resolvedPath);
    deployDir = extractedDir;
  }

  try {
    // 3. Check for empty directory
    const bytes = dirSize(deployDir);
    if (bytes === 0) {
      throw new Error(
        extractedDir
          ? `Archive is empty: ${basename(resolvedPath)}`
          : `Directory is empty: ${resolvedPath}`
      );
    }

    // 4. Deploy
    const totalSteps = (config.ensName && !skipEns) ? 2 : 1;
    console.log("");
    step(1, totalSteps, "Deploying to Filecoin Onchain Cloud");
    console.log("");
    const t1 = Date.now();
    const pinResult = await pinToFoc({
      directory: deployDir,
      providerId: config.providerId,
      mainnet: config.mainnet,
      sessionKey: config.sessionKey,
      walletAddress: config.walletAddress,
    });
    success(`Done ${elapsed(t1)}`);

    const result: DeployResult = {
      cid: pinResult.cid,
      directory: deployDir,
    };

    // 5. ENS update (optional -- skipped if no key, caller handles browser signing)
    if (config.ensName && config.ensKey && !skipEns) {
      console.log("");
      step(2, totalSteps, "Pointing ENS domain to website");
      console.log("");
      const t2 = Date.now();
      try {
        const ensResult = await updateEnsContenthash(
          {
            ensName: config.ensName,
            privateKey: config.ensKey,
            rpcUrl: config.rpcUrl,
          },
          pinResult.cid
        );

        result.ensName = ensResult.ensName;
        result.txHash = ensResult.txHash;
        result.ethLimoUrl = ensResult.ethLimoUrl;
        success(`Done ${elapsed(t2)}`);
      } catch (err: any) {
        // Deploy succeeded but ENS failed — show the CID before re-throwing
        deployComplete(result);
        throw err;
      }
    }

    deployComplete(result);

    return result;
  } finally {
    if (extractedDir) {
      await cleanupExtracted(extractedDir);
    }
  }
}

