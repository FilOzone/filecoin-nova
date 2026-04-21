/**
 * `nova site deploy` — one idempotent command.
 *
 * Reads a deploy.json, pins <dist> to FOC, and (optionally) hosts the
 * result at a user-owned hostname via a Cloudflare Worker, writes a
 * DNSLink TXT record, and updates an ENS contenthash. Every field is
 * optional; nova skips any step whose config or secret is missing.
 *
 * On first invocation with a hostname + cf_zone_id, nova also
 * auto-provisions the bundled gateway Worker + KV namespace in the
 * user's own Cloudflare account. Subsequent deploys are idempotent
 * no-ops for provisioning; only the KV + DNSLink + ENS updates fire.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deploy } from "./deploy.js";
import { updateEnsContenthash } from "./ens.js";
import {
  ensureKvNamespace,
  ensureProxiedARecord,
  ensureWorkerRoute,
  kvPut,
  resolveAccount,
  uploadWorkerScript,
  upsertTxt,
} from "./cloudflare.js";
import { loadBundledWorker } from "./worker-asset.js";
import { step, success, info, c } from "./ui.js";

export interface DeployJson {
  /** Hostname to host the site at (e.g. "test1.com"). If omitted, no CF hosting. */
  hostname?: string;
  /** CF zone id that owns `hostname`. Required when `hostname` is set. */
  cf_zone_id?: string;
  /** CF account id — overrides auto-detection from the API token. */
  cf_account_id?: string;
  /** ENS name to update contenthash on (e.g. "test1.eth"). Skipped if unset. */
  ens_name?: string;
  /** Site source dir, resolved relative to deploy.json. If unset, defaults to "dist". */
  dist?: string;
  /** Per-path API proxy rules written into the Worker KV entry. */
  apiProxy?: Record<string, string>;
  /** Optional DNSLink opt-out; defaults to true when `hostname` set. */
  dnslink?: boolean;
}

export interface SiteDeployConfig {
  /** Path to deploy.json. */
  sitePath: string;
  /** Distribution directory; overrides deploy.json.dist if set. */
  distOverride?: string;
  pinKey?: string;
  walletAddress?: string;
  ensKey?: string;
  rpcUrl?: string;
  cloudflareToken?: string;
  workerScriptName?: string;
  kvNamespaceTitle?: string;
  /** Existing KV namespace id; if set, skips ensureKvNamespace. */
  kvNamespaceId?: string;
  /** When "skip", don't upload the Worker script (reuse whatever's deployed). */
  workerUpload?: "auto" | "skip" | "force";
  compatibilityDate?: string;
  mainnet?: boolean;
}

export interface SiteDeployResult {
  cid: string;
  hostname?: string;
  hostedUrl?: string;
  ensName?: string;
  ensTx?: string;
  dnsLinkRecord?: string;
}

const DEFAULT_WORKER_NAME = "filecoin-nova-gateway";
const DEFAULT_KV_TITLE = "filecoin-nova-gateway-kv";
const DEFAULT_COMPAT_DATE = "2026-04-01";

function readDeployJson(path: string): DeployJson {
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as DeployJson;
  } catch (err) {
    throw new Error(`Invalid JSON in ${path}: ${(err as Error).message}`);
  }
}

