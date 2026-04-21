/**
 * Cloudflare API helpers.
 *
 * Used by `nova site deploy` and `nova worker deploy` to provision the
 * gateway Worker + KV namespace + per-site DNS/route + KV entry +
 * DNSLink TXT record.
 *
 * Every API call accepts a CF API token and returns typed results.
 * All operations are idempotent: creating something that already exists
 * is treated as a no-op, not an error.
 */

const CF_API = "https://api.cloudflare.com/client/v4";

export interface CfTokenInfo {
  accountId: string;
  accountName: string;
}

interface CfResponse<T = unknown> {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  messages?: Array<{ code: number; message: string }>;
  result: T;
  result_info?: { page: number; per_page: number; count: number; total_count: number };
}

async function cfFetch<T = unknown>(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<CfResponse<T>> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  });
  return (await res.json()) as CfResponse<T>;
}

/**
 * Resolve which CF account a token belongs to.
 * CF tokens are scoped to one (or more) accounts; we use the first for
 * auto-provisioning. Users with multi-account tokens can pass cf_account_id
 * in deploy.json to override.
 */
export async function resolveAccount(token: string): Promise<CfTokenInfo> {
  const r = await cfFetch<Array<{ id: string; name: string }>>(token, "/accounts");
  if (!r.success || !r.result?.length) {
    throw new Error(
      `CF token has no accessible accounts. ${r.errors?.[0]?.message ?? ""}`.trim(),
    );
  }
  const first = r.result[0];
  if (!first) throw new Error("CF token returned zero accounts");
  return { accountId: first.id, accountName: first.name };
}

/**
 * Find or create a KV namespace by title. Returns the namespace id.
 */
export async function ensureKvNamespace(
  token: string,
  accountId: string,
  title: string,
): Promise<string> {
  const list = await cfFetch<Array<{ id: string; title: string }>>(
    token,
    `/accounts/${accountId}/storage/kv/namespaces?per_page=100`,
  );
  if (list.success && list.result) {
    const existing = list.result.find((n) => n.title === title);
    if (existing) return existing.id;
  }
  const create = await cfFetch<{ id: string }>(
    token,
    `/accounts/${accountId}/storage/kv/namespaces`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    },
  );
  if (!create.success || !create.result?.id) {
    throw new Error(`CF KV create failed: ${create.errors?.[0]?.message ?? "unknown"}`);
  }
  return create.result.id;
}

/**
 * Upload a Worker script (ESM module format) with optional KV binding.
 */
export async function uploadWorkerScript(
  token: string,
  accountId: string,
  scriptName: string,
  scriptSource: string,
  opts: {
    compatibilityDate?: string;
    kvBindings?: Array<{ name: string; namespaceId: string }>;
  } = {},
): Promise<string> {
  const metadata = {
    main_module: "worker.js",
    compatibility_date: opts.compatibilityDate ?? "2026-04-01",
    bindings: (opts.kvBindings ?? []).map((b) => ({
      type: "kv_namespace",
      name: b.name,
      namespace_id: b.namespaceId,
    })),
  };

  const form = new FormData();
  form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.set(
    "worker.js",
    new Blob([scriptSource], { type: "application/javascript+module" }),
    "worker.js",
  );

  const res = await fetch(`${CF_API}/accounts/${accountId}/workers/scripts/${scriptName}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const json = (await res.json()) as CfResponse<{ deployment_id?: string }>;
  if (!json.success) {
    throw new Error(`Worker upload failed: ${json.errors?.[0]?.message ?? "unknown"}`);
  }
  return json.result?.deployment_id ?? "";
}

/**
 * Put a value into a KV namespace. Overwrites if exists.
 */
export async function kvPut(
  token: string,
  accountId: string,
  namespaceId: string,
  key: string,
  value: string,
): Promise<void> {
  const res = await fetch(
    `${CF_API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain",
      },
      body: value,
    },
  );
  const json = (await res.json()) as CfResponse;
  if (!json.success) {
    throw new Error(`KV PUT failed: ${json.errors?.[0]?.message ?? "unknown"}`);
  }
}

/**
 * Create a proxied A record pointing at a placeholder IP.
 * CF intercepts at the edge for Worker routes so the IP is never reached.
 * Returns true if created, false if already existed.
 */
export async function ensureProxiedARecord(
  token: string,
  zoneId: string,
  name: string,
  comment = "Worker route placeholder",
): Promise<boolean> {
  const r = await cfFetch(token, `/zones/${zoneId}/dns_records`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "A",
      name,
      content: "192.0.2.1",
      proxied: true,
      comment,
    }),
  });
  if (r.success) return true;
  const code = r.errors?.[0]?.code;
  if (code === 81058 || code === 81057) return false;
  throw new Error(`DNS A-record create failed: ${r.errors?.[0]?.message ?? "unknown"}`);
}

/**
 * Ensure a Worker route exists binding <hostname>/* to a script.
 * Returns true if created, false if already existed.
 */
export async function ensureWorkerRoute(
  token: string,
  zoneId: string,
  pattern: string,
  scriptName: string,
): Promise<boolean> {
  const r = await cfFetch(token, `/zones/${zoneId}/workers/routes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pattern, script: scriptName }),
  });
  if (r.success) return true;
  if (r.errors?.[0]?.code === 10020) return false;
  throw new Error(`Worker route create failed: ${r.errors?.[0]?.message ?? "unknown"}`);
}

/**
 * Upsert a TXT record. Creates if missing, patches if present.
 */
export async function upsertTxt(
  token: string,
  zoneId: string,
  name: string,
  content: string,
  ttl = 300,
): Promise<void> {
  const list = await cfFetch<Array<{ id: string }>>(
    token,
    `/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(name)}`,
  );
  const existingId = list.result?.[0]?.id;
  if (existingId) {
    const r = await cfFetch(token, `/zones/${zoneId}/dns_records/${existingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!r.success) {
      throw new Error(`TXT patch failed: ${r.errors?.[0]?.message ?? "unknown"}`);
    }
  } else {
    const r = await cfFetch(token, `/zones/${zoneId}/dns_records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "TXT", name, content, ttl }),
    });
    if (!r.success) {
      throw new Error(`TXT create failed: ${r.errors?.[0]?.message ?? "unknown"}`);
    }
  }
}
