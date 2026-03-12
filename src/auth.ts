/**
 * Shared Filecoin auth utilities for synapse-sdk.
 *
 * Handles session key and private key authentication modes.
 * Session key auth uses the root wallet address as the main client
 * (for dataset lookups/ownership) and the session key as the session
 * client (for signing addPieces, createDataSet, deletePiece, etc.).
 */

import { Synapse, mainnet, calibration } from "@filoz/synapse-sdk";
import { fromSecp256k1 } from "@filoz/synapse-core/session-key";
import { privateKeyToAccount } from "viem/accounts";
import { createClient, http } from "viem";
import type { Hex, Address } from "viem";

export interface StorageAuth {
  pinKey?: string;
  sessionKey?: string;
  walletAddress?: string;
}

export function ensureHexKey(key: string): Hex {
  return key.startsWith("0x") ? (key as Hex) : (`0x${key}` as Hex);
}

export function resolveWalletAddress(auth: StorageAuth): Address {
  if (auth.sessionKey && auth.walletAddress) {
    return auth.walletAddress as Address;
  }
  if (auth.pinKey) {
    return privateKeyToAccount(ensureHexKey(auth.pinKey)).address;
  }
  throw new Error("No Filecoin auth configured.");
}

export function createSynapse(auth: StorageAuth, isMainnet: boolean): Synapse {
  const chain = isMainnet ? mainnet : calibration;

  if (auth.sessionKey && auth.walletAddress) {
    const sessionKeyObj = fromSecp256k1({
      privateKey: ensureHexKey(auth.sessionKey),
      root: auth.walletAddress as Address,
      chain,
    });
    // Use root wallet address as the main client so that dataset lookups
    // (getClientDataSets, ownership checks) resolve against the correct address.
    // The session key client handles signing (addPieces, createDataSet, etc.).
    const client = createClient({
      chain,
      transport: http(),
      account: auth.walletAddress as Address,
    });
    return new Synapse({ client, sessionClient: sessionKeyObj.client });
  }

  if (auth.pinKey) {
    const account = privateKeyToAccount(ensureHexKey(auth.pinKey));
    return Synapse.create({ account, chain, transport: http() });
  }

  throw new Error(
    "No Filecoin auth configured.\n\n" +
      "  Set NOVA_SESSION_KEY + NOVA_WALLET_ADDRESS env vars,\n" +
      "  or create a session key at https://session.focify.eth.limo",
  );
}
