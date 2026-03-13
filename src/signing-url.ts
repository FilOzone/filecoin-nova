/**
 * Construct pre-filled URLs for browser signing pages.
 * These pages let users sign transactions via MetaMask
 * without pasting private keys into chat.
 */

const ENS_PAGE = "https://ens.focify.eth.limo";
const WALLET_AUTH_PAGE = "https://fil.focify.eth.limo";

export function walletAuthUrl(ephemeralKey: string, chain?: number): string {
  const params = new URLSearchParams({ sessionKey: ephemeralKey });
  if (chain) params.set("chain", String(chain));
  return `${WALLET_AUTH_PAGE}?${params}`;
}

export function ensSigningUrl(ensName: string, cid: string): string {
  const params = new URLSearchParams({ name: ensName, cid });
  return `${ENS_PAGE}?${params}`;
}

