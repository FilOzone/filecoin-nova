import { ethers, TransactionResponse, TransactionReceipt, Network, FallbackProvider } from "ethers";
import { CID } from "multiformats/cid";
import { c, gutterTop, gutterBottom } from "./ui.js";

const TX_TIMEOUT_MS = 120_000; // 2 minutes
const TX_POLL_MS = 5_000; // poll every 5s

/**
 * Wait for a transaction receipt with timeout and polling fallback.
 * ethers v6 tx.wait() can hang on some RPC endpoints.
 */
async function waitForTx(
  tx: TransactionResponse,
  provider: ethers.AbstractProvider
): Promise<TransactionReceipt> {
  const deadline = Date.now() + TX_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (receipt && receipt.blockNumber) {
        if (receipt.status === 0) {
          throw new Error(
            `Transaction reverted on-chain.\n\n` +
              `  tx: ${tx.hash}\n` +
              `  Check at: https://etherscan.io/tx/${tx.hash}`
          );
        }
        return receipt;
      }
    } catch (err: any) {
      // Re-throw our own revert error
      if (err.message?.includes("reverted on-chain")) throw err;
      // Ignore RPC errors — keep polling
    }
    await new Promise((r) => setTimeout(r, TX_POLL_MS));
  }

  throw new Error(
    `Transaction not confirmed within ${TX_TIMEOUT_MS / 1000}s.\n` +
      `  It may have been dropped (gas too low) or is still pending.\n\n` +
      `  tx: ${tx.hash}\n` +
      `  Check status at: https://etherscan.io/tx/${tx.hash}`
  );
}

const RESOLVER_ABI = [
  "function setContenthash(bytes32 node, bytes calldata hash) external",
  "function contenthash(bytes32 node) external view returns (bytes)",
];

const ENS_REGISTRY_ABI = [
  "function setSubnodeRecord(bytes32 node, bytes32 label, address owner, address resolver, uint64 ttl) external",
  "function owner(bytes32 node) external view returns (address)",
  "function resolver(bytes32 node) external view returns (address)",
];

const NAME_WRAPPER_ABI = [
  "function ownerOf(uint256 id) external view returns (address)",
];

// ENS registry is at a fixed address on mainnet
const ENS_REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
// ENS NameWrapper
const NAME_WRAPPER = "0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401";
// ENS public resolver v2
const PUBLIC_RESOLVER = "0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63";

const DEFAULT_RPC_URLS = [
  "https://ethereum.publicnode.com",     // Allnodes — major validator/infra company
  "https://eth.drpc.org",                // dRPC — dedicated RPC infrastructure
  "https://mainnet.gateway.tenderly.co", // Tenderly — established dev tooling company
  "https://eth.merkle.io",               // Merkle — RPC infrastructure provider
  "https://ethereum-rpc.publicnode.com",  // Allnodes — alternate endpoint
];

// Gutter-aware versions of UI functions for ENS step
const gSuccess = (text: string) => console.log(`  ${c.dim}┃${c.reset}  ${c.green}✔${c.reset} ${text}`);
const gWorking = (text: string) => console.log(`  ${c.dim}┃${c.reset}  ${c.yellow}⏳${c.reset} ${text}`);
const gInfo = (text: string) => console.log(`  ${c.dim}┃${c.reset}  ${c.dim}${text}${c.reset}`);

export interface EnsConfig {
  ensName: string;
  privateKey: string;
  rpcUrl?: string;
}

export interface EnsResult {
  txHash: string;
  ensName: string;
  contenthash: string;
  ethLimoUrl: string;
}

/**
 * Parse ethers/ENS errors into user-friendly messages.
 */
