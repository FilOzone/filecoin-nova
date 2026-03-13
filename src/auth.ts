/**
 * Shared Filecoin auth utilities for synapse-sdk.
 *
 * Two modes:
 * - Full auth (pinKey): signing client for uploads, deletes, etc.
 * - Read-only (walletAddress only): queries datasets, balances, etc.
 */

import { Synapse, mainnet, calibration } from "@filoz/synapse-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { createClient, http } from "viem";
import type { Hex, Address } from "viem";

export interface StorageAuth {
  pinKey?: string;
  walletAddress?: string;
}

export function ensureHexKey(key: string): Hex {
  return key.startsWith("0x") ? (key as Hex) : (`0x${key}` as Hex);
}

export function resolveWalletAddress(auth: StorageAuth): Address {
  if (auth.walletAddress) {
    return auth.walletAddress as Address;
  }
  if (auth.pinKey) {
    return privateKeyToAccount(ensureHexKey(auth.pinKey)).address;
  }
  throw new Error("No wallet address configured. Set NOVA_WALLET_ADDRESS env var.");
}

/**
 * Create a Synapse instance with full signing capability.
 * Required for write operations (upload, delete).
 */
export function createSynapse(auth: StorageAuth, isMainnet: boolean): Synapse {
  const chain = isMainnet ? mainnet : calibration;

  if (auth.pinKey) {
    const account = privateKeyToAccount(ensureHexKey(auth.pinKey));
    return Synapse.create({ account, chain, transport: http() });
  }

  throw new Error(
    "No Filecoin private key configured.\n\n" +
      "  Set NOVA_PIN_KEY env var, or sign via browser at https://fil.focify.eth.limo",
  );
}

/**
 * Create a read-only Synapse instance from just a wallet address.
 * For queries only (listPieces, getBalance, etc.). Cannot sign.
 *
 * Note: do NOT pass account to createClient -- viem uses it as `from` in
 * eth_call, and Filecoin FVM rejects calls from non-existent actors.
 */
export function createReadOnlySynapse(walletAddress: string, isMainnet: boolean): Synapse {
  const chain = isMainnet ? mainnet : calibration;
  const client = createClient({
    chain,
    transport: http(),
  });
  return new Synapse({ client } as any);
}
