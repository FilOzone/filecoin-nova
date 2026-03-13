#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { deploy } from "./deploy.js";
import { updateEnsContenthash, getEnsContenthash } from "./ens.js";
import { listPieces, cleanPieces, toCidV1 } from "./manage.js";
import { resolveConfig, hasWalletAddress, hasStorageAuth } from "./config.js";
import { ensSigningUrl } from "./signing-url.js";
import { pollEnsContenthash, pollTxReceipt } from "./poll.js";
import { CID } from "multiformats/cid";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { jsonStringify, formatToken, isUrl } from "./ui.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

/**
 * Strip ANSI escape codes from subprocess output.
 */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Redirect console.log/error to stderr during tool execution.
 * stdout is reserved for MCP JSON-RPC framing.
 */
function redirectConsole<T>(fn: () => Promise<T>): Promise<T> {
  const origLog = console.log;
  const origErr = console.error;

  const write = (msg: string) => process.stderr.write(msg + "\n");

  console.log = (...args: any[]) => {
    const clean = stripAnsi(args.map(String).join(" ")).trim();
    if (clean) write(clean);
  };
  console.error = (...args: any[]) => {
    const clean = stripAnsi(args.map(String).join(" ")).trim();
    if (clean) write(clean);
  };

  return fn().finally(() => {
    console.log = origLog;
    console.error = origErr;
  });
}

const server = new McpServer(
  { name: "filecoin-nova", version: pkg.version },
);

// nova_deploy - Deploy a directory to Filecoin Onchain Cloud
server.registerTool(
  "nova_deploy",
  {
    title: "Deploy to Filecoin",
    description:
      "Deploy a static website directory to Filecoin Onchain Cloud (mainnet). " +
      "Requires NOVA_PIN_KEY env var for storage auth. " +
      "If the user has no pin key, use nova_demo instead (free, no auth). " +
      "Optionally update an ENS domain to point to the deployed site. " +
      "Returns the IPFS CID and gateway URL. " +
      "This tool takes about 60 seconds to complete - do not retry if it seems slow. " +
      "If no ENS key is configured, returns a browser signing URL for the user to sign via MetaMask.",
    inputSchema: z.object({
      path: z.string().describe("Path to a directory or archive (.zip, .tar.gz, .tgz, .tar) to deploy"),
      walletAddress: z.string().optional().describe("Wallet address (overrides NOVA_WALLET_ADDRESS env var)"),
      ensName: z.string().optional().describe("ENS domain to point to the site (e.g. mysite.eth)"),
      rpcUrl: z.string().optional().describe("Ethereum RPC URL (override default)"),
      providerId: z.number().optional().describe("Storage provider ID"),
      label: z.string().optional().describe("Label for this deploy (shown in nova_manage). Defaults to the directory name."),
      clean: z.boolean().optional().describe("After deploying, remove ALL other pieces - only the new deploy is kept. This is destructive and cannot be undone."),
      calibration: z.boolean().optional().describe("Use calibration testnet instead of mainnet"),
    }),
  },
  async (params): Promise<CallToolResult> => {
    return redirectConsole(async () => {
      try {
        const config = resolveConfig(process.env);
        const walletAddress = params.walletAddress || config.walletAddress;
        const authConfig = { ...config, walletAddress };

        if (!hasStorageAuth(authConfig)) {
          // Generate ephemeral key for wallet authorization
          const { randomBytes } = await import("node:crypto");
          const { privateKeyToAccount } = await import("viem/accounts");
          const { walletAuthUrl } = await import("./signing-url.js");
          const ephemeralKey = `0x${randomBytes(32).toString("hex")}`;
          const ephemeralAddress = privateKeyToAccount(ephemeralKey as `0x${string}`).address;
          const chainId = params.calibration ? 314159 : 314;
          const url = walletAuthUrl(ephemeralKey, chainId);
          const chain = chainId === 314 ? "mainnet" : "calibration";

          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              status: "awaiting_wallet_auth",
              signingUrl: url,
              ephemeralAddress,
              chain,
              instructions: "Show this link to the user and ask them to open it and approve with their wallet. Then call nova_poll with operation 'wallet_auth', ephemeralAddress, and chain to check if authorization is complete. Once confirmed, retry nova_deploy with the returned walletAddress -- the ephemeral key will be authorized on-chain. IMPORTANT: Do not display _ephemeralKey to the user.",
              _ephemeralKey: ephemeralKey, // Scoped session key -- needed for retry, do not display to user
            }) }],
          };
        }

        const result = await deploy({
          path: params.path,
          pinKey: authConfig.pinKey,
          walletAddress: authConfig.walletAddress,
          ensName: params.ensName,
          ensKey: authConfig.ensKey,
          rpcUrl: params.rpcUrl || authConfig.rpcUrl,
          providerId: params.providerId ?? authConfig.providerId,
          mainnet: !params.calibration,
          label: params.label,
        });

        const output: Record<string, unknown> = {
          cid: result.cid,
          directory: result.directory,
          gatewayUrl: `https://${result.cid}.ipfs.dweb.link`,
          ...(result.ensName && { ensName: result.ensName }),
          ...(result.txHash && { txHash: result.txHash }),
          ...(result.ethLimoUrl && { ethLimoUrl: result.ethLimoUrl }),
        };

        // ENS was requested but no key -- return signing URL
        if (params.ensName && !result.txHash) {
          output.ens = {
            status: "awaiting_signature",
            signingUrl: ensSigningUrl(params.ensName, result.cid),
            instructions: "Open this link and sign the transaction with MetaMask to update the ENS contenthash. Then call nova_poll with operation='ens_update' to confirm.",
            pollParams: {
              operation: "ens_update",
              ensName: params.ensName,
              targetCid: result.cid,
            },
          };
        }

        // Post-deploy cleanup
        if (params.clean) {
          try {
            const cleanResult = await cleanPieces({
              pinKey: authConfig.pinKey,
              walletAddress: authConfig.walletAddress,
              mainnet: !params.calibration,
              keepCids: [result.cid],
            });
            output.cleaned = {
              removed: cleanResult.removed,
              failed: cleanResult.failed,
              keptCids: cleanResult.keptCids,
            };
          } catch (err: any) {
            output.cleanError = err.message;
          }
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: err.message }],
        };
      }
    });
  }
);