function friendlyEnsError(err: any, ensName: string): string {
  const msg = (err.message || "").toLowerCase();
  const code = err.code || "";

  // Network errors FIRST — RPC failures can masquerade as CALL_EXCEPTION
  if (
    msg.includes("could not detect network") ||
    msg.includes("failed to detect network") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("network error") ||
    msg.includes("fetch failed") ||
    msg.includes("retry in") ||
    code === "NETWORK_ERROR" ||
    code === "SERVER_ERROR"
  ) {
    return (
      `ENS update failed: Ethereum RPC connection dropped.\n\n` +
      "  The RPC endpoint became unreliable mid-operation.\n" +
      "  Try again, or use a different RPC with --rpc-url."
    );
  }

  if (msg.includes("insufficient funds") || code === "INSUFFICIENT_FUNDS") {
    return (
      `ENS update failed: Insufficient ETH for gas.\n\n` +
      "  Your Ethereum wallet needs ETH to pay for the transaction.\n" +
      "  Send some ETH to your wallet and try again."
    );
  }

  if (msg.includes("nonce") || code === "NONCE_EXPIRED") {
    return (
      `ENS update failed: Transaction nonce conflict.\n\n` +
      "  A previous transaction may still be pending.\n" +
      "  Wait a few minutes and try again."
    );
  }

  if (msg.includes("execution reverted") || code === "CALL_EXCEPTION") {
    return (
      `ENS update failed: Transaction reverted.\n\n` +
      `  Your wallet may not have permission to update ${ensName}.\n` +
      "  Make sure the wallet is the owner or manager of the ENS name.\n" +
      `  Check at: https://app.ens.domains/${ensName}`
    );
  }

  if (msg.includes("invalid private key") || msg.includes("invalid arrayify")) {
    return (
      `ENS update failed: Invalid Ethereum wallet key.\n\n` +
      "  Check the NOVA_ENS_KEY env var."
    );
  }

  // Fallback
  return `ENS update failed: ${err.message}`;
}

/**
 * Check if an ENS name is a subdomain (more than 2 labels).
 */
function isSubdomain(ensName: string): boolean {
  return ensName.split(".").length > 2;
}

/**
 * Get the parent name and label from a subdomain.
 */
function splitSubdomain(ensName: string): { parent: string; label: string } {
  const parts = ensName.split(".");
  return {
    label: parts[0],
    parent: parts.slice(1).join("."),
  };
}

/**
 * Create an ENS subdomain and set its resolver.
 */
async function ensureSubdomain(
  ensName: string,
  wallet: ethers.Wallet,
  provider: ethers.AbstractProvider
): Promise<void> {
  const registry = new ethers.Contract(ENS_REGISTRY, ENS_REGISTRY_ABI, wallet);
  const node = ethers.namehash(ensName);

  // Check if subdomain already has a resolver
  const existingResolver = await registry.resolver(node);
  if (existingResolver !== ethers.ZeroAddress) {
    gSuccess(`Subdomain ${c.bold}${ensName}${c.reset} exists`);
    return;
  }

  const { parent, label } = splitSubdomain(ensName);
  const parentNode = ethers.namehash(parent);

  // Verify wallet owns the parent (check both registry and NameWrapper)
  const parentOwner = await registry.owner(parentNode);
  let isOwner = parentOwner.toLowerCase() === wallet.address.toLowerCase();

  // If NameWrapper owns the registry entry, check NameWrapper for the real owner
  const isWrapped = parentOwner.toLowerCase() === NAME_WRAPPER.toLowerCase();
  if (!isOwner && isWrapped) {
    try {
      const nameWrapper = new ethers.Contract(NAME_WRAPPER, NAME_WRAPPER_ABI, provider);
      const wrappedOwner = await nameWrapper.ownerOf(parentNode);
      isOwner = wrappedOwner.toLowerCase() === wallet.address.toLowerCase();
    } catch {
      // NameWrapper query failed — fall through to ownership error
    }
  }

  if (!isOwner) {
    throw new Error(
      `Cannot create subdomain ${ensName}.\n\n` +
        `  Your wallet (${wallet.address}) does not own ${parent}.\n` +
        `  The owner is ${parentOwner}.\n` +
        `  Check at: https://app.ens.domains/${parent}`
    );
  }

  // Wrapped names can't create subdomains via registry — must use ENS app
  if (isWrapped) {
    throw new Error(
      `Cannot create subdomain ${ensName} programmatically.\n\n` +
        `  ${parent} is a wrapped ENS name (NameWrapper).\n` +
        `  Wrapped names require creating subdomains through the ENS app first.\n\n` +
        `  1. Go to https://app.ens.domains/${parent}\n` +
        `  2. Create the subdomain "${label}" manually\n` +
        `  3. Then run nova deploy again to set the contenthash`
    );
  }

  gWorking(`Creating subdomain ${c.bold}${label}${c.reset}.${parent}`);
  const labelHash = ethers.keccak256(ethers.toUtf8Bytes(label));

  const tx = await registry.setSubnodeRecord(
    parentNode,
    labelHash,
    wallet.address,
    PUBLIC_RESOLVER,
    0
  );

  gInfo(`tx: ${tx.hash}`);
  gWorking("Waiting for confirmation...");
  await waitForTx(tx, provider);
  gSuccess("Subdomain created");
}

