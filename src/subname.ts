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

/**
 * The label to use for a deploy: the caller's requested label (normalized) when
 * given, else one derived from the directory. Single source of truth for the
 * "what should this name be" decision across the CLI, MCP, and demo paths.
 */
export function deriveLabel(requestedLabel: string | undefined, directory: string): string {
  return requestedLabel ? normalizeLabel(requestedLabel) : suggestLabel(directory);
}

/** A label is plausibly valid client-side (Worker is authoritative). */
export function isValidLabel(label: string): boolean {
  return /^[a-z0-9-]{1,63}$/.test(label);
}

/** Does `owner` control this name? Case-insensitive; false if the name has no owner. */
export function isOwnedBy(status: SubnameStatus, owner: string): boolean {
  return !!status.owner && status.owner.toLowerCase() === owner.toLowerCase();
}

/** The address that owns (or would own) a subname when signed with this key. */
export function ownerForKey(key: string): string {
  return privateKeyToAccount(ensureHexKey(key)).address;
}

/** The full ENS name for a label under a parent (e.g. "happy" + "fcnova.eth"). */
export function fullNameOf(label: string, parent: string): string {
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
 * Outcome of one headless issuance attempt -- the shared decision logic behind
 * both the MCP tool and the CLI's non-interactive path. The availability check,
 * ownership gate, and error classification all live here; callers only switch on
 * `kind` to present the result (MCP -> JSON, CLI -> console).
 */
export type SubnameOutcome =
  | { kind: "issued"; result: IssueResult }
  | { kind: "invalid-label"; label: string; fullName: string }
  | { kind: "no-key"; fullName: string }
  | { kind: "taken"; fullName: string; owner?: string; raced: boolean }
  | { kind: "check-failed"; fullName: string; message: string }
  | { kind: "retry"; fullName: string; message: string }
  | { kind: "error"; fullName: string; message: string };

/**
 * Issue a gated subname once, non-interactively: validate the label, confirm a
 * signing key, gate on availability/ownership, then create-or-update. Never
 * throws -- every failure becomes a SubnameOutcome the caller can render.
 *
 * `raced` on a "taken" outcome distinguishes a name already taken at the
 * availability check (false) from one taken between check and write (true, 409).
 */
export async function issueSubnameOnce(opts: {
  workerUrl: string;
  signingKey?: string;
  walletAddress?: string;
  label: string;
  parent: string;
  cid: string;
  chain: SubnameChain;
}): Promise<SubnameOutcome> {
  const fullName = fullNameOf(opts.label, opts.parent);

  if (!isValidLabel(opts.label)) return { kind: "invalid-label", label: opts.label, fullName };
  if (!opts.signingKey) return { kind: "no-key", fullName };

  const owner = opts.walletAddress || ownerForKey(opts.signingKey);

  let status: SubnameStatus;
  try {
    status = await checkAvailability(opts.workerUrl, fullName);
  } catch (err: any) {
    return { kind: "check-failed", fullName, message: err.message };
  }
  if (status.exists && !isOwnedBy(status, owner)) {
    return { kind: "taken", fullName, owner: status.owner, raced: false };
  }

  try {
    const result = await issueSubname({
      workerUrl: opts.workerUrl,
      signingKey: opts.signingKey,
      owner,
      label: opts.label,
      parent: opts.parent,
      cid: opts.cid,
      chain: opts.chain,
    });
    return { kind: "issued", result };
  } catch (err: any) {
    if (err instanceof SubnameTakenError) return { kind: "taken", fullName, owner: err.owner, raced: true };
    if (err instanceof OwnerUnverifiableError) return { kind: "retry", fullName, message: err.message };
    return { kind: "error", fullName, message: err.message };
  }
}

/**
 * Issue a demo subname (no owner, no signature) under the demo parent, using the
 * user's chosen label (e.g. happy -> happy.demo.fcnova.eth). Demo names are
 * create-only: an existing name is never overwritten, so this throws
 * SubnameTakenError on a collision (the caller picks another name or skips).
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
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 409) {
    throw new SubnameTakenError(typeof body.fullName === "string" ? body.fullName : label);
  }
  if (!res.ok) {
    const reason = typeof body.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(`Demo subname issuance failed: ${reason}`);
  }
  return body as { fullName: string; url: string };
}
