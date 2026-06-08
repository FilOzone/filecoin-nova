/**
 * Free, gasless ENS subname issuance -- client side.
 *
 * This module is a PURE thin client over the Nova-operated subname Worker.
 * It does NOT import the Namespace SDK and holds NO secrets: the master
 * Namespace API key lives only in the Worker (see workers/subname/). All this
 * module knows is the Worker URL and the claim-message format.
 *
 * Ownership model (one rule, no separate page):
 *   The CLI signs the claim with whatever key it holds and ASSERTS an owner:
 *     - disk pin key (the wallet)      -> sign with it, owner = its own address
 *     - browser session key (delegate) -> sign with it, owner = the real wallet
 *       (the CLI already learned the real wallet from the on-chain Login event)
 *   The Worker recovers the signer and:
 *     - on CREATE  -> records owner = the asserted owner (no on-chain read;
 *       a wrong owner only self-griefs, so this is safe and RPC-free)
 *     - on UPDATE  -> requires the signer to control the stored owner: either
 *       signer == owner directly (disk key), or signer resolves to owner via
 *       the SessionKeyRegistry (browser session key). RPC failure there is
 *       retryable -- the name keeps its old CID, the deploy is never lost.
 */

import { basename } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { ensureHexKey } from "./auth.js";

/** How long a signed claim stays valid before the Worker rejects it. */
export const CLAIM_TTL_SECONDS = 600;

export type SubnameChain = "mainnet" | "calibration";

export interface SubnameClaim {
  label: string;
  parent: string;
  cid: string;
  expiry: number;
  /** Address recorded as owner on create (the wallet the deployer controls). */
  owner: string;
}

export interface SubnameStatus {
  exists: boolean;
  available: boolean;
  owner?: string;
  contenthash?: string;
}

export interface IssueResult {
  status: "created" | "updated";
  fullName: string;
  url: string;
  owner: string;
}

/** Distinct error so callers can offer "pick another name" without leaking the owner check. */
export class SubnameTakenError extends Error {
  constructor(
    public readonly fullName: string,
    public readonly owner?: string,
  ) {
    super(`Subname is taken by another owner: ${fullName}`);
    this.name = "SubnameTakenError";
  }
}

/**
 * Update couldn't be authorized because the Worker couldn't confirm, right now,
 * that the signer controls the name's owner (e.g. a transient Filecoin RPC
 * failure resolving the session key -> wallet). Retryable; the existing name is
 * untouched and the new content is still live at the gateway.
 */
export class OwnerUnverifiableError extends Error {
  constructor(public readonly fullName: string) {
    super(`Could not confirm ownership of ${fullName} right now -- try again shortly.`);
    this.name = "OwnerUnverifiableError";
  }
}

/**
 * The exact string that gets personal_sign'd. Single source of truth for the
 * claim -- it MUST stay byte-identical here and in the Worker, or recovered
 * signers won't match.
 */
export function buildClaimMessage(claim: SubnameClaim): string {
  return [
    "Nova subname claim",
    `label: ${claim.label}`,
    `parent: ${claim.parent}`,
    `cid: ${claim.cid}`,
    `expiry: ${claim.expiry}`,
    `owner: ${claim.owner}`,
  ].join("\n");
}

/**
 * Convenience-only label normalization. The Worker re-validates
 * authoritatively (validateSubname + regex), so this is just to give the
 * user a sensible default and early feedback.
 */
export function normalizeLabel(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-]+/g, "-") // spaces and invalid chars -> hyphen
    .replace(/-+/g, "-") // collapse runs
    .replace(/^-+|-+$/g, "") // trim leading/trailing hyphens
    .slice(0, 63);
}

/** Suggest a label from a directory path (its basename). */
export function suggestLabel(dir: string): string {
  return normalizeLabel(basename(dir.replace(/[/\\]+$/, "")));
}

/** A label is plausibly valid client-side (Worker is authoritative). */
export function isValidLabel(label: string): boolean {
  return /^[a-z0-9-]{1,63}$/.test(label);
}

/** The address that owns (or would own) a subname when signed with this key. */
export function ownerForKey(key: string): string {
  return privateKeyToAccount(ensureHexKey(key)).address;
}

function fullNameOf(label: string, parent: string): string {
  return `${label}.${parent}`;
}

/**
 * Read current status of a subname (exists / available / owner / contenthash).
 * Backs the CLI name loop.
 */
export async function checkAvailability(
  workerUrl: string,
  fullName: string,
): Promise<SubnameStatus> {
  const url = `${workerUrl.replace(/\/$/, "")}/status?name=${encodeURIComponent(fullName)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Subname status check failed (${res.status})`);
  }
  return (await res.json()) as SubnameStatus;
}

/**
 * Issue (create or update) a subname.
 *
 * Signs the claim with `signingKey` (the disk pin key, or the browser session
 * key) and asserts `owner` (the wallet the deployer controls). `chain` tells the
 * Worker which SessionKeyRegistry to use if it must resolve a session key to its
 * wallet during an ownership-verified update.
 */
export async function issueSubname(opts: {
  workerUrl: string;
  signingKey: string;
  owner: string;
  label: string;
  parent: string;
  cid: string;
  chain: SubnameChain;
}): Promise<IssueResult> {
  const claim: SubnameClaim = {
    label: opts.label,
    parent: opts.parent,
    cid: opts.cid,
    expiry: Math.floor(Date.now() / 1000) + CLAIM_TTL_SECONDS,
    owner: opts.owner,
  };
  const account = privateKeyToAccount(ensureHexKey(opts.signingKey));
  const signature = await account.signMessage({ message: buildClaimMessage(claim) });

  const res = await fetch(`${opts.workerUrl.replace(/\/$/, "")}/issue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...claim, signature, chain: opts.chain }),
  });

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const fullName = fullNameOf(opts.label, opts.parent);

  if (res.status === 409) {
    throw new SubnameTakenError(fullName, typeof body.owner === "string" ? body.owner : undefined);
  }
  if (res.status === 503) {
    throw new OwnerUnverifiableError(fullName);
  }
  if (!res.ok) {
    const reason = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(`Subname issuance failed: ${reason}`);
  }

  return {
    status: body.status === "updated" ? "updated" : "created",
    fullName: (body.fullName as string) || fullName,
    url: (body.url as string) || `https://${fullName}.limo`,
    owner: (body.owner as string) || opts.owner,
  };
}

/**
 * Issue a throwaway demo subname (no owner, no signature) under the demo parent,
 * using the user's chosen label (e.g. happy -> happy.demo.fcnova.eth).
 */
export async function issueDemoSubname(
  workerUrl: string,
  cid: string,
  label: string,
): Promise<{ fullName: string; url: string }> {
  const res = await fetch(`${workerUrl.replace(/\/$/, "")}/demo-issue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cid, label }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const reason = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(`Demo subname issuance failed: ${reason}`);
  }
  const body = (await res.json()) as { fullName: string; url: string };
  return body;
}
