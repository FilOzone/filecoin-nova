import { WarmStorageService } from "@filoz/synapse-sdk/warm-storage";
import { StorageContext } from "@filoz/synapse-sdk/storage";
import { getSizeFromPieceCID } from "@filoz/synapse-core/piece";
import { CID } from "multiformats/cid";
import { createSynapse, createReadOnlySynapse, resolveWalletAddress, type StorageAuth } from "./auth.js";
import { fetchDataSetRoots } from "./subgraph.js";

/** Normalize a CID string to CIDv1 base32 for consistent comparison. */
export function toCidV1(cidStr: string): string {
  try {
    return CID.parse(cidStr).toV1().toString();
  } catch {
    return cidStr;
  }
}

export interface PieceInfo {
  pieceId: bigint;
  pieceCid: string;
  sizeBytes: number;
  rawSizeBytes: number | null;
  ipfsRootCID: string | null;
  label: string | null;
  pendingRemoval: boolean;
  createdAt: number | null;
  lastProvenAt: number | null;
  totalProofsSubmitted: number | null;
}

export interface CIDGroup {
  ipfsRootCID: string;
  label: string | null;
  pieces: PieceInfo[];
  totalPieces: number;
  activePieces: number;
  duplicateActivePieces: number;
  totalSizeBytes: number;
  totalRawSizeBytes: number | null;
  lowestPieceId: bigint;
  highestPieceId: bigint;
  createdAt: number | null;
  lastProvenAt: number | null;
  totalProofsSubmitted: number | null;
}

export interface DataSetSummary {
  dataSetId: bigint;
  providerId: bigint;
  providerName: string;
  activePieceCount: bigint;
  isLive: boolean;
  groups: CIDGroup[];
  orphanPieces: PieceInfo[];
  pendingRemovalCount: number;
}

export type { StorageAuth } from "./auth.js";

function pieceSizeBytes(pieceCid: string): number {
  if (!pieceCid) return 0;
  try {
    return getSizeFromPieceCID(pieceCid);
  } catch {
    return 0;
  }
}

/**
 * List all datasets and their pieces grouped by IPFS root CID.
 */
