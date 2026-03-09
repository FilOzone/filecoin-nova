/**
 * Config resolution from environment variables only.
 * No credentials file -- auth via browser signing or env vars.
 */

export interface ResolvedConfig {
  pinKey?: string;
  sessionKey?: string;
  walletAddress?: string;
  ensKey?: string;
  ensName?: string;
  providerId?: number;
  rpcUrl?: string;
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
    sessionKey: env.NOVA_SESSION_KEY,
    walletAddress: env.NOVA_WALLET_ADDRESS,
    ensKey: env.NOVA_ENS_KEY,
    ensName: env.NOVA_ENS_NAME,
    providerId,
    rpcUrl: env.NOVA_RPC_URL,
  };
}

/**
 * Check if config has session key auth (session key + wallet address).
 */
export function hasSessionKeyAuth(config: ResolvedConfig): boolean {
  return !!(config.sessionKey && config.walletAddress);
}

/**
 * Check if config has any Filecoin storage auth (session key or raw key).
 */
export function hasStorageAuth(config: ResolvedConfig): boolean {
  return hasSessionKeyAuth(config) || !!config.pinKey;
}
