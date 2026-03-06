#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { deploy } from "./deploy.js";
import { updateEnsContenthash, getEnsContenthash } from "./ens.js";
import { listPieces, cleanPieces } from "./manage.js";
import { resolveConfig } from "./config.js";
import { CID } from "multiformats/cid";

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
  { name: "filecoin-nova", version: "0.3.6" },
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
      "IMPORTANT: Requires credentials set up beforehand via 'nova config' in the terminal. " +
      "Keys cannot be passed as parameters and must NEVER be requested in chat. " +
      "Before calling, ask the user if they have run 'nova config' to save their Filecoin wallet key. " +
      "If using ENS, they also need their Ethereum wallet key saved via 'nova config'. " +
      "Do NOT call this tool without confirming credentials are set up first.",
    inputSchema: z.object({
      path: z.string().describe("Path to a directory or archive (.zip, .tar.gz, .tgz, .tar) to deploy"),
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

        if (!config.pinKey) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "No Filecoin wallet key found. The user needs to run 'nova config' in their terminal to save their wallet key." }],
          };
        }

        const result = await deploy({
          path: params.path,
          pinKey: config.pinKey,
          ensName: params.ensName,
          ensKey: config.ensKey,
          rpcUrl: params.rpcUrl || config.rpcUrl,
          providerId: params.providerId ?? config.providerId,
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

        // Post-deploy cleanup
        if (params.clean) {
          try {
            const cleanResult = await cleanPieces({
              pinKey: config.pinKey,
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

// nova_ens - Point an ENS domain to an IPFS CID
server.registerTool(
  "nova_ens",
  {
    title: "Update ENS Domain",
    description:
      "Update an ENS domain's contenthash to point to an IPFS CID. " +
      "Requires an Ethereum wallet with ETH for gas. " +
      "IMPORTANT: Requires an Ethereum wallet key set up beforehand via 'nova config' in the terminal. " +
      "Keys cannot be passed as parameters and must NEVER be requested in chat. " +
      "Before calling, ask the user if they have run 'nova config'. " +
      "Do NOT call without confirming credentials are set up first.",
    inputSchema: z.object({
      cid: z.string().describe("IPFS CID to point the ENS domain to"),
      ensName: z.string().describe("ENS domain (e.g. mysite.eth)"),
      rpcUrl: z.string().optional().describe("Ethereum RPC URL (override default)"),
    }),
  },
  async (params): Promise<CallToolResult> => {
    return redirectConsole(async () => {
      try {
        const config = resolveConfig(process.env);
        const ensKey = config.ensKey;

        if (!ensKey) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "No Ethereum wallet key found. The user needs to run 'nova config' in their terminal to save their wallet key." }],
          };
        }

        if (!params.ensName.endsWith(".eth")) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `Invalid ENS domain: ${params.ensName}. Must end with .eth` }],
          };
        }

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
      "Returns the contenthash, eth.limo URL, and pin status if credentials are available. " +
      "Pin status shows how many active/removing pieces back this CID. " +
      "No credentials needed for the ENS check, but pin status requires 'nova config'.",
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

        // Add pin status if credentials are available
        if (cid && config.pinKey) {
          try {
            let cidV1: string;
            try { cidV1 = CID.parse(cid).toV1().toString(); } catch { cidV1 = cid; }
            const summaries = await listPieces({ pinKey: config.pinKey, mainnet: true });
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
      "IMPORTANT: Requires credentials set up beforehand via 'nova config' in the terminal. " +
      "Do NOT call without confirming credentials are set up first.",
    inputSchema: z.object({
      calibration: z.boolean().optional().describe("Use calibration testnet instead of mainnet"),
    }),
  },
  async (params): Promise<CallToolResult> => {
    return redirectConsole(async () => {
      try {
        const config = resolveConfig(process.env);

        if (!config.pinKey) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "No Filecoin wallet key found. The user needs to run 'nova config' in their terminal to save their wallet key." }],
          };
        }

        const summaries = await listPieces({
          pinKey: config.pinKey,
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
      "IMPORTANT: Requires credentials set up beforehand via 'nova config' in the terminal. " +
      "Do NOT call without confirming credentials are set up first. " +
      "ALWAYS confirm with the user before calling this tool.",
    inputSchema: z.object({
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

        if (!config.pinKey) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "No Filecoin wallet key found. The user needs to run 'nova config' in their terminal to save their wallet key." }],
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
          pinKey: config.pinKey,
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("filecoin-nova MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