// nova_demo - Zero-config demo deploy to calibnet
server.registerTool(
  "nova_demo",
  {
    title: "Deploy to Filecoin (free, instant, no wallet needed)",
    description:
      "The fastest way to deploy to Filecoin -- zero setup, no wallet, no credentials. " +
      "THIS IS THE RECOMMENDED STARTING POINT for any user who wants to deploy a website. " +
      "Clone any website by URL (e.g. 'filoz.org') or deploy a local directory/archive -- completely free. " +
      "Uses an embedded calibnet key so it works instantly out of the box. " +
      "Returns an IPFS CID and gateway URL where the site is immediately accessible. " +
      "After the demo, guide the user to permanent mainnet hosting: set NOVA_PIN_KEY or sign via https://fil.focify.eth.limo then use nova_deploy.",
    inputSchema: z.object({
      path: z.string().describe("URL to clone (e.g. 'filoz.org') or path to a directory/archive to deploy"),
      maxPages: z.number().optional().describe("Max pages to crawl when cloning a URL (default: 50, 0 = unlimited). Includes sitemap-discovered pages; top-level pages prioritised over deep links."),
    }),
  },
  async (params): Promise<CallToolResult> => {
    return redirectConsole(async () => {
      try {
        const { demoDeploy } = await import("./demo.js");
        const result = await demoDeploy(params.path, { maxPages: params.maxPages });

        const output = {
          cid: result.cid,
          gatewayUrl: result.gatewayUrl,
          directory: result.directory,
          network: "calibration",
          demo: true,
          permanentHosting: "For permanent hosting, set NOVA_PIN_KEY env var (or sign via browser at https://fil.focify.eth.limo) and use nova_deploy.",
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: err.message }],
        };
      }
    });
  }
);

