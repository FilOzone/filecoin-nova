/**
 * Config resolution from environment variables only.
 * No credentials file -- auth via browser signing or env vars.
 */

import { DEFAULT_SUBNAME_WORKER_URL, DEFAULT_SUBNAME_PARENT } from "./signing-url.js";

export interface ResolvedConfig {
  pinKey?: string;
  walletAddress?: string;
  ensKey?: string;
  ensName?: string;
  providerId?: number;
  rpcUrl?: string;
  /** Nova-owned parent for free gasless subnames (default fcnova.eth). */
  subnameParent: string;
  /** Subname issuance Worker URL. Baked-in default; "" disables the feature. */
  subnameWorkerUrl: string;
}

/**
 * Resolve config from environment variables.
 */
export function resolveConfig(env: NodeJS.ProcessEnv): ResolvedConfig {
  let providerId: number | undefined;
  if (env.NOVA_PROVIDER_ID !== undefined) {
    const n = Number(env.NOVA_PROVIDER_ID);
    if (isNaN(n)) {
      throw new Error(
        `Invalid NOVA_PROVIDER_ID: ${env.NOVA_PROVIDER_ID}\n\n` +
          "  Must be a numeric storage provider ID."
      );
    }
    providerId = n;
  }

  return {
    pinKey: env.NOVA_PIN_KEY,
    walletAddress: env.NOVA_WALLET_ADDRESS,
    ensKey: env.NOVA_ENS_KEY,
    ensName: env.NOVA_ENS_NAME,
    providerId,
    rpcUrl: env.NOVA_RPC_URL,
    subnameParent: env.NOVA_SUBNAME_PARENT || DEFAULT_SUBNAME_PARENT,
    // Default to the baked-in Nova Worker; set NOVA_SUBNAME_WORKER_URL="" to disable.
    subnameWorkerUrl:
      env.NOVA_SUBNAME_WORKER_URL !== undefined
        ? env.NOVA_SUBNAME_WORKER_URL
        : DEFAULT_SUBNAME_WORKER_URL,
  };
}

/** Whether free gasless subname issuance is available (a Worker URL is set). */
export function hasSubnameService(config: ResolvedConfig): boolean {
  return !!config.subnameWorkerUrl;
}

/**
 * Check if config has a wallet address (for read-only operations).
 */
export function hasWalletAddress(config: ResolvedConfig): boolean {
  return !!config.walletAddress || !!config.pinKey;
}

/**
 * Check if config has full signing auth (for write operations).
 */
export function hasStorageAuth(config: ResolvedConfig): boolean {
  return !!config.pinKey;
}