export async function siteDeploy(cfg: SiteDeployConfig): Promise<SiteDeployResult> {
  const sitePath = resolve(cfg.sitePath);
  const siteDir = sitePath.endsWith("deploy.json")
    ? sitePath.replace(/\/deploy\.json$/, "")
    : sitePath;
  const deployJsonPath = siteDir === sitePath ? `${sitePath}/deploy.json` : sitePath;
  const site = readDeployJson(deployJsonPath);

  const dist = resolve(siteDir, cfg.distOverride || site.dist || "dist");

  const willHost = Boolean(site.hostname);
  const willEns = Boolean(site.ens_name);

  if (willHost && !site.cf_zone_id) {
    throw new Error(`deploy.json has hostname but no cf_zone_id: ${deployJsonPath}`);
  }
  if (willHost && !cfg.cloudflareToken) {
    info(`CLOUDFLARE_API_TOKEN not set — skipping CF hosting for ${site.hostname}`);
  }
  if (willEns && !cfg.ensKey) {
    info(`NOVA_ENS_KEY not set — skipping ENS update for ${site.ens_name}`);
  }

  // Step 1: pin to FOC
  info(`Deploying ${dist}`);
  const pinResult = await deploy({
    path: dist,
    pinKey: cfg.pinKey,
    walletAddress: cfg.walletAddress,
    mainnet: cfg.mainnet ?? true,
    label: site.hostname || site.ens_name,
  });
  const cid = pinResult.cid;
  const result: SiteDeployResult = { cid };

  // Step 2: optional — CF hosting
  if (willHost && cfg.cloudflareToken && site.cf_zone_id) {
    const token = cfg.cloudflareToken;
    const hostname = site.hostname as string;
    const scriptName = cfg.workerScriptName || DEFAULT_WORKER_NAME;
    const kvTitle = cfg.kvNamespaceTitle || DEFAULT_KV_TITLE;

    const { accountId } = site.cf_account_id
      ? { accountId: site.cf_account_id }
      : await resolveAccount(token);

    // Ensure KV exists (or reuse one whose id was passed in).
    const kvId = cfg.kvNamespaceId
      ? cfg.kvNamespaceId
      : await ensureKvNamespace(token, accountId, kvTitle);

    // Upload Worker script unless the caller opted out (reusing an existing Worker).
    if ((cfg.workerUpload ?? "auto") !== "skip") {
      const workerSource = loadBundledWorker();
      await uploadWorkerScript(token, accountId, scriptName, workerSource, {
        compatibilityDate: cfg.compatibilityDate || DEFAULT_COMPAT_DATE,
        kvBindings: [{ name: "CIDS", namespaceId: kvId }],
      });
    }

    // Ensure DNS record + route exist.
    const createdA = await ensureProxiedARecord(
      token,
      site.cf_zone_id,
      hostname,
      `Worker route placeholder — ${scriptName}`,
    );
    if (createdA) info(`  created proxied A record for ${hostname}`);
    const createdRoute = await ensureWorkerRoute(
      token,
      site.cf_zone_id,
      `${hostname}/*`,
      scriptName,
    );
    if (createdRoute) info(`  created Worker route ${hostname}/*`);

    // Write KV entry.
    await kvPut(token, accountId, kvId, hostname, cid);
    success(`  KV: ${hostname} → ${cid}`);
    result.hostname = hostname;
    result.hostedUrl = `https://${hostname}`;

    // DNSLink TXT (unless opted out).
    if (site.dnslink !== false) {
      const record = `_dnslink.${hostname}`;
      await upsertTxt(token, site.cf_zone_id, record, `dnslink=/ipfs/${cid}`);
      success(`  DNSLink: ${record}`);
      result.dnsLinkRecord = record;
    }
  }

  // Step 3: optional — ENS
  if (willEns && cfg.ensKey && site.ens_name) {
    info(`Updating ENS contenthash: ${site.ens_name}`);
    const ens = await updateEnsContenthash(
      {
        ensName: site.ens_name,
        privateKey: cfg.ensKey,
        rpcUrl: cfg.rpcUrl,
      },
      cid,
    );
    success(`  ENS: ${ens.ensName} tx ${ens.txHash}`);
    result.ensName = ens.ensName;
    result.ensTx = ens.txHash;
  }

  console.log("");
  success(`Site deployed: ${c.bold}${cid}${c.reset}`);
  if (result.hostedUrl) info(`  ${result.hostedUrl}`);
  if (result.ensName) info(`  https://${result.ensName.replace(/\.eth$/, "")}.eth.limo`);

  return result;
}