// nova_ens - Point an ENS domain to an IPFS CID
server.registerTool(
  "nova_ens",
  {
    title: "Update ENS Domain",
    description:
      "Update an ENS domain's contenthash to point to an IPFS CID. " +
      "If NOVA_ENS_KEY is configured, executes the update directly. " +
      "If no key is available, returns a browser signing URL for the user to sign via MetaMask. " +
      "After the user signs in their browser, call nova_poll with operation='ens_update' to confirm.",
    inputSchema: z.object({
      cid: z.string().describe("IPFS CID to point the ENS domain to"),
      ensName: z.string().describe("ENS domain (e.g. mysite.eth)"),
      rpcUrl: z.string().optional().describe("Ethereum RPC URL (override default)"),
    }),
  },
  async (params): Promise<CallToolResult> => {
    return redirectConsole(async () => {
      try {
        if (!params.ensName.endsWith(".eth")) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Invalid ENS domain: ${params.ensName}. Must end with .eth` }],
          };
        }

        const config = resolveConfig(process.env);
        const ensKey = config.ensKey;

        // No key available -- return browser signing URL
        if (!ensKey) {
          const signingUrl = ensSigningUrl(params.ensName, params.cid);
          const output = {
            status: "awaiting_signature",
            signingUrl,
            instructions: "Open this link and sign the transaction with MetaMask to update the ENS contenthash. Then call nova_poll with operation='ens_update' to confirm.",
            pollParams: {
              operation: "ens_update",
              ensName: params.ensName,
              targetCid: params.cid,
            },
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          };
        }

        // Key available -- execute directly
        const result = await updateEnsContenthash(
          {
            ensName: params.ensName,
            privateKey: ensKey,
            rpcUrl: params.rpcUrl || config.rpcUrl,
          },
          params.cid
        );

        const output = {
          ensName: result.ensName,
          cid: params.cid,
          txHash: result.txHash,
          contenthash: result.contenthash,
          ethLimoUrl: result.ethLimoUrl,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: err.message }],
        };
      }
    });
  }
);

// nova_status - Check ENS contenthash
server.registerTool(
  "nova_status",
  {
    title: "Check ENS Status",
    description:
      "Check the current ENS contenthash for a domain. " +
      "Returns the contenthash, eth.limo URL, and pin status if auth is available. " +
      "Pin status shows how many active/removing pieces back this CID. " +
      "No auth needed for the ENS check, but pin status requires NOVA_WALLET_ADDRESS (or NOVA_PIN_KEY).",
    inputSchema: z.object({
      ensName: z.string().describe("ENS domain to check (e.g. mysite.eth)"),
      rpcUrl: z.string().optional().describe("Ethereum RPC URL (override default)"),
    }),
  },
  async (params): Promise<CallToolResult> => {
    return redirectConsole(async () => {
      try {
        if (!params.ensName.endsWith(".eth")) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Invalid ENS domain: ${params.ensName}. Must end with .eth` }],
          };
        }

        const config = resolveConfig(process.env);
        const contenthash = await getEnsContenthash(
          params.ensName,
          params.rpcUrl || config.rpcUrl
        );

        const cid = contenthash?.startsWith("ipfs://") ? contenthash.slice(7) : null;

        const output: Record<string, unknown> = {
          ensName: params.ensName,
          contenthash: contenthash || null,
          url: contenthash
            ? `https://${params.ensName.replace(/\.eth$/, "")}.eth.limo`
            : null,
          ...(cid && { cid }),
        };

        // Add pin status if wallet address is available
        if (cid && hasWalletAddress(config)) {
          try {
            let cidV1: string;
            try { cidV1 = CID.parse(cid).toV1().toString(); } catch { cidV1 = cid; }
            const summaries = await listPieces({ pinKey: config.pinKey, walletAddress: config.walletAddress, mainnet: true });
            for (const ds of summaries) {
              const group = ds.groups.find((g) => {
                try { return CID.parse(g.ipfsRootCID).toV1().toString() === cidV1; } catch { return g.ipfsRootCID === cid; }
              });
              if (group) {
                const pending = group.pieces.filter((p) => p.pendingRemoval).length;
                output.pinStatus = {
                  totalPieces: group.totalPieces,
                  activePieces: group.totalPieces - pending,
                  pendingRemoval: pending,
                };
                break;
              }
            }
            if (!output.pinStatus) {
              output.pinStatus = null;
              output.pinNote = "CID not found in any pinned datasets for this wallet";
            }
          } catch {
            // Silently skip
          }
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: err.message }],
        };
      }
    });
  }
);