/**
 * Encode an IPFS CID into the ENS contenthash format (EIP-1577).
 */
export function encodeIpfsContenthash(cid: string): string {
  // Parse and ensure CIDv1
  let parsed = CID.parse(cid);
  if (parsed.version === 0) {
    parsed = parsed.toV1();
  }
  const cidBytes = parsed.bytes;

  // EIP-1577: 0xe3 0x01 (IPFS namespace as varint) + CID bytes
  const encoded = new Uint8Array(2 + cidBytes.length);
  encoded[0] = 0xe3;
  encoded[1] = 0x01;
  encoded.set(cidBytes, 2);

  return ethers.hexlify(encoded);
}

/**
 * Update the ENS contenthash for a given name to point to an IPFS CID.
 * Automatically creates subdomains if needed.
 */
export async function updateEnsContenthash(
  config: EnsConfig,
  ipfsCid: string
): Promise<EnsResult> {
  const rpcUrls = config.rpcUrl ? [config.rpcUrl] : DEFAULT_RPC_URLS;
  const mainnetNetwork = Network.from("mainnet");

  gutterTop("ENS update");

  // Connect to Ethereum — probe RPCs, build FallbackProvider with ALL of them
  // (live ones get high priority, dead ones stay as failover backup)
  let provider!: FallbackProvider | ethers.JsonRpcProvider;
  const RPC_CONNECT_ATTEMPTS = 2;
  const RPC_PROBE_TIMEOUT_MS = 5000;

  for (let attempt = 1; attempt <= RPC_CONNECT_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      gInfo("Retrying RPC connection...");
      await new Promise((r) => setTimeout(r, 2000));
    }

    try {
      // Build providers for all RPCs
      const allProviders = rpcUrls.map((url) =>
        new ethers.JsonRpcProvider(url, mainnetNetwork, {
          staticNetwork: mainnetNetwork,
        })
      );

      if (rpcUrls.length === 1) {
        await Promise.race([
          allProviders[0].getBlockNumber(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), RPC_PROBE_TIMEOUT_MS)),
        ]);
        provider = allProviders[0];
        gSuccess(`Connected to Ethereum ${c.dim}(${new URL(rpcUrls[0]).hostname})${c.reset}`);
        break;
      }

      // Probe each RPC with a timeout to find which are live
      const liveSet = new Set<number>();
      const errors: string[] = [];

      await Promise.allSettled(
        allProviders.map(async (p, i) => {
          try {
            await Promise.race([
              p.getBlockNumber(),
              new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), RPC_PROBE_TIMEOUT_MS)),
            ]);
            liveSet.add(i);
          } catch (err: any) {
            const host = new URL(rpcUrls[i]).hostname;
            errors.push(`${host}: ${err.message?.slice(0, 80) || "failed"}`);
          }
        })
      );

      if (liveSet.size === 0) {
        if (attempt < RPC_CONNECT_ATTEMPTS) continue;
        gutterBottom();
        throw new Error(
          `Cannot connect to any Ethereum RPC endpoint.\n\n` +
            errors.map((e) => `  ${e}`).join("\n") +
            "\n\n  Check your internet connection, or specify an RPC\n" +
            "  URL with --rpc-url."
        );
      }

      // Build FallbackProvider with ALL RPCs — live ones get priority 1, dead ones get priority 10
      // Dead RPCs stay available as failover if the live ones drop mid-operation
      const backends = allProviders.map((p, i) => ({
        provider: p,
        priority: liveSet.has(i) ? 1 : 10,
        stallTimeout: 3000,
      }));
      provider = new FallbackProvider(backends, 1);

      const dead = rpcUrls.length - liveSet.size;
      if (dead > 0) {
        gSuccess(`Connected to Ethereum ${c.dim}(${liveSet.size}/${rpcUrls.length} RPCs live)${c.reset}`);
      } else {
        gSuccess("Connected to Ethereum");
      }
      break;
    } catch (err: any) {
      if (err.message?.includes("Cannot connect to any")) throw err;
      if (attempt >= RPC_CONNECT_ATTEMPTS) {
        gutterBottom();
        throw new Error(
          `Cannot connect to any Ethereum RPC endpoint.\n\n` +
            `  ${err.message?.slice(0, 200) || "Unknown error"}\n\n` +
            "  Check your internet connection, or specify an RPC\n" +
            "  URL with --rpc-url."
        );
      }
    }
  }

  let wallet: ethers.Wallet;
  try {
    wallet = new ethers.Wallet(config.privateKey, provider);
    gSuccess(`Wallet ${c.dim}${wallet.address}${c.reset}`);
  } catch {
    gutterBottom();
    provider.destroy();
    throw new Error(
      "Invalid Ethereum wallet key.\n\n" +
        "  Check the NOVA_ENS_KEY env var."
    );
  }

  // Encode the IPFS CID to contenthash format (before ENS calls so CID errors are clear)
  let contenthash: string;
  try {
    contenthash = encodeIpfsContenthash(ipfsCid);
  } catch (err: any) {
    gutterBottom();
    provider.destroy();
    throw new Error(
      `Invalid IPFS CID: ${ipfsCid}\n\n` +
        `  ${err.message || "Could not parse CID"}`
    );
  }

  try {
    // If this is a subdomain, create it if it doesn't exist
    if (isSubdomain(config.ensName)) {
      await ensureSubdomain(config.ensName, wallet, provider);
    }

    // Resolve the ENS name to get the resolver address
    const resolver = await provider.getResolver(config.ensName);
    if (!resolver) {
      throw new Error(
        `No resolver found for ${config.ensName}.\n\n` +
          "  Your ENS name needs a resolver contract.\n" +
          `  Set one at: https://app.ens.domains/${config.ensName}`
      );
    }

    gSuccess(`Resolver ${c.dim}${resolver.address}${c.reset}`);

    const resolverContract = new ethers.Contract(
      resolver.address,
      RESOLVER_ABI,
      wallet
    );

    const node = ethers.namehash(config.ensName);

    gWorking(`Updating ${c.bold}${config.ensName}${c.reset}`);

    try {
      // Dry-run to catch revert reasons before sending
      await resolverContract.setContenthash.staticCall(node, contenthash);
    } catch (err: any) {
      gInfo(`Wallet: ${wallet.address}`);
      gInfo(`Resolver: ${resolver.address}`);
      gInfo(`Contenthash: ${contenthash}`);
      gInfo(`Revert: ${err.message?.slice(0, 200)}`);
      throw err;
    }

    const tx = await resolverContract.setContenthash(node, contenthash);
    gInfo(`tx: ${tx.hash}`);
    gWorking("Waiting for confirmation...");

    await waitForTx(tx, provider);

    const ethLimoUrl = `https://${config.ensName.replace(/\.eth$/, "")}.eth.limo`;

    gSuccess("ENS domain updated");
    gutterBottom();

    provider.destroy();

    return {
      txHash: tx.hash,
      ensName: config.ensName,
      contenthash,
      ethLimoUrl,
    };
  } catch (err: any) {
    gutterBottom();
    provider.destroy();
    throw new Error(friendlyEnsError(err, config.ensName));
  }
}

