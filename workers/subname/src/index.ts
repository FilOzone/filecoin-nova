/**
 * Nova subname issuance Worker -- sole holder of the master Namespace API key
 * (clients only fetch() it; they never see the key or import the SDK).
 *
 * One key issues names under SUBNAME_PARENT. Gated names are single-label
 * (happy.fcnova.eth, signature-checked). Demo names nest under a reserved
 * DEMO_LABEL (happy.demo.fcnova.eth) -- ungated but create-only, never overwritten.
 * LABEL_RE forbids dots, so the gated and demo namespaces stay disjoint.
 */

import { createOffchainClient, validateSubname } from "@thenamespace/offchain-manager";
import { recoverMessageAddress, keccak256, toBytes } from "viem";
import { CID } from "multiformats/cid";

export interface Env {
  SUBNAME_PARENT: string;
  DEMO_LABEL: string;
  NAMESPACE_API_KEY: string;
  RATELIMIT: KVNamespace;
  /** Optional Filecoin RPC overrides (secrets). Default to glif if unset. */
  FIL_RPC_MAINNET?: string;
  FIL_RPC_CALIBRATION?: string;
}

export const CLAIM_MAX_SKEW = 900; // expiry must be within 15 min of now
export const LABEL_RE = /^[a-z0-9-]{1,63}$/;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

/** MUST stay byte-identical to buildClaimMessage() in src/subname.ts. */
export function buildClaimMessage(c: {
  label: string;
  parent: string;
  cid: string;
  expiry: number;
  owner: string;
}): string {
  return [
    "Nova subname claim",
    `label: ${c.label}`,
    `parent: ${c.parent}`,
    `cid: ${c.cid}`,
    `expiry: ${c.expiry}`,
    `owner: ${c.owner}`,
  ].join("\n");
}

// --- SessionKeyRegistry: resolve a session (delegate) key -> its root wallet ---
// Same contracts/event the CLI's poll.ts reads. Used only on UPDATE, to confirm
// a browser session key is authorized for the name's stored owner.
const SESSION_KEY_REGISTRY: Record<string, string> = {
  mainnet: "0x74FD50525A958aF5d484601E252271f9625231aB",
  calibration: "0x518411c2062E119Aaf7A8B12A2eDf9a939347655",
};
const FIL_RPC: Record<string, string> = {
  mainnet: "https://api.node.glif.io/rpc/v1",
  calibration: "https://api.calibration.node.glif.io/rpc/v1",
};
// Login(address indexed root, address indexed signer, uint256, uint256)
const LOGIN_TOPIC = keccak256(toBytes("Login(address,address,uint256,uint256)"));

class RpcError extends Error {}

/**
 * Resolve the root wallet that authorized `signer` on the SessionKeyRegistry
 * (scans recent Login events). Returns null if none; throws RpcError on transient
 * RPC failure so the caller returns a retryable 503, never a wrong verdict.
 */
async function resolveRoot(signer: string, chain: string, env: Env): Promise<string | null> {
  const registry = SESSION_KEY_REGISTRY[chain];
  const rpc =
    (chain === "mainnet" ? env.FIL_RPC_MAINNET : env.FIL_RPC_CALIBRATION) || FIL_RPC[chain];
  if (!registry || !rpc) throw new RpcError(`unknown chain: ${chain}`);

  const call = async (method: string, params: unknown[]) => {
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!res.ok) throw new RpcError(`rpc ${method} ${res.status}`);
    const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (j.error) throw new RpcError(j.error.message || `rpc ${method} error`);
    return j.result;
  };

  let latest: number;
  try {
    latest = Number(await call("eth_blockNumber", []));
  } catch (e) {
    throw e instanceof RpcError ? e : new RpcError(String(e));
  }
  // glif caps eth_getLogs at 2880 blocks; stay safely under it. ~23h of Filecoin
  // blocks (~30s each) -- a fresh wallet-auth re-registers each session, so the
  // session key we're resolving is always minutes old, well inside this window.
  const fromBlock = `0x${Math.max(0, latest - 2800).toString(16)}`;
  const signerTopic = `0x000000000000000000000000${signer.slice(2).toLowerCase()}`;

  let logs: any;
  try {
    logs = await call("eth_getLogs", [
      { address: registry, topics: [LOGIN_TOPIC, null, signerTopic], fromBlock, toBlock: "latest" },
    ]);
  } catch (e) {
    throw e instanceof RpcError ? e : new RpcError(String(e));
  }

  if (!Array.isArray(logs) || logs.length === 0) return null;
  const rootTopic = logs[logs.length - 1]?.topics?.[1] as string | undefined; // most recent
  if (!rootTopic) return null;
  return `0x${rootTopic.slice(26)}`;
}

/** Normalize any CID form to the Namespace contenthash string ipfs://<cidv1>. */
export function toContenthash(cid: string): string {
  return `ipfs://${CID.parse(cid).toV1().toString()}`;
}

function client(env: Env) {
  return createOffchainClient({ mode: "mainnet", defaultApiKey: env.NAMESPACE_API_KEY });
}

/** Crude per-IP rate limit over a fixed window (KV is eventually consistent). */
async function rateLimited(
  env: Env,
  ip: string,
  bucket: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  const key = `rl:${bucket}:${ip}`;
  const cur = Number((await env.RATELIMIT.get(key)) || "0");
  if (cur >= limit) return true;
  await env.RATELIMIT.put(key, String(cur + 1), { expirationTtl: windowSec });
  return false;
}