// nova_manage - List pinned pieces grouped by IPFS CID
server.registerTool(
  "nova_manage",
  {
    title: "List Pinned Pieces",
    description:
      "List all pinned pieces for this wallet, grouped by IPFS root CID. " +
      "Shows piece counts, sizes, and identifies old/duplicate uploads that can be cleaned up. " +
      "Each group has 'activePieces' (not pending removal) and 'duplicateActivePieces' (active copies beyond the 2 stored by default). " +
      "Nova stores 2 copies per upload for redundancy. If duplicateActivePieces > 0, suggest cleanup. " +
      "Pieces with pendingRemoval=true are already scheduled for deletion. " +
      "Auth: set NOVA_WALLET_ADDRESS (or NOVA_PIN_KEY) env var.",
    inputSchema: z.object({
      walletAddress: z.string().optional().describe("Wallet address (overrides NOVA_WALLET_ADDRESS env var)"),
      calibration: z.boolean().optional().describe("Use calibration testnet instead of mainnet"),
    }),
  },
  async (params): Promise<CallToolResult> => {
    return redirectConsole(async () => {
      try {
        const config = resolveConfig(process.env);
        const walletAddress = params.walletAddress || config.walletAddress;
        const authConfig = { ...config, walletAddress };

        if (!hasWalletAddress(authConfig)) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "No wallet address found. Set NOVA_WALLET_ADDRESS (or NOVA_PIN_KEY) env var." }],
          };
        }

        const summaries = await listPieces({
          pinKey: authConfig.pinKey,
          walletAddress: authConfig.walletAddress,
          mainnet: !params.calibration,
        });

        return {
          content: [{ type: "text" as const, text: jsonStringify({ datasets: summaries }) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: err.message }],
        };
      }
    });
  }
);

// nova_manage_clean - Remove old and duplicate pieces
server.registerTool(
  "nova_manage_clean",
  {
    title: "Clean Up Pieces",
    description:
      "Remove old and duplicate pinned pieces to reduce storage costs. " +
      "By default, keeps the latest IPFS CID and removes everything else, " +
      "including duplicate uploads of the same content. " +
      "Use 'keepCids' to keep specific CIDs, or 'removeCids' to remove specific CIDs. " +
      "WARNING: This permanently deletes pieces. Always run nova_manage first to review. " +
      "Each piece requires a separate transaction - this may take a while for many pieces. " +
      "Auth: set NOVA_PIN_KEY env var. " +
      "ALWAYS confirm with the user before calling this tool.",
    inputSchema: z.object({
      walletAddress: z.string().optional().describe("Wallet address (overrides NOVA_WALLET_ADDRESS env var)"),
      keepCids: z.string().optional().describe("Comma-separated CIDs to keep (removes everything else)"),
      removeCids: z.string().optional().describe("Comma-separated CIDs to remove (keeps everything else)"),
      keepCopies: z.boolean().optional().describe("Keep all copies of the same content (default: false, duplicates are removed)"),
      dataSetId: z.number().optional().describe("Target a specific dataset ID (if wallet has multiple)"),
      calibration: z.boolean().optional().describe("Use calibration testnet instead of mainnet"),
    }),
  },
  async (params): Promise<CallToolResult> => {
    return redirectConsole(async () => {
      try {
        const config = resolveConfig(process.env);
        const walletAddress = params.walletAddress || config.walletAddress;
        const authConfig = { ...config, walletAddress };

        if (!hasStorageAuth(authConfig)) {
          const { randomBytes } = await import("node:crypto");
          const { privateKeyToAccount } = await import("viem/accounts");
          const { walletAuthUrl } = await import("./signing-url.js");
          const ephemeralKey = `0x${randomBytes(32).toString("hex")}`;
          const ephemeralAddress = privateKeyToAccount(ephemeralKey as `0x${string}`).address;
          const isCalibration = params.calibration;
          const chainId = isCalibration ? 314159 : 314;
          const url = walletAuthUrl(ephemeralKey, chainId);
          const chain = isCalibration ? "calibration" : "mainnet";

          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              status: "awaiting_wallet_auth",
              signingUrl: url,
              ephemeralAddress,
              chain,
              instructions: "Show this link to the user and ask them to open it and approve with their wallet. Then call nova_poll with operation 'wallet_auth', ephemeralAddress, and chain to check if authorization is complete. IMPORTANT: Do not display _ephemeralKey to the user.",
              _ephemeralKey: ephemeralKey, // Scoped session key -- needed for retry, do not display to user
            }) }],
          };
        }

        if (params.keepCids && params.removeCids) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Cannot use keepCids and removeCids together. Use keepCids to keep specific CIDs, or removeCids to remove specific CIDs." }],
          };
        }

        const keepCids = params.keepCids ? params.keepCids.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
        const removeCids = params.removeCids ? params.removeCids.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

        const result = await cleanPieces({
          pinKey: authConfig.pinKey,
          walletAddress: authConfig.walletAddress,
          mainnet: !params.calibration,
          keepCids,
          removeCids,
          dataSetId: params.dataSetId !== undefined ? BigInt(params.dataSetId) : undefined,
          keepCopies: params.keepCopies,
        });

        const output = {
          removed: result.removed,
          failed: result.failed,
          keptCids: result.keptCids,
          txCount: result.txHashes.length,
          ...(result.error && { error: result.error }),
          note: "Removals are processed by the provider on a schedule. Pieces will show as 'removing' until fully processed.",
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: err.message }],
        };
      }
    });
  }
);

