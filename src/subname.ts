/**
 * Free, gasless ENS subname issuance -- client side. A pure thin client over the
 * Nova subname Worker: no Namespace SDK, no secrets (the master key lives only in
 * the Worker). The CLI signs each claim and asserts an owner; the Worker records
 * it on create and enforces it on update.
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
 * The Worker couldn't confirm right now that the signer controls the name's owner
 * (e.g. a transient Filecoin RPC failure). Retryable; the existing name is untouched.
 */
export class OwnerUnverifiableError extends Error {
  constructor(public readonly fullName: string) {
    super(`Could not confirm ownership of ${fullName} right now -- try again shortly.`);
    this.name = "OwnerUnverifiableError";
  }
}

/** The exact string that gets personal_sign'd. MUST stay byte-identical in the Worker. */
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

/** Convenience-only label normalization (the Worker re-validates authoritatively). */
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

/** The deploy's label: the requested one (normalized), else derived from the directory. */
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

/** Read a subname's current status (exists / available / owner / contenthash). */
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
 * Issue (create or update) a subname: sign the claim with `signingKey` and assert
 * `owner`. `chain` picks the SessionKeyRegistry for ownership-verified updates.
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

/** Result of one headless issuance attempt; callers switch on `kind` to present it. */
export type SubnameOutcome =
  | { kind: "issued"; result: IssueResult }
  | { kind: "invalid-label"; label: string; fullName: string }
  | { kind: "no-key"; fullName: string }
  | { kind: "taken"; fullName: string; owner?: string; raced: boolean }
  | { kind: "check-failed"; fullName: string; message: string }
  | { kind: "retry"; fullName: string; message: string }
  | { kind: "error"; fullName: string; message: string };

/**
 * Issue a gated subname once, non-interactively. Never throws -- every failure
 * becomes a SubnameOutcome. `raced` marks a name taken between check and write (409).
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
 * Issue a demo subname (no owner/signature) under the demo parent. Create-only:
 * throws SubnameTakenError on a collision (an existing name is never overwritten).
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
