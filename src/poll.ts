/**
 * On-chain state polling for browser wallet signing flows.
 * Shared by both CLI and MCP -- no private keys needed, just read-only RPC calls.
 */

import { ethers, Network } from "ethers";
import { CID } from "multiformats/cid";
import { createClient, http } from "viem";
import { filecoin, filecoinCalibration } from "viem/chains";

export interface PollResult {
  confirmed: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

// --- ENS contenthash polling ---

const ENS_RPC_URLS = [
  "https://ethereum.publicnode.com",
  "https://eth.drpc.org",
  "https://mainnet.gateway.tenderly.co",
  "https://eth.merkle.io",
];

/**
 * Poll ENS contenthash until it matches the target CID.
 */
export async function pollEnsContenthash(
  ensName: string,
  targetCid: string,
  rpcUrl?: string
): Promise<PollResult> {
  const rpcUrls = rpcUrl ? [rpcUrl] : ENS_RPC_URLS;
  const network = Network.from("mainnet");

  // Normalize target CID to v1
  let targetV1: string;
  try {
    targetV1 = CID.parse(targetCid).toV1().toString();
  } catch {
    return { confirmed: false, error: `Invalid CID: ${targetCid}` };
  }

  const providers = rpcUrls.map(
    (url) => new ethers.JsonRpcProvider(url, network, { staticNetwork: network })
  );

  try {
    const result = await Promise.any(
      providers.map(async (provider) => {
        const resolver = await Promise.race([
          provider.getResolver(ensName),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 10_000)),
        ]);
        if (!resolver) return null;
        const hash = await Promise.race([
          resolver.getContentHash(),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 10_000)),
        ]);
        return hash;
      })
    );

    if (!result) {
      return { confirmed: false, result: { currentContenthash: null } };
    }

    // result is like "ipfs://bafybei..."
    const currentCid = result.startsWith("ipfs://") ? result.slice(7) : result;
    let currentV1: string;
    try {
      currentV1 = CID.parse(currentCid).toV1().toString();
    } catch {
      currentV1 = currentCid;
    }

    if (currentV1 === targetV1) {
      const ethLimoUrl = `https://${ensName.replace(/\.eth$/, "")}.eth.limo`;
      return {
        confirmed: true,
        result: { ensName, cid: targetCid, ethLimoUrl },
      };
    }

    return {
      confirmed: false,
      result: { currentCid: currentCid || null, targetCid },
    };
  } catch {
    return { confirmed: false, error: "Could not reach any Ethereum RPC" };
  } finally {
    for (const p of providers) p.destroy();
  }
}

const FIL_RPC: Record<string, string> = {
  mainnet: "https://api.node.glif.io/rpc/v1",
  calibration: "https://api.calibration.node.glif.io/rpc/v1",
};

// --- Wallet authorization polling ---

const SESSION_KEY_REGISTRY: Record<string, `0x${string}`> = {
  mainnet: "0x74FD50525A958aF5d484601E252271f9625231aB",
  calibration: "0x518411c2062E119Aaf7A8B12A2eDf9a939347655",
};

/**
 * Poll whether an ephemeral key has been authorized on-chain.
 * Returns the wallet address that authorized it (from the Login event).
 */
export async function pollWalletAuth(
  ephemeralAddress: string,
  chain: "mainnet" | "calibration"
): Promise<PollResult> {
  const registryAddr = SESSION_KEY_REGISTRY[chain];
  const rpcUrl = FIL_RPC[chain];

  if (!registryAddr) {
    return { confirmed: false, error: `Unknown chain: ${chain}` };
  }

  try {
    const viemChain = chain === "mainnet" ? filecoin : filecoinCalibration;
    const client = createClient({ chain: viemChain, transport: http(rpcUrl) });

    const latestBlock = await client.request({ method: "eth_blockNumber" });
    const latest = Number(latestBlock);
    const fromBlock = `0x${Math.max(0, latest - 2000).toString(16)}` as `0x${string}`;

    // Login event: Login(address indexed root, address indexed signer, ...)
    const logs = await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: registryAddr,
          topics: [
            null, // Login event signature
            null, // root (any -- we extract this)
            `0x000000000000000000000000${ephemeralAddress.slice(2).toLowerCase()}` as `0x${string}`,
          ],
          fromBlock,
          toBlock: "latest",
        },
      ],
    });

    if (logs && (logs as any[]).length > 0) {
      // Extract wallet address from the first indexed topic (root)
      const log = (logs as any[])[0];
      const rootTopic = log.topics?.[1] as string;
      const walletAddress = rootTopic
        ? `0x${rootTopic.slice(26)}` as `0x${string}`
        : undefined;

      return {
        confirmed: true,
        result: {
          walletAddress,
          ephemeralAddress,
          chain,
        },
      };
    }

    return { confirmed: false };
  } catch (err: any) {
    return { confirmed: false, error: err.message };
  }
}

// --- Generic transaction receipt polling ---

/**
 * Poll for a transaction receipt by hash.
 */
export async function pollTxReceipt(
  txHash: string,
  chain: "mainnet" | "calibration" | "ethereum"
): Promise<PollResult> {
  try {
    if (chain === "ethereum") {
      const network = Network.from("mainnet");
      const provider = new ethers.JsonRpcProvider(ENS_RPC_URLS[0], network, {
        staticNetwork: network,
      });
      try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (receipt && receipt.blockNumber) {
          return {
            confirmed: true,
            result: {
              txHash,
              blockNumber: receipt.blockNumber,
              status: receipt.status === 1 ? "success" : "reverted",
            },
          };
        }
        return { confirmed: false, result: { txHash } };
      } finally {
        provider.destroy();
      }
    }

    // Filecoin chains
    const rpcUrl = FIL_RPC[chain];
    if (!rpcUrl) {
      return { confirmed: false, error: `Unknown chain: ${chain}` };
    }

    const viemChain = chain === "mainnet" ? filecoin : filecoinCalibration;
    const client = createClient({ chain: viemChain, transport: http(rpcUrl) });

    const receipt = await client.request({
      method: "eth_getTransactionReceipt",
      params: [txHash as `0x${string}`],
    });

    if (receipt) {
      return {
        confirmed: true,
        result: {
          txHash,
          blockNumber: Number(receipt.blockNumber),
          status: receipt.status === "0x1" ? "success" : "reverted",
        },
      };
    }

    return { confirmed: false, result: { txHash } };
  } catch (err: any) {
    return { confirmed: false, error: err.message };
  }
}