// nova_poll - Poll on-chain state for browser wallet signing flows
server.registerTool(
  "nova_poll",
  {
    title: "Poll Transaction Status",
    description:
      "Poll on-chain state to check if a browser-signed transaction has completed. " +
      "Use after nova_ens or nova_deploy returns a signing URL. " +
      "Operations: 'ens_update' checks if ENS contenthash matches target CID, " +
      "'tx_receipt' checks if a transaction hash has been mined, " +
      "'wallet_auth' checks if wallet authorization is complete. " +
      "Call this once -- if confirmed is false, wait a few seconds and call again.",
    inputSchema: z.object({
      operation: z.enum(["ens_update", "tx_receipt", "wallet_auth"]).describe("Type of operation to poll for"),
      ensName: z.string().optional().describe("ENS domain (for ens_update)"),
      targetCid: z.string().optional().describe("Expected CID (for ens_update)"),
      chain: z.enum(["mainnet", "calibration", "ethereum"]).optional().describe("Chain to poll (for tx_receipt or wallet_auth)"),
      txHash: z.string().optional().describe("Transaction hash (for tx_receipt)"),
      ephemeralAddress: z.string().optional().describe("Ephemeral key address (for wallet_auth)"),
      rpcUrl: z.string().optional().describe("RPC URL override"),
    }),
  },
  async (params): Promise<CallToolResult> => {
    return redirectConsole(async () => {
    try {
      let result;

      switch (params.operation) {
        case "ens_update": {
          if (!params.ensName || !params.targetCid) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: "ensName and targetCid are required for ens_update polling" }],
            };
          }
          result = await pollEnsContenthash(params.ensName, params.targetCid, params.rpcUrl);
          break;
        }
        case "tx_receipt": {
          if (!params.txHash) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: "txHash is required for tx_receipt polling" }],
            };
          }
          const txChain = (params.chain === "mainnet" || params.chain === "calibration" || params.chain === "ethereum") ? params.chain : "ethereum";
          result = await pollTxReceipt(params.txHash, txChain);
          break;
        }
        case "wallet_auth": {
          if (!params.ephemeralAddress) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: "ephemeralAddress is required for wallet_auth polling" }],
            };
          }
          const authChain = (params.chain === "mainnet" || params.chain === "calibration") ? params.chain : "mainnet";
          const { pollWalletAuth } = await import("./poll.js");
          result = await pollWalletAuth(params.ephemeralAddress, authChain);
          break;
        }
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: err.message }],
      };
    }
    });
  }
);

