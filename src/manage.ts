import { Synapse, mainnet, calibration } from "@filoz/synapse-sdk";
import { WarmStorageService } from "@filoz/synapse-sdk/warm-storage";
import { StorageContext } from "@filoz/synapse-sdk/storage";
import { getSizeFromPieceCID } from "@filoz/synapse-core/piece";
import { privateKeyToAccount } from "viem/accounts";
import { http } from "viem";
import type { Hex } from "viem";


export interface PieceInfo {
  pieceId: bigint;
  pieceCid: string;
  sizeBytes: number;
  ipfsRootCID: string | null;
  pendingRemoval: boolean;
}

export interface CIDGroup {
  ipfsRootCID: string;
  pieces: PieceInfo[];
  totalPieces: number;
  totalSizeBytes: number;
  lowestPieceId: bigint;
  highestPieceId: bigint;
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

function ensureHexKey(key: string): Hex {
  return key.startsWith("0x") ? (key as Hex) : (`0x${key}` as Hex);
}

function createSynapse(pinKey: string, isMainnet: boolean) {
  const chain = isMainnet ? mainnet : calibration;
  const account = privateKeyToAccount(ensureHexKey(pinKey));
  return Synapse.create({ account, chain, transport: http() });
}

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
export async function listPieces(opts: {
  pinKey: string;
  mainnet: boolean;
}): Promise<DataSetSummary[]> {
  const synapse = createSynapse(opts.pinKey, opts.mainnet);
  const warmStorage = new WarmStorageService({ client: synapse.client });
  const address = privateKeyToAccount(ensureHexKey(opts.pinKey)).address;

  const datasets = await warmStorage.getClientDataSetsWithDetails({
    address,
  });
  if (datasets.length === 0) return [];

  const summaries: DataSetSummary[] = [];

  for (const ds of datasets) {
    if (!ds.isLive) continue;

    const dataSetId = ds.dataSetId;

    // Fetch provider name
    let providerName = `provider ${ds.providerId}`;
    try {
      const providerInfo = await synapse.getProviderInfo(ds.providerId);
      providerName = providerInfo.name || providerName;
    } catch {
      // Fall back to generic name
    }

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

      for await (const piece of ctx.getPieces()) {
        let ipfsRootCID: string | null = null;
        try {
          ipfsRootCID = await warmStorage.getPieceMetadataByKey({
            dataSetId,
            pieceId: piece.pieceId,
            key: "ipfsRootCID",
          });
        } catch {
          // Metadata may not exist
        }
        const cidStr = String(piece.pieceCid);
        pieces.push({
          pieceId: piece.pieceId,
          pieceCid: cidStr,
          sizeBytes: pieceSizeBytes(cidStr),
          ipfsRootCID,
          pendingRemoval: scheduledSet.has(piece.pieceId),
        });
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
          pieces.push({
            pieceId: BigInt(i),
            pieceCid: "",
            sizeBytes: 0,
            ipfsRootCID: (meta as Record<string, string>).ipfsRootCID || null,
            pendingRemoval: scheduledSet.has(BigInt(i)),
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
      groups.push({
        ipfsRootCID: cid,
        pieces: gPieces,
        totalPieces: gPieces.length,
        totalSizeBytes: gPieces.reduce((sum, p) => sum + p.sizeBytes, 0),
        lowestPieceId: ids.reduce((a, b) => (a < b ? a : b)),
        highestPieceId: ids.reduce((a, b) => (a > b ? a : b)),
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

  return summaries;
}

/**
 * Remove pieces by CID selection.
 * - removeCids: remove only these specific CIDs
 * - keepCid: keep this CID, remove everything else (default: keep latest)
 * - keepCopies: if false (default), also remove duplicate pieces within kept CIDs
 */
export async function cleanPieces(opts: {
  pinKey: string;
  mainnet: boolean;
  keepCids?: string[];
  removeCids?: string[];
  dataSetId?: bigint;
  keepCopies?: boolean;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ removed: number; txHashes: string[]; keptCid: string; keptCids: string[]; failed: number; error?: string }> {
  const summaries = await listPieces({
    pinKey: opts.pinKey,
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
    // Explicit removal: remove only the specified CIDs
    const removeSet = new Set(opts.removeCids);
    for (const cid of removeSet) {
      if (!target.groups.find((g) => g.ipfsRootCID === cid)) {
        throw new Error(
          `CID ${cid} not found in dataset ${target.dataSetId}.`,
        );
      }
    }
    for (const group of target.groups) {
      if (removeSet.has(group.ipfsRootCID)) {
        piecesToRemove.push(...group.pieces);
      } else {
        keptCids.push(group.ipfsRootCID);
      }
    }
  } else {
    // Keep mode: keep specified CIDs (or latest), remove everything else
    const keepSet = opts.keepCids && opts.keepCids.length > 0
      ? new Set(opts.keepCids)
      : new Set([target.groups[0].ipfsRootCID]);

    for (const cid of keepSet) {
      if (!target.groups.find((g) => g.ipfsRootCID === cid)) {
        throw new Error(
          `CID ${cid} not found in dataset ${target.dataSetId}.`,
        );
      }
    }

    for (const group of target.groups) {
      if (keepSet.has(group.ipfsRootCID)) {
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
  const synapse = createSynapse(opts.pinKey, opts.mainnet);
  const warmStorage = new WarmStorageService({ client: synapse.client });

  const ctx = await StorageContext.create({
    synapse,
    warmStorageService: warmStorage,
    dataSetId: target.dataSetId,
    providerId: target.providerId,
  });

  const txHashes: string[] = [];
  let lastError: Error | null = null;
  for (let i = 0; i < filteredPieces.length; i++) {
    const piece = filteredPieces[i];
    opts.onProgress?.(i + 1, filteredPieces.length);
    try {
      const txHash = await ctx.deletePiece({ piece: piece.pieceId });
      txHashes.push(txHash);
    } catch (err: any) {
      lastError = err;
      break;
    }
  }

  const result = {
    removed: txHashes.length,
    txHashes,
    keptCid: keptCids[0] || "",
    keptCids,
    failed: filteredPieces.length - txHashes.length,
    error: lastError?.message,
  };

  if (lastError && txHashes.length === 0) {
    throw new Error(`Failed to remove pieces: ${lastError.message}`);
  }

  return result;
}