async function handleStatus(url: URL, env: Env): Promise<Response> {
  const name = url.searchParams.get("name");
  if (!name) return json({ error: "missing name" }, 400);
  const c = client(env);
  const sub = await c.getSingleSubname(name).catch(() => null);
  let available = !sub;
  try {
    available = (await c.isSubnameAvailable(name)).isAvailable;
  } catch {
    /* fall back to !sub */
  }
  return json({ exists: !!sub, available, owner: sub?.owner, contenthash: sub?.contenthash });
}

async function handleIssue(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  if (await rateLimited(env, ip, "issue", 30, 600)) return json({ error: "rate_limited" }, 429);

  let body: {
    label?: string;
    parent?: string;
    cid?: string;
    expiry?: number;
    owner?: string;
    signature?: string;
    chain?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  const { label, parent, cid, expiry, owner, signature } = body;
  const chain = body.chain === "calibration" ? "calibration" : "mainnet";

  if (!label || !parent || !cid || !expiry || !owner || !signature)
    return json({ error: "missing_fields" }, 400);
  // Gated names only ever live under SUBNAME_PARENT; the demo parent is handled
  // by /demo-issue, so this naturally rejects any demo.<parent> claim here.
  if (parent !== env.SUBNAME_PARENT) return json({ error: "invalid_parent" }, 400);
  if (!LABEL_RE.test(label)) return json({ error: "invalid_label" }, 400);
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) return json({ error: "invalid_owner" }, 400);

  const fullName = `${label}.${parent}`;
  try {
    validateSubname(fullName);
  } catch {
    return json({ error: "invalid_label" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  if (expiry < now) return json({ error: "expired" }, 400);
  if (expiry > now + CLAIM_MAX_SKEW) return json({ error: "expiry_too_far" }, 400);

  let contenthash: string;
  try {
    contenthash = toContenthash(cid);
  } catch {
    return json({ error: "bad_cid" }, 400);
  }

  let signer: string;
  try {
    signer = await recoverMessageAddress({
      message: buildClaimMessage({ label, parent, cid, expiry, owner }),
      signature: signature as `0x${string}`,
    });
  } catch {
    return json({ error: "bad_signature" }, 401);
  }

  const replayKey = `sig:${keccak256(toBytes(signature))}`;
  if (await env.RATELIMIT.get(replayKey)) return json({ error: "replay" }, 401);
  await env.RATELIMIT.put(replayKey, "1", { expirationTtl: CLAIM_MAX_SKEW });

  const c = client(env);
  const existing = await c.getSingleSubname(fullName).catch(() => null);
  const url = `https://${fullName}.limo`;

  // CREATE: trust the asserted owner. No on-chain read -- a wrong owner only
  // self-griefs (the named owner can reclaim; the setter can never update it).
  if (!existing) {
    await c.createSubname({ parentName: parent, label, owner, contenthash });
    return json({ status: "created", fullName, url, owner });
  }

  // UPDATE: the signer must control the STORED owner. Either the signer IS the
  // owner (disk key), or the signer is a session key the owner authorized on the
  // SessionKeyRegistry (browser). A transient RPC failure is a retryable 503 --
  // never a silent allow, never an overwrite.
  const storedOwner = existing.owner || "";
  if (storedOwner && storedOwner.toLowerCase() === signer.toLowerCase()) {
    await c.updateSubname(fullName, { contenthash });
    return json({ status: "updated", fullName, url, owner: storedOwner });
  }
  let root: string | null;
  try {
    root = await resolveRoot(signer, chain, env);
  } catch {
    return json({ error: "owner_unverifiable" }, 503);
  }
  if (root && storedOwner && root.toLowerCase() === storedOwner.toLowerCase()) {
    await c.updateSubname(fullName, { contenthash });
    return json({ status: "updated", fullName, url, owner: storedOwner });
  }
  return json({ status: "taken_by_other", owner: existing.owner }, 409);
}

async function handleDemoIssue(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  if (await rateLimited(env, ip, "demo", 10, 600)) return json({ error: "rate_limited" }, 429);

  let body: { cid?: string; label?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }
  if (!body.cid) return json({ error: "missing_cid" }, 400);
  if (!body.label) return json({ error: "missing_label" }, 400);
  if (!LABEL_RE.test(body.label)) return json({ error: "invalid_label" }, 400);

  let contenthash: string;
  try {
    contenthash = toContenthash(body.cid);
  } catch {
    return json({ error: "bad_cid" }, 400);
  }

  // Nest the user's label one level under the reserved demo segment, issued
  // under the SAME parent + key: "happy" -> label "happy.demo" -> happy.demo.fcnova.eth.
  const nestedLabel = `${body.label}.${env.DEMO_LABEL}`;
  const fullName = `${nestedLabel}.${env.SUBNAME_PARENT}`;
  try {
    validateSubname(fullName);
  } catch {
    return json({ error: "invalid_label" }, 400);
  }

  // Ungated (no owner, no signature) but CREATE-ONLY: a demo name is first-come
  // and is never overwritten. Otherwise anyone could silently hijack a shared
  // <label>.demo URL. The CID is the deliverable; the name is a best-effort bonus.
  const c = client(env);
  const existing = await c.getSingleSubname(fullName).catch(() => null);
  if (existing) return json({ status: "taken_by_other", fullName }, 409);
  await c.createSubname({ parentName: env.SUBNAME_PARENT, label: nestedLabel, contenthash });
  return json({ fullName, url: `https://${fullName}.limo` });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/status") return await handleStatus(url, env);
      if (req.method === "POST" && url.pathname === "/issue") return await handleIssue(req, env);
      if (req.method === "POST" && url.pathname === "/demo-issue") return await handleDemoIssue(req, env);
      return json({ error: "not_found" }, 404);
    } catch (err: any) {
      return json({ error: err?.message || "internal_error" }, 500);
    }
  },
};
