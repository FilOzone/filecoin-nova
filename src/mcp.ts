#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { deploy } from "./deploy.js";
import { updateEnsContenthash, getEnsContenthash } from "./ens.js";
import { listPieces, cleanPieces } from "./manage.js";
import { resolveConfig, hasSessionKeyAuth, hasStorageAuth } from "./config.js";
import { ensSigningUrl, sessionKeySigningUrl } from "./signing-url.js";
import { pollEnsContenthash, pollSessionKeyRegistered, pollTxReceipt } from "./poll.js";
import { CID } from "multiformats/cid";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    typeof val === "bigint" ? Number(val) : val, 2);
}

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
      "Deploy a static website directory to Filecoin Onchain Cloud. " +
      "Optionally update an ENS domain to point to the deployed site. " +
      "Returns the IPFS CID and gateway URL. " +
      "This tool takes about 60 seconds to complete - do not retry if it seems slow. " +
      "Auth: pass sessionKey + walletAddress params (preferred, safe to paste in chat), " +
      "or set NOVA_SESSION_KEY + NOVA_WALLET_ADDRESS env vars. " +
      "Session keys are scoped to storage operations only and cannot move funds. " +
      "If no ENS key is configured, returns a browser signing URL for the user to sign via MetaMask.",
    inputSchema: z.object({
      path: z.string().describe("Path to a directory or archive (.zip, .tar.gz, .tgz, .tar) to deploy"),
      sessionKey: z.string().optional().describe("Session key for Filecoin storage auth (safe to paste - scoped, cannot move funds)"),
      walletAddress: z.string().optional().describe("Wallet address that owns the session key"),
      ensName: z.string().optional().describe("ENS domain to point to the site (e.g. mysite.eth)"),
      rpcUrl: z.string().optional().describe("Ethereum RPC URL (override default)"),
      providerId: z.number().optional().describe("Storage provider ID"),
      clean: z.boolean().optional().describe("After deploying, remove ALL other pieces - only the new deploy is kept. This is destructive and cannot be undone."),
      calibration: z.boolean().optional().describe("Use calibration testnet instead of mainnet"),
    }),
  },
  async (params): Promise<CallToolResult> => {
    return redirectConsole(async () => {
      try {
        const config = resolveConfig(process.env);

        // Tool params override config for session key auth
        const sessionKey = params.sessionKey || config.sessionKey;
        const walletAddress = params.walletAddress || config.walletAddress;
        const authConfig = { ...config, sessionKey, walletAddress };

        if (!hasStorageAuth(authConfig)) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "No Filecoin auth found. Pass sessionKey + walletAddress params, or create a session key at https://session.focify.eth.limo" }],
          };
        }

        const result = await deploy({
          path: params.path,
          pinKey: authConfig.pinKey,
          sessionKey: authConfig.sessionKey,
          walletAddress: authConfig.walletAddress,
          ensName: params.ensName,
          ensKey: authConfig.ensKey,
          rpcUrl: params.rpcUrl || authConfig.rpcUrl,
          providerId: params.providerId ?? authConfig.providerId,
          mainnet: !params.calibration,
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
              sessionKey: authConfig.sessionKey,
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
    title: "Demo Deploy (no wallet needed)",
    description:
      "Clone a website or deploy a directory to Filecoin Onchain Cloud for free -- no wallet or auth needed. " +
      "Uses an embedded calibnet session key. Perfect for trying Nova instantly. " +
      "Pass a URL (e.g. 'filoz.org') to clone and deploy, or a local path to deploy directly. " +
      "Returns an IPFS CID and gateway URL. " +
      "For permanent hosting, guide the user to create a session key at https://session.focify.eth.limo",
    inputSchema: z.object({
      path: z.string().describe("URL to clone (e.g. 'filoz.org') or path to a directory/archive to deploy"),
      maxPages: z.number().optional().describe("Max pages to crawl when cloning a URL (default: 50)"),
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
          permanentHosting: "For permanent hosting, create a session key at https://session.focify.eth.limo and use nova_deploy with sessionKey + walletAddress params.",
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
      "No auth needed for the ENS check, but pin status requires sessionKey + walletAddress.",
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

        // Add pin status if auth is available
        if (cid && hasStorageAuth(config)) {
          try {
            let cidV1: string;
            try { cidV1 = CID.parse(cid).toV1().toString(); } catch { cidV1 = cid; }
            const summaries = await listPieces({ pinKey: config.pinKey, sessionKey: config.sessionKey, walletAddress: config.walletAddress, mainnet: true });
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
      "Each group has 'activePieces' (not pending removal) and 'duplicateActivePieces' (active copies beyond the first - these are redundant and can be removed with nova_manage_clean). " +
      "Only 1 active piece per CID is needed. If duplicateActivePieces > 0, suggest cleanup. " +
      "Pieces with pendingRemoval=true are already scheduled for deletion. " +
      "Auth: pass sessionKey + walletAddress params, or set NOVA_SESSION_KEY + NOVA_WALLET_ADDRESS env vars.",
    inputSchema: z.object({
      sessionKey: z.string().optional().describe("Session key for Filecoin storage auth (safe to paste - scoped, cannot move funds)"),
      walletAddress: z.string().optional().describe("Wallet address that owns the session key"),
      calibration: z.boolean().optional().describe("Use calibration testnet instead of mainnet"),
    }),
  },
  async (params): Promise<CallToolResult> => {
    return redirectConsole(async () => {
      try {
        const config = resolveConfig(process.env);
        const sessionKey = params.sessionKey || config.sessionKey;
        const walletAddress = params.walletAddress || config.walletAddress;
        const authConfig = { ...config, sessionKey, walletAddress };

        if (!hasStorageAuth(authConfig)) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "No Filecoin auth found. Pass sessionKey + walletAddress params, or create a session key at https://session.focify.eth.limo" }],
          };
        }

        const summaries = await listPieces({
          pinKey: authConfig.pinKey,
          sessionKey: authConfig.sessionKey,
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
      "Auth: pass sessionKey + walletAddress params, or set NOVA_SESSION_KEY + NOVA_WALLET_ADDRESS env vars. " +
      "ALWAYS confirm with the user before calling this tool.",
    inputSchema: z.object({
      sessionKey: z.string().optional().describe("Session key for Filecoin storage auth (safe to paste - scoped, cannot move funds)"),
      walletAddress: z.string().optional().describe("Wallet address that owns the session key"),
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
        const sessionKey = params.sessionKey || config.sessionKey;
        const walletAddress = params.walletAddress || config.walletAddress;
        const authConfig = { ...config, sessionKey, walletAddress };

        if (!hasStorageAuth(authConfig)) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "No Filecoin auth found. Pass sessionKey + walletAddress params, or create a session key at https://session.focify.eth.limo" }],
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
          sessionKey: authConfig.sessionKey,
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
      "'session_key' checks if a session key is registered, " +
      "'tx_receipt' checks if a transaction hash has been mined. " +
      "Call this once -- if confirmed is false, wait a few seconds and call again.",
    inputSchema: z.object({
      operation: z.enum(["ens_update", "session_key", "tx_receipt"]).describe("Type of operation to poll for"),
      ensName: z.string().optional().describe("ENS domain (for ens_update)"),
      targetCid: z.string().optional().describe("Expected CID (for ens_update)"),
      sessionAddress: z.string().optional().describe("Session key address (for session_key)"),
      walletAddress: z.string().optional().describe("Root wallet address (for session_key)"),
      chain: z.enum(["mainnet", "calibration", "ethereum"]).optional().describe("Chain to poll (for session_key and tx_receipt)"),
      txHash: z.string().optional().describe("Transaction hash (for tx_receipt)"),
      rpcUrl: z.string().optional().describe("RPC URL override"),
    }),
  },
  async (params): Promise<CallToolResult> => {
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
        case "session_key": {
          if (!params.sessionAddress || !params.walletAddress) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: "sessionAddress and walletAddress are required for session_key polling" }],
            };
          }
          const skChain = (params.chain === "mainnet" || params.chain === "calibration") ? params.chain : "calibration";
          result = await pollSessionKeyRegistered(params.sessionAddress, params.walletAddress, skChain);
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
