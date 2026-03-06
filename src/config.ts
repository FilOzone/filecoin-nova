import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".config", "filecoin-nova");
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials");

export interface ResolvedConfig {
  pinKey?: string;
  ensKey?: string;
  ensName?: string;
  providerId?: number;
  rpcUrl?: string;
}

export interface Credentials {
  pinKey?: string;
  ensKey?: string;
  ensName?: string;
  providerId?: number;
  rpcUrl?: string;
}

/**
 * Read credentials from ~/.config/filecoin-nova/credentials.
 * Returns empty object if file doesn't exist.
 */
export function readCredentials(): Credentials {
  try {
    const content = readFileSync(CREDENTIALS_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Write credentials to ~/.config/filecoin-nova/credentials with 600 permissions.
 */
export function writeCredentials(creds: Credentials): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2) + "\n", {
    mode: 0o600,
  });
}

/**
 * Get the path to the credentials file.
 */
export function credentialsPath(): string {
  return CREDENTIALS_FILE;
}

/**
 * Resolve config from credentials file, then environment variables.
 * Env vars override credentials file values.
 */
export function resolveConfig(env: NodeJS.ProcessEnv): ResolvedConfig {
  const creds = readCredentials();

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
  } else {
    providerId = creds.providerId;
  }

  return {
    pinKey: env.NOVA_PIN_KEY || creds.pinKey,
    ensKey: env.NOVA_ENS_KEY || creds.ensKey,
    ensName: env.NOVA_ENS_NAME || creds.ensName,
    providerId,
    rpcUrl: env.NOVA_RPC_URL || creds.rpcUrl,
  };
}