/**
 * Read the current ENS contenthash for a given name.
 */
const STATUS_RPC_TIMEOUT_MS = 10_000;

export async function getEnsContenthash(
  ensName: string,
  rpcUrl?: string
): Promise<string | null> {
  const rpcUrls = rpcUrl ? [rpcUrl] : DEFAULT_RPC_URLS;

  const mainnetNetwork = Network.from("mainnet");
  const errors: string[] = [];

  // Probe all RPCs in parallel — first success wins
  const providers = rpcUrls.map((url) =>
    new ethers.JsonRpcProvider(url, mainnetNetwork, {
      staticNetwork: mainnetNetwork,
    })
  );

  const result = await Promise.any(
    providers.map(async (provider, i) => {
      try {
        const resolver = await Promise.race([
          provider.getResolver(ensName),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("timeout")), STATUS_RPC_TIMEOUT_MS)
          ),
        ]);
        if (!resolver) {
          return { value: null as string | null, provider };
        }
        const hash = await Promise.race([
          resolver.getContentHash(),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error("timeout")), STATUS_RPC_TIMEOUT_MS)
          ),
        ]);
        return { value: hash, provider };
      } catch (err: any) {
        errors.push(`${new URL(rpcUrls[i]).hostname}: ${err.message?.slice(0, 60) || "failed"}`);
        throw err;
      }
    })
  ).catch(() => null);

  // Clean up all providers
  for (const p of providers) p.destroy();

  if (result) return result.value;

  throw new Error(
    `Cannot check ENS status for ${ensName}.\n\n` +
      errors.map((e) => `  ${e}`).join("\n") +
      "\n\n  Check your internet connection and try again."
  );
}
