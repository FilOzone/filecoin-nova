/**
 * Demo mode -- zero-config calibnet deploys using an embedded session key.
 * The session key is scoped to storage operations only (cannot transfer funds).
 * Accepts a URL (clone + deploy) or a directory path (deploy directly).
 */

// Embedded calibnet session key (safe to publish -- scoped, calibnet only)
export const DEMO_SESSION_KEY = "0x7b029c6a96fdd59a3276749b2cea67497eda13d19176ae1c8be7c39cf37a807a";
export const DEMO_WALLET_ADDRESS = "0x12e83c954051b7c91f70d001f80dc9ff91737b83";

import { isUrl } from "./ui.js";

export interface DemoResult {
  cid: string;
  gatewayUrl: string;
  dwebUrl: string;
  directory: string;
  cloned?: boolean;
  sourceUrl?: string;
  pages?: number;
}

function normalizeUrl(input: string): string {
  if (!/^https?:\/\//i.test(input)) {
    return `https://${input}`;
  }
  return input;
}

/**
 * Demo deploy: clone a URL or deploy a directory to calibnet.
 * No credentials needed.
 */
export async function demoDeploy(input: string, opts?: { maxPages?: number; providerId?: number }): Promise<DemoResult> {
  const { deploy } = await import("./deploy.js");

  let deployPath = input;
  let cloned = false;
  let sourceUrl: string | undefined;
  let pages: number | undefined;

  if (isUrl(input)) {
    const { clone } = await import("./clone.js");
    const url = normalizeUrl(input);
    sourceUrl = url;

    const cloneResult = await clone({
      url,
      maxPages: opts?.maxPages ?? 50,
    });

    deployPath = cloneResult.directory;
    cloned = true;
    pages = cloneResult.pages;
  }

  let result;
  try {
    result = await deploy({
      path: deployPath,
      pinKey: DEMO_SESSION_KEY,
      walletAddress: DEMO_WALLET_ADDRESS,
      mainnet: false,
      providerId: opts?.providerId,
    });
  } catch (err: any) {
    const msg = (err.message || "").toLowerCase();
    if (msg.includes("insufficient") || msg.includes("balance") || msg.includes("usdfc")) {
      throw new Error(
        "Demo wallet is out of funds.\n\n" +
          "  The shared demo wallet has run out of calibnet USDFC.\n" +
          "  For permanent hosting, set NOVA_PIN_KEY or sign via:\n" +
          "  https://fil.focify.eth.limo"
      );
    }
    throw err;
  }

  return {
    cid: result.cid,
    gatewayUrl: result.cid.length <= 63
      ? `https://${result.cid}.ipfs.gateway.focify.me/`
      : `https://gateway.focify.me/ipfs/${result.cid}`,
    dwebUrl: `https://${result.cid}.ipfs.dweb.link/`,
    directory: result.directory,
    cloned,
    sourceUrl,
    pages,
  };
}
