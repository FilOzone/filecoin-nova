#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { deploy } from "./deploy.js";
import { updateEnsContenthash, getEnsContenthash } from "./ens.js";
import { resolveConfig } from "./config.js";

/**
 * Redirect console.log/error to MCP log notifications during tool execution.
 * MCP servers must only write JSON-RPC to stdout — any stray console output
 * from deploy/ENS/pin functions would corrupt the protocol stream.
 * Instead, we capture output and send it as MCP log messages.
 */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function withMcpLogging<T>(
  log: (level: string, data: string) => Promise<void>,
  fn: () => Promise<T>
): Promise<T> {
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args: any[]) => {
    const msg = stripAnsi(args.map(String).join(" ")).trim();
    if (msg) log("info", msg).catch(() => {});
  };
  console.error = (...args: any[]) => {
    const msg = stripAnsi(args.map(String).join(" ")).trim();
    if (msg) log("warning", msg).catch(() => {});
  };
  return fn().finally(() => {
    console.log = origLog;
    console.error = origErr;
  });
}

const server = new McpServer(
  { name: "filecoin-nova", version: "0.2.6" },
  { capabilities: { logging: {} } }
);

// nova_deploy — Deploy a directory to Filecoin Onchain Cloud
server.registerTool(
  "nova_deploy",
  {
    title: "Deploy to Filecoin",
    description:
      "Deploy a static website directory to Filecoin Onchain Cloud. " +
      "Optionally update an ENS domain to point to the deployed site. " +
      "Returns the IPFS CID and gateway URL. " +
      "IMPORTANT: Requires a Filecoin wallet key. Before calling, check that credentials are configured " +
      "by asking the user if they have run 'nova config' or set NOVA_PIN_KEY env var. " +
      "If using ENS, NOVA_ENS_KEY is also needed.",
    inputSchema: z.object({
      path: z.string().describe("Path to a directory or archive (.zip, .tar.gz, .tgz, .tar) to deploy"),
      ensName: z.string().optional().describe("ENS domain to point to the site (e.g. mysite.eth)"),
      ensKey: z.string().optional().describe("Ethereum wallet private key for ENS updates (needs ETH for gas)"),
      pinKey: z.string().optional().describe("Filecoin wallet private key (needs USDFC). Falls back to NOVA_PIN_KEY env var"),
      rpcUrl: z.string().optional().describe("Ethereum RPC URL (override default)"),
      providerId: z.number().optional().describe("Storage provider ID"),
      calibration: z.boolean().optional().describe("Use calibration testnet instead of mainnet"),
    }),
  },
  async (params): Promise<CallToolResult> => {
    const log = (level: string, data: string) => server.sendLoggingMessage({ level: level as any, data });
    return withMcpLogging(log, async () => {
      try {
        const config = resolveConfig(process.env);

        const pinKey = params.pinKey || config.pinKey;
        if (pinKey) {
          process.env.NOVA_PIN_KEY = pinKey;
        }

        const result = await deploy({
          path: params.path,
          pinKey,
          ensName: params.ensName,
          ensKey: params.ensKey || config.ensKey,
          rpcUrl: params.rpcUrl || config.rpcUrl,
          providerId: params.providerId ?? config.providerId,
          mainnet: !params.calibration,
        });

        const output = {
          cid: result.cid,
          directory: result.directory,
          gatewayUrl: `https://${result.cid}.ipfs.dweb.link`,
          ...(result.ensName && { ensName: result.ensName }),
          ...(result.txHash && { txHash: result.txHash }),
          ...(result.ethLimoUrl && { ethLimoUrl: result.ethLimoUrl }),
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

// nova_ens — Point an ENS domain to an IPFS CID
server.registerTool(
  "nova_ens",
  {
    title: "Update ENS Domain",
    description:
      "Update an ENS domain's contenthash to point to an IPFS CID. " +
      "Requires an Ethereum wallet with ETH for gas. " +
      "IMPORTANT: Before calling, check that credentials are configured " +
      "by asking the user if they have run 'nova config' or set NOVA_ENS_KEY env var.",
    inputSchema: z.object({
      cid: z.string().describe("IPFS CID to point the ENS domain to"),
      ensName: z.string().describe("ENS domain (e.g. mysite.eth)"),
      ensKey: z.string().optional().describe("Ethereum wallet private key. Falls back to NOVA_ENS_KEY env var"),
      rpcUrl: z.string().optional().describe("Ethereum RPC URL (override default)"),
    }),
  },
  async (params): Promise<CallToolResult> => {
    const log = (level: string, data: string) => server.sendLoggingMessage({ level: level as any, data });
    return withMcpLogging(log, async () => {
      try {
        const config = resolveConfig(process.env);
        const ensKey = params.ensKey || config.ensKey;

        if (!ensKey) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: "Ethereum wallet key required. Run 'nova config' to save your keys, or set NOVA_ENS_KEY env var." }],
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

// nova_status — Check ENS contenthash
server.registerTool(
  "nova_status",
  {
    title: "Check ENS Status",
    description:
      "Check the current ENS contenthash for a domain. " +
      "Returns the contenthash and eth.limo URL if set.",
    inputSchema: z.object({
      ensName: z.string().describe("ENS domain to check (e.g. mysite.eth)"),
      rpcUrl: z.string().optional().describe("Ethereum RPC URL (override default)"),
    }),
  },
  async (params): Promise<CallToolResult> => {
    const log = (level: string, data: string) => server.sendLoggingMessage({ level: level as any, data });
    return withMcpLogging(log, async () => {
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

        const output = {
          ensName: params.ensName,
          contenthash: contenthash || null,
          url: contenthash
            ? `https://${params.ensName.replace(/\.eth$/, "")}.eth.limo`
            : null,
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
