export interface ResolvedConfig {
  pinKey?: string;
  ensKey?: string;
  ensName?: string;
  providerId?: number;
  rpcUrl?: string;
}

/**
 * Resolve config from environment variables only.
 * No config files — keys and settings come from env vars or CLI flags.
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
    ensKey: env.NOVA_ENS_KEY,
    ensName: env.NOVA_ENS_NAME,
    providerId,
    rpcUrl: env.NOVA_RPC_URL,
  };
}