export async function listPieces(opts: StorageAuth & {
  mainnet: boolean;
}): Promise<DataSetSummary[]> {
  const address = resolveWalletAddress(opts);
  const synapse = opts.pinKey
    ? createSynapse(opts, opts.mainnet)
    : createReadOnlySynapse(address, opts.mainnet);
  const warmStorage = new WarmStorageService({ client: synapse.client });

  let datasets;
  try {
    datasets = await warmStorage.getClientDataSetsWithDetails({
      address,
    });
  } catch (err: any) {
    // "actor not found" means the wallet has never transacted on this network
    if (err?.message?.includes("actor not found") || err?.details?.includes("actor not found")) {
      return [];
    }
    throw err;
  }
  if (datasets.length === 0) return [];

  // Start subgraph fetch early (runs in parallel with SDK queries)
  const liveDatasets = datasets.filter((ds) => ds.isLive);
  const subgraphPromise = fetchDataSetRoots(
    liveDatasets.map((ds) => ds.dataSetId),
    opts.mainnet,
  ).catch(() => new Map<bigint, import("./subgraph.js").DataSetRoots>());

  // Pre-fetch all provider names in parallel
  const providerNames = new Map<bigint, string>();
  const uniqueProviderIds = [...new Set(liveDatasets.map((ds) => ds.providerId))];
  await Promise.all(
    uniqueProviderIds.map(async (pid) => {
      try {
        const info = await synapse.getProviderInfo(pid);
        providerNames.set(pid, info.name || `provider ${pid}`);
      } catch {
        providerNames.set(pid, `provider ${pid}`);
      }
    }),
  );

  const summaries: DataSetSummary[] = [];

  for (const ds of liveDatasets) {
    const dataSetId = ds.dataSetId;
    const providerName = providerNames.get(ds.providerId) || `provider ${ds.providerId}`;

    // Get all pieces via StorageContext.getPieces()
    const pieces: PieceInfo[] = [];
    let scheduledSet = new Set<bigint>();
    try {
      const ctx = await StorageContext.create({
        synapse,
        warmStorageService: warmStorage,
        dataSetId,
        providerId: ds.providerId,
      });

      // Fetch scheduled removals
      try {
        const scheduled = await ctx.getScheduledRemovals();
        scheduledSet = new Set(scheduled.map((id: bigint | number) => BigInt(id)));
      } catch {
        // May not be available
      }

      // Collect all pieces first, then batch-fetch metadata in parallel
      const rawPieces: Array<{ pieceId: bigint; pieceCid: string }> = [];
      for await (const piece of ctx.getPieces()) {
        rawPieces.push({ pieceId: piece.pieceId, pieceCid: String(piece.pieceCid) });
      }

      // Fetch metadata for all pieces concurrently (10 at a time)
      const BATCH_SIZE = 10;
      for (let batch = 0; batch < rawPieces.length; batch += BATCH_SIZE) {
        const chunk = rawPieces.slice(batch, batch + BATCH_SIZE);
        const results = await Promise.all(
          chunk.map(async (p) => {
            const [ipfsRootCID, pieceLabel] = await Promise.all([
              warmStorage.getPieceMetadataByKey({ dataSetId, pieceId: p.pieceId, key: "ipfsRootCID" }).catch(() => null),
              warmStorage.getPieceMetadataByKey({ dataSetId, pieceId: p.pieceId, key: "label" }).catch(() => null),
            ]);
            return { ...p, ipfsRootCID, label: pieceLabel };
          }),
        );
        for (const r of results) {
          pieces.push({
            pieceId: r.pieceId,
            pieceCid: r.pieceCid,
            sizeBytes: pieceSizeBytes(r.pieceCid),
            rawSizeBytes: null,
            ipfsRootCID: r.ipfsRootCID,
            label: r.label,
            pendingRemoval: scheduledSet.has(r.pieceId),
            createdAt: null,
            lastProvenAt: null,
            totalProofsSubmitted: null,
          });
        }
      }
    } catch {
      // If context creation fails, try fetching metadata directly
      const count = Number(ds.activePieceCount);
      for (let i = 0; i < count + 10; i++) {
        try {
          const meta = await warmStorage.getPieceMetadata({
            dataSetId,
            pieceId: BigInt(i),
          });
          const metaObj = meta as Record<string, string>;
          pieces.push({
            pieceId: BigInt(i),
            pieceCid: "",
            sizeBytes: 0,
            rawSizeBytes: null,
            ipfsRootCID: metaObj.ipfsRootCID || null,
            label: metaObj.label || null,
            pendingRemoval: scheduledSet.has(BigInt(i)),
            createdAt: null,
            lastProvenAt: null,
            totalProofsSubmitted: null,
          });
        } catch {
          // Piece doesn't exist (removed or past end)
        }
      }
    }

    // Group by ipfsRootCID
    const groupMap = new Map<string, PieceInfo[]>();
    const orphans: PieceInfo[] = [];

    for (const p of pieces) {
      if (p.ipfsRootCID) {
        const group = groupMap.get(p.ipfsRootCID);
        if (group) {
          group.push(p);
        } else {
          groupMap.set(p.ipfsRootCID, [p]);
        }
      } else {
        orphans.push(p);
      }
    }

    const groups: CIDGroup[] = [];
    for (const [cid, gPieces] of groupMap) {
      const ids = gPieces.map((p) => p.pieceId);
      const active = gPieces.filter((p) => !p.pendingRemoval).length;
      // Use the label from the most recent piece in the group
      const sortedByIdDesc = [...gPieces].sort((a, b) =>
        b.pieceId > a.pieceId ? 1 : b.pieceId < a.pieceId ? -1 : 0,
      );
      const groupLabel = sortedByIdDesc.find((p) => p.label)?.label ?? null;
      // Use the most recent piece's createdAt for the group timestamp
      const latestPiece = sortedByIdDesc[0];
      const rawSizes = gPieces.map((p) => p.rawSizeBytes).filter((s): s is number => s !== null);
      groups.push({
        ipfsRootCID: cid,
        label: groupLabel,
        pieces: gPieces,
        totalPieces: gPieces.length,
        activePieces: active,
        duplicateActivePieces: Math.max(0, active - 1),
        totalSizeBytes: gPieces.reduce((sum, p) => sum + p.sizeBytes, 0),
        totalRawSizeBytes: rawSizes.length > 0 ? rawSizes[rawSizes.length - 1] : null,
        lowestPieceId: ids.reduce((a, b) => (a < b ? a : b)),
        highestPieceId: ids.reduce((a, b) => (a > b ? a : b)),
        createdAt: latestPiece.createdAt,
        lastProvenAt: latestPiece.lastProvenAt,
        totalProofsSubmitted: latestPiece.totalProofsSubmitted,
      });
    }

    // Sort by highest piece ID (most recent first)
    groups.sort((a, b) =>
      b.highestPieceId > a.highestPieceId
        ? 1
        : b.highestPieceId < a.highestPieceId
          ? -1
          : 0,
    );

    const pendingRemovalCount = pieces.filter((p) => p.pendingRemoval).length;

    summaries.push({
      dataSetId,
      providerId: ds.providerId,
      providerName,
      activePieceCount: ds.activePieceCount,
      isLive: ds.isLive,
      groups,
      orphanPieces: orphans,
      pendingRemovalCount,
    });
  }

  // Enrich with subgraph data (timestamps, raw sizes) — started earlier in parallel
  try {
    const subgraphData = await subgraphPromise;

    for (const summary of summaries) {
      const dsRoots = subgraphData.get(summary.dataSetId);
      if (!dsRoots) continue;

      // Build rootId -> root lookup
      const rootMap = new Map(dsRoots.roots.map((r) => [BigInt(r.rootId), r]));

      // Enrich pieces
      const allPieces = [
        ...summary.groups.flatMap((g) => g.pieces),
        ...summary.orphanPieces,
      ];
      for (const piece of allPieces) {
        const root = rootMap.get(piece.pieceId);
        if (root) {
          piece.createdAt = root.createdAt;
          piece.rawSizeBytes = root.rawSize;
          piece.lastProvenAt = root.lastProvenAt || null;
          piece.totalProofsSubmitted = root.totalProofsSubmitted || null;
        }
      }

      // Update group-level fields
      for (const group of summary.groups) {
        const sortedByIdDesc = [...group.pieces].sort((a, b) =>
          b.pieceId > a.pieceId ? 1 : b.pieceId < a.pieceId ? -1 : 0,
        );
        const latestPiece = sortedByIdDesc[0];
        group.createdAt = latestPiece?.createdAt ?? null;
        group.lastProvenAt = latestPiece?.lastProvenAt ?? null;
        group.totalProofsSubmitted = latestPiece?.totalProofsSubmitted ?? null;
        const rawSizes = group.pieces
          .map((p) => p.rawSizeBytes)
          .filter((s): s is number => s !== null);
        group.totalRawSizeBytes = rawSizes.length > 0 ? rawSizes[rawSizes.length - 1] : null;
      }

      // Re-sort groups by createdAt if available, falling back to pieceId
      summary.groups.sort((a, b) => {
        if (a.createdAt !== null && b.createdAt !== null) {
          return b.createdAt - a.createdAt;
        }
        return b.highestPieceId > a.highestPieceId ? 1 : b.highestPieceId < a.highestPieceId ? -1 : 0;
      });
    }
  } catch {
    // Subgraph unavailable — continue without enrichment
  }

  return summaries;
}