// nova_clone - Clone a website to a local directory (no deploy)
server.registerTool(
  "nova_clone",
  {
    title: "Clone a Website",
    description:
      "Clone a website into a static directory suitable for Filecoin deployment. " +
      "Crawls pages, downloads assets, rewrites URLs to relative paths, and injects an API response cache " +
      "so JS-heavy sites (Next.js, Nuxt, React) work on IPFS. " +
      "Returns the output directory -- use nova_deploy or nova_demo to deploy it afterwards. " +
      "Handles Next.js image optimization URLs, SRI removal, cross-origin replay, and locale detection.",
    inputSchema: z.object({
      url: z.string().describe("URL of the website to clone (e.g. 'filoz.org' or 'https://example.com')"),
      maxPages: z.number().optional().describe("Max pages to crawl (default: 50, 0 = unlimited). Includes sitemap-discovered pages; top-level pages prioritised over deep links."),
      output: z.string().optional().describe("Output directory (default: auto-generated temp dir)"),
      screenshots: z.boolean().optional().describe("Take before/after screenshots for comparison (default: false)"),
    }),
  },
  async (params): Promise<CallToolResult> => {
    return redirectConsole(async () => {
      try {
        const { clone } = await import("./clone.js");

        // Normalize URL
        let url = params.url;
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          url = `https://${url}`;
        }

        const result = await clone({
          url,
          maxPages: params.maxPages,
          output: params.output,
          screenshots: params.screenshots,
        });

        const output = {
          directory: result.directory,
          sourceUrl: result.sourceUrl,
          pages: result.pages,
          assets: result.assets,
          totalSize: result.totalSize,
          screenshots: result.screenshots,
          nextStep: "Use nova_deploy or nova_demo to deploy this directory to Filecoin.",
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: err.message }],
        };
      }
    });
  }
);

// nova_info - Show details for a specific deployment
server.registerTool(
  "nova_info",
  {
    title: "Deployment Info",
    description:
      "Show details for a specific IPFS CID deployment: dataset, pieces, size, proof status. " +
      "Requires NOVA_WALLET_ADDRESS (or NOVA_PIN_KEY) env var.",
    inputSchema: z.object({
      cid: z.string().describe("IPFS CID to look up"),
      walletAddress: z.string().optional().describe("Wallet address (overrides NOVA_WALLET_ADDRESS env var)"),
      calibration: z.boolean().optional().describe("Use calibration testnet instead of mainnet"),
    }),
  },
  async (params): Promise<CallToolResult> => {
    return redirectConsole(async () => {
      try {
        const config = resolveConfig(process.env);
        const walletAddress = params.walletAddress || config.walletAddress;

        if (!hasWalletAddress({ ...config, walletAddress })) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "No wallet address found. Set NOVA_WALLET_ADDRESS (or NOVA_PIN_KEY) env var." }],
          };
        }

        const isMainnet = !params.calibration;
        const targetCid = toCidV1(params.cid);

        const summaries = await listPieces({
          pinKey: config.pinKey,
          walletAddress,
          mainnet: isMainnet,
        });

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
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ cid: params.cid, found: false }, null, 2) }],
          };
        }

        const output = {
          cid: params.cid,
          found: true,
          network: isMainnet ? "mainnet" : "calibration",
          matches: matches.map((m) => ({
            dataSetId: m.dataSetId,
            provider: m.providerName,
            pieces: m.group.pieces.length,
            totalSize: m.group.totalSizeBytes,
            deployedAt: m.group.createdAt,
            lastProven: m.group.lastProvenAt,
            proofs: m.group.totalProofsSubmitted,
          })),
        };

        return {
          content: [{ type: "text" as const, text: jsonStringify(output) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: err.message }],
        };
      }
    });
  }
);

