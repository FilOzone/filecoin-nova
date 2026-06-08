/**
 * Construct pre-filled URLs for browser signing pages.
 * These pages let users sign transactions via MetaMask
 * without pasting private keys into chat.
 */

const ENS_PAGE = "https://ens.focify.eth.limo";
const WALLET_AUTH_PAGE = "https://fil.focify.eth.limo";

/**
 * Nova-operated subname issuance Worker. Baked in so free names work
 * zero-config; override with NOVA_SUBNAME_WORKER_URL for testing.
 * Holds the master Namespace API key -- never shipped client-side.
 */
export const DEFAULT_SUBNAME_WORKER_URL = "https://subname.happys1ngh.workers.dev";

/**
 * Default Nova-owned parent name that free subnames are issued under.
 * Override per-environment with NOVA_SUBNAME_PARENT.
 */
export const DEFAULT_SUBNAME_PARENT = "fcnova.eth";

export function walletAuthUrl(ephemeralKey: string, chain?: number): string {
  const params = new URLSearchParams({ sessionKey: ephemeralKey });
  if (chain) params.set("chain", String(chain));
  return `${WALLET_AUTH_PAGE}?${params}`;
}

export function ensSigningUrl(ensName: string, cid: string): string {
  const params = new URLSearchParams({ name: ensName, cid });
  return `${ENS_PAGE}?${params}`;
}

