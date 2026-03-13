/**
 * PDP Scan subgraph queries (Goldsky).
 *
 * Fetches on-chain timestamps, raw sizes, and proof data for pieces.
 * rootId in the subgraph maps to pieceId in synapse-sdk.
 */

const SUBGRAPH_URLS = {
  mainnet:
    "https://api.goldsky.com/api/public/project_cmdfaaxeuz6us01u359yjdctw/subgraphs/pdp-explorer/mainnet311a/gn",
  calibration:
    "https://api.goldsky.com/api/public/project_cmdfaaxeuz6us01u359yjdctw/subgraphs/pdp-explorer/calibration311a/gn",
} as const;

export interface RootInfo {
  rootId: number;
  rawSize: number;
  createdAt: number;
  removed: boolean;
  lastProvenAt: number;
  totalProofsSubmitted: number;
}

export interface DataSetRoots {
  setId: string;
  createdAt: number;
  roots: RootInfo[];
}

/**
 * Fetch roots (pieces) for one or more datasets from the subgraph.
 * Returns a map of dataSetId -> DataSetRoots.
 */
export async function fetchDataSetRoots(
  dataSetIds: bigint[],
  isMainnet: boolean,
): Promise<Map<bigint, DataSetRoots>> {
  const url = isMainnet ? SUBGRAPH_URLS.mainnet : SUBGRAPH_URLS.calibration;
  const ids = dataSetIds.map((id) => `"${id}"`).join(", ");

  type RawRoot = {
    rootId: string;
    rawSize: string;
    createdAt: string;
    removed: boolean;
    lastProvenAt: string;
    totalProofsSubmitted: string;
  };
  type RawDataSet = {
    setId: string;
    createdAt: string;
    roots: RawRoot[];
  };

  // Paginate: subgraph caps at 1000 per query, use rootId cursor to fetch all
  const PAGE_SIZE = 1000;
  const allDataSets = new Map<string, { setId: string; createdAt: string; roots: RawRoot[] }>();

  let lastRootId = 0;
  let hasMore = true;
  while (hasMore) {
    const query = `{
      dataSets(where: { setId_in: [${ids}] }) {
        setId
        createdAt
        roots(first: ${PAGE_SIZE}, orderBy: rootId, orderDirection: asc, where: { rootId_gt: ${lastRootId} }) {
          rootId
          rawSize
          createdAt
          removed
          lastProvenAt
          totalProofsSubmitted
        }
      }
    }`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      throw new Error(`Subgraph query failed: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as {
      data?: { dataSets: RawDataSet[] };
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      throw new Error(`Subgraph error: ${json.errors[0].message}`);
    }

    let pageRootCount = 0;
    for (const ds of json.data?.dataSets ?? []) {
      const existing = allDataSets.get(ds.setId);
      if (existing) {
        existing.roots.push(...ds.roots);
      } else {
        allDataSets.set(ds.setId, { setId: ds.setId, createdAt: ds.createdAt, roots: [...ds.roots] });
      }
      for (const r of ds.roots) {
        const rid = Number(r.rootId);
        if (rid > lastRootId) lastRootId = rid;
        pageRootCount++;
      }
    }

    hasMore = pageRootCount >= PAGE_SIZE;
  }

  const result = new Map<bigint, DataSetRoots>();
  for (const ds of allDataSets.values()) {
    result.set(BigInt(ds.setId), {
      setId: ds.setId,
      createdAt: Number(ds.createdAt),
      roots: ds.roots.map((r) => ({
        rootId: Number(r.rootId),
        rawSize: Number(r.rawSize),
        createdAt: Number(r.createdAt),
        removed: r.removed,
        lastProvenAt: Number(r.lastProvenAt),
        totalProofsSubmitted: Number(r.totalProofsSubmitted),
      })),
    });
  }

  return result;
}

/**
 * Format a Unix timestamp as relative time ("2h ago", "3 days ago").
 */
export function relativeTime(unixSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixSeconds;

  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 2592000) return `${Math.floor(diff / 604800)}w ago`;
  return `${Math.floor(diff / 2592000)}mo ago`;
}