// nova_wallet - Show wallet balance and deposit status
server.registerTool(
  "nova_wallet",
  {
    title: "Wallet Balance",
    description:
      "Show FIL and USDFC balance for the configured wallet, plus FOC deposit status. " +
      "Requires NOVA_WALLET_ADDRESS (or NOVA_PIN_KEY) env var.",
    inputSchema: z.object({
      walletAddress: z.string().optional().describe("Wallet address (overrides NOVA_WALLET_ADDRESS env var)"),
      calibration: z.boolean().optional().describe("Use calibration testnet instead of mainnet"),
    }),
  },
  async (params): Promise<CallToolResult> => {
    return redirectConsole(async () => {
      try {
        const config = resolveConfig(process.env);
        const walletAddress = params.walletAddress || config.walletAddress;

        if (!hasWalletAddress({ ...config, walletAddress })) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "No wallet address found. Set NOVA_WALLET_ADDRESS (or NOVA_PIN_KEY) env var." }],
          };
        }

        const isMainnet = !params.calibration;
        const { createSynapse, createReadOnlySynapse, resolveWalletAddress } = await import("./auth.js");
        const { getBalance } = await import("viem/actions");
        const { balance: erc20Balance } = await import("@filoz/synapse-core/erc20");
        const { accounts: payAccounts } = await import("@filoz/synapse-core/pay");

        const auth = { pinKey: config.pinKey, walletAddress };
        const walletAddr = resolveWalletAddress(auth);
        const synapse = config.pinKey
          ? createSynapse(auth, isMainnet)
          : createReadOnlySynapse(walletAddr, isMainnet);

        const [filBalance, usdfcInfo, depositInfo] = await Promise.all([
          getBalance(synapse.client, { address: walletAddr }).catch(() => null),
          erc20Balance(synapse.client, { address: walletAddr }).catch(() => null),
          payAccounts(synapse.client, { address: walletAddr }).catch(() => null),
        ]);

        const output = {
          address: walletAddr,
          network: isMainnet ? "mainnet" : "calibration",
          fil: filBalance !== null ? formatToken(filBalance, 18) : null,
          usdfc: usdfcInfo ? { balance: formatToken(usdfcInfo.value, usdfcInfo.decimals), symbol: usdfcInfo.symbol } : null,
          deposit: depositInfo ? {
            funds: formatToken(depositInfo.funds, usdfcInfo?.decimals ?? 18),
            available: formatToken(depositInfo.availableFunds, usdfcInfo?.decimals ?? 18),
            locked: formatToken(depositInfo.lockupCurrent, usdfcInfo?.decimals ?? 18),
          } : null,
        };

        return {
          content: [{ type: "text" as const, text: jsonStringify(output) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: err.message }],
        };
      }
    });
  }
);

// nova_download - Download content from IPFS
server.registerTool(
  "nova_download",
  {
    title: "Download from IPFS",
    description:
      "Download content from IPFS by CID to a local directory. " +
      "Tries multiple gateways (w3s.link, dweb.link, ipfs.io). No auth needed.",
    inputSchema: z.object({
      cid: z.string().describe("IPFS CID to download"),
      directory: z.string().optional().describe("Output directory (default: ./<cid>)"),
    }),
  },
  async (params): Promise<CallToolResult> => {
    return redirectConsole(async () => {
      try {
        const { mkdirSync, createWriteStream, unlinkSync } = await import("node:fs");
        const { pipeline } = await import("node:stream/promises");
        const { Readable } = await import("node:stream");
        const { execFileSync } = await import("node:child_process");
        const { tmpdir } = await import("node:os");
        const { resolve, join } = await import("node:path");

        const cidStr = params.cid;
        const outDir = resolve(params.directory || cidStr);

        const gateways = [
          `https://${cidStr}.ipfs.w3s.link/?format=tar`,
          `https://${cidStr}.ipfs.dweb.link/?format=tar`,
          `https://ipfs.io/ipfs/${cidStr}?format=tar`,
        ];

        let res: Response | null = null;
        for (const gw of gateways) {
          try {
            const attempt = await fetch(gw, {
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

        if (!res || !res.ok || !res.body) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "All IPFS gateways failed. Content may not be available yet -- wait for IPNI propagation and retry." }],
          };
        }

        const tarPath = join(tmpdir(), `nova-download-${Date.now()}.tar`);
        let downloaded = 0;

        const reader = res.body.getReader();
        const nodeStream = new Readable({
          async read() {
            const { done, value } = await reader.read();
            if (done) { this.push(null); return; }
            downloaded += value.byteLength;
            this.push(value);
          },
        });

        const fileStream = createWriteStream(tarPath);
        await pipeline(nodeStream, fileStream);

        try {
          mkdirSync(outDir, { recursive: true });
          execFileSync("tar", ["xf", tarPath, "--strip-components=1", "-C", outDir], { stdio: "pipe" });
        } finally {
          unlinkSync(tarPath);
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ cid: cidStr, directory: outDir, size: downloaded }, null, 2) }],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: err.message }],
        };
      }
    });
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("filecoin-nova MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
