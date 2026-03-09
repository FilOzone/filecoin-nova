/**
 * Construct pre-filled URLs for browser signing pages.
 * These pages let users sign transactions via MetaMask
 * without pasting private keys into chat.
 */

const ENS_PAGE = "https://ens.focify.eth.limo";
const FIL_PAGE = "https://fil.focify.eth.limo";
const SESSION_PAGE = "https://session.focify.eth.limo";

export function ensSigningUrl(ensName: string, cid: string): string {
  const params = new URLSearchParams({ name: ensName, cid });
  return `${ENS_PAGE}?${params}`;
}

export interface FilTxSpec {
  to: string;
  abi?: string;
  args?: string[];
  data?: string;
  value?: string;
  label?: string;
}

export function filSigningUrl(opts: {
  txs?: FilTxSpec[];
  to?: string;
  abi?: string;
  args?: string[];
  chain?: number;
  description?: string;
  label?: string;
}): string {
  const params = new URLSearchParams();

  if (opts.txs && opts.txs.length > 0) {
    params.set("txs", JSON.stringify(opts.txs));
  } else if (opts.to) {
    params.set("to", opts.to);
    if (opts.abi) params.set("abi", opts.abi);
    if (opts.args) params.set("args", JSON.stringify(opts.args));
    if (opts.label) params.set("label", opts.label);
  }

  if (opts.chain) params.set("chain", String(opts.chain));
  if (opts.description) params.set("description", opts.description);

  return `${FIL_PAGE}?${params}`;
}

export function sessionKeySigningUrl(chain: "mainnet" | "calibration"): string {
  const chainId = chain === "mainnet" ? 314 : 314159;
  return `${SESSION_PAGE}?chain=${chainId}`;
}
