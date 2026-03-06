import { pinToFoc, ensureFilecoinPin } from "./pin.js";
import { updateEnsContenthash } from "./ens.js";
import { deployComplete, step, success, info, c } from "./ui.js";

function elapsed(start: number): string {
  const s = ((Date.now() - start) / 1000).toFixed(1);
  return `${c.dim}(${s}s)${c.reset}`;
}

export interface DeployConfig {
  directory: string;
  pinKey?: string;
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
  directory: string;
}

/**
 * Deploy a static website to Filecoin Onchain Cloud.
 * Optionally update ENS contenthash to point to the new CID.
 */
export async function deploy(config: DeployConfig): Promise<DeployResult> {
  await ensureFilecoinPin();

  // Allow library callers to pass pinKey directly (explicit config wins)
  if (config.pinKey) {
    process.env.NOVA_PIN_KEY = config.pinKey;
  }

  if (config.ensName && !config.ensKey) {
    throw new Error(
      "NOVA_ENS_KEY env var required to point your ENS domain to your website.\n\n" +
        "  export NOVA_ENS_KEY=your-ethereum-wallet-private-key"
    );
  }

  const totalSteps = config.ensName ? 2 : 1;
  console.log("");
  step(1, totalSteps, "Deploying to Filecoin Onchain Cloud");
  console.log("");
  const t1 = Date.now();
  const pinResult = await pinToFoc({
    directory: config.directory,
    providerId: config.providerId,
    mainnet: config.mainnet,
  });
  success(`Done ${elapsed(t1)}`);

  const result: DeployResult = {
    cid: pinResult.cid,
    directory: config.directory,
  };

  if (config.ensName && config.ensKey) {
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

  // Quick gateway verification — non-blocking, doesn't fail the deploy
  await verifyGateway(result.cid);

  return result;
}

const VERIFY_TIMEOUT_MS = 15_000;
const GATEWAY_URL = "https://dweb.link/ipfs/";

async function verifyGateway(cid: string): Promise<void> {
  info("Verifying content is reachable...");
  try {
    const url = `${GATEWAY_URL}${cid}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

    const res = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      success("Content verified — live on IPFS gateway");
    } else {
      info(`Gateway returned ${res.status} — content may take a few minutes to propagate.`);
    }
  } catch {
    info("Gateway not responding yet — content may take a few minutes to propagate.");
  }
}