/**
 * Remove pieces by CID selection.
 * - removeCids: remove only these specific CIDs
 * - keepCid: keep this CID, remove everything else (default: keep latest)
 * - keepCopies: if false (default), also remove duplicate pieces within kept CIDs
 */
export async function cleanPieces(opts: StorageAuth & {
  mainnet: boolean;
  keepCids?: string[];
  removeCids?: string[];
  dataSetId?: bigint;
  keepCopies?: boolean;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ removed: number; txHashes: string[]; keptCid: string; keptCids: string[]; failed: number; error?: string }> {
  const summaries = await listPieces({
    pinKey: opts.pinKey,
    walletAddress: opts.walletAddress,
    mainnet: opts.mainnet,
  });

  if (summaries.length === 0) {
    throw new Error("No datasets found for this wallet.");
  }

  // Pick the target dataset
  let target: DataSetSummary;
  if (opts.dataSetId !== undefined) {
    const found = summaries.find((s) => s.dataSetId === opts.dataSetId);
    if (!found) throw new Error(`Dataset ${opts.dataSetId} not found.`);
    target = found;
  } else if (summaries.length === 1) {
    target = summaries[0];
  } else {
    throw new Error(
      `Multiple datasets found. Specify one with --dataset-id. IDs: ${summaries.map((s) => String(s.dataSetId)).join(", ")}`,
    );
  }

  if (target.groups.length === 0) {
    throw new Error("No piece groups found in this dataset.");
  }

  // Collect pieces to remove
  const piecesToRemove: PieceInfo[] = [];
  const keptCids: string[] = [];

  if (opts.removeCids && opts.removeCids.length > 0) {
    // Explicit removal: remove only the specified CIDs (normalize for v0/v1 comparison)
    const removeSetV1 = new Set(opts.removeCids.map(toCidV1));
    for (const cid of opts.removeCids) {
      const cidV1 = toCidV1(cid);
      if (!target.groups.find((g) => toCidV1(g.ipfsRootCID) === cidV1)) {
        throw new Error(
          `CID ${cid} not found in dataset ${target.dataSetId}.`,
        );
      }
    }
    for (const group of target.groups) {
      if (removeSetV1.has(toCidV1(group.ipfsRootCID))) {
        piecesToRemove.push(...group.pieces);
      } else {
        keptCids.push(group.ipfsRootCID);
      }
    }
  } else {
    // Keep mode: keep specified CIDs (or latest), remove everything else
    const keepCidsRaw = opts.keepCids && opts.keepCids.length > 0
      ? opts.keepCids
      : [target.groups[0].ipfsRootCID];
    const keepSetV1 = new Set(keepCidsRaw.map(toCidV1));

    for (const cid of keepCidsRaw) {
      const cidV1 = toCidV1(cid);
      if (!target.groups.find((g) => toCidV1(g.ipfsRootCID) === cidV1)) {
        throw new Error(
          `CID ${cid} not found in dataset ${target.dataSetId}.`,
        );
      }
    }

    for (const group of target.groups) {
      if (keepSetV1.has(toCidV1(group.ipfsRootCID))) {
        keptCids.push(group.ipfsRootCID);
      } else {
        piecesToRemove.push(...group.pieces);
      }
    }
    piecesToRemove.push(...target.orphanPieces);

    // Deduplicate within kept CIDs (not for --remove)
    if (!opts.keepCopies) {
      for (const cid of keptCids) {
        const group = target.groups.find((g) => g.ipfsRootCID === cid);
        if (group && group.pieces.length > 1) {
          const sorted = [...group.pieces].sort((a, b) =>
            b.pieceId > a.pieceId ? 1 : b.pieceId < a.pieceId ? -1 : 0,
          );
          piecesToRemove.push(...sorted.slice(1));
        }
      }
    }
  }

  // Filter out pieces already pending removal
  const filteredPieces = piecesToRemove.filter((p) => !p.pendingRemoval);

  if (filteredPieces.length === 0) {
    return { removed: 0, txHashes: [], keptCid: keptCids[0] || "", keptCids, failed: 0 };
  }

  // Create StorageContext for the target dataset to perform deletions
  const synapse = createSynapse(opts, opts.mainnet);
  const warmStorage = new WarmStorageService({ client: synapse.client });

  const ctx = await StorageContext.create({
    synapse,
    warmStorageService: warmStorage,
    dataSetId: target.dataSetId,
    providerId: target.providerId,
  });

  const txHashes: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < filteredPieces.length; i++) {
    const piece = filteredPieces[i];
    opts.onProgress?.(i + 1, filteredPieces.length);
    try {
      const txHash = await ctx.deletePiece({ piece: piece.pieceId });
      txHashes.push(txHash);
    } catch (err: any) {
      errors.push(`piece ${piece.pieceId}: ${err?.message || err}`);
    }
  }

  if (errors.length > 0 && txHashes.length === 0) {
    throw new Error(`Failed to remove pieces: ${errors[0]}`);
  }

  return {
    removed: txHashes.length,
    txHashes,
    keptCid: keptCids[0] || "",
    keptCids,
    failed: errors.length,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}
