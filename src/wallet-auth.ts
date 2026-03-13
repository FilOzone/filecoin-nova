/**
 * Ephemeral wallet authorization for write operations.
 * Generates a temporary key, has the user authorize it via browser,
 * polls until confirmed, returns auth credentials for that operation.
 */

import { randomBytes } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { walletAuthUrl } from "./signing-url.js";
import { pollWalletAuth } from "./poll.js";

export interface WalletAuthResult {
  pinKey: string;
  walletAddress: string;
}

/**
 * Generate an ephemeral key, prompt user to authorize via browser,
 * poll until confirmed. Returns pinKey + walletAddress for the operation.
 */
export async function acquireWalletAuth(opts: {
  isMainnet: boolean;
  onUrl: (url: string) => void;
  onProgress?: (msg: string) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
}): Promise<WalletAuthResult> {
  const ephemeralKey = `0x${randomBytes(32).toString("hex")}` as Hex;
  const account = privateKeyToAccount(ephemeralKey);
  const chain = opts.isMainnet ? "mainnet" : "calibration";
  const chainId = opts.isMainnet ? 314 : 314159;

  const url = walletAuthUrl(ephemeralKey, chainId);
  opts.onUrl(url);

  const interval = opts.pollIntervalMs ?? 5000;
  const timeout = opts.timeoutMs ?? 300_000; // 5 minutes
  const start = Date.now();

  while (Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, interval));
    opts.onProgress?.("Waiting for wallet authorization...");

    const result = await pollWalletAuth(account.address, chain);
    if (result.confirmed && result.result?.walletAddress) {
      return {
        pinKey: ephemeralKey,
        walletAddress: result.result.walletAddress as string,
      };
    }
    if (result.error) {
      opts.onProgress?.(`Polling error: ${result.error}`);
    }
  }

  throw new Error("Wallet authorization timed out. Please try again.");
}
