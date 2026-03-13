/**
 * Direct upload to Filecoin Onchain Cloud via synapse-sdk.
 *
 * Replaces the filecoin-pin subprocess approach with native SDK calls.
 * Builds a CAR file from the directory, then streams it to the provider.
 */

import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { StorageManager } from "@filoz/synapse-sdk/storage";
import { WarmStorageService } from "@filoz/synapse-sdk/warm-storage";
import { createCarFromDirectory, cleanupCar } from "./car.js";
import { createSynapse, type StorageAuth } from "./auth.js";
import { success, info, c, gutterTop, gutterBottom, gutterLine, formatSize } from "./ui.js";

export interface UploadConfig {
  directory: string;
  walletAddress?: string;
  pinKey?: string;
  providerId?: number;
  mainnet?: boolean;
  label?: string;
}

export interface UploadResult {
  cid: string;
  directory: string;
}

/**
 * Upload a directory to Filecoin Onchain Cloud.
 *
 * 1. Builds a CAR file from the directory (UnixFS DAG)
 * 2. Streams the CAR to the provider via synapse-sdk
 * 3. Commits the piece on-chain with ipfsRootCID metadata
 */
export async function uploadToFoc(config: UploadConfig): Promise<UploadResult> {
  const auth: StorageAuth = {
    walletAddress: config.walletAddress,
    pinKey: config.pinKey,
  };
  const isMainnet = config.mainnet !== false;

  // 1. Build CAR file
  gutterTop("Building CAR");
  let fileCount = 0;
  const carResult = await createCarFromDirectory(config.directory, (path) => {
    fileCount++;
    if (fileCount % 50 === 0) {
      gutterLine(`${fileCount} files...`);
    }
  });
  const carSize = statSync(carResult.carPath).size;
  gutterLine(`${fileCount} files, CAR ${formatSize(carSize)}`);
  gutterBottom();
  console.log("");
  success(`Root CID: ${c.bold}${carResult.rootCid.toString()}${c.reset}`);

  try {
    // 2. Create Synapse client + StorageManager
    info("Connecting to Filecoin Onchain Cloud...");
    const synapse = createSynapse(auth, isMainnet);
    const warmStorage = new WarmStorageService({ client: synapse.client });
    const manager = new StorageManager({ synapse, warmStorageService: warmStorage, withCDN: false, source: "filecoin-nova" });

    // 3. Stream CAR to provider
    const rootCidStr = carResult.rootCid.toString();
    const pieceMetadata: Record<string, string> = {
      ipfsRootCID: rootCidStr,
      withIPFSIndexing: "",  // Tells provider to advertise to IPNI for gateway retrieval
    };
    if (config.label) {
      pieceMetadata.label = config.label;
    }

    const copyCount = 2;
    gutterTop("Uploading to providers");
    gutterLine(`CAR size: ${formatSize(carSize)}, ${copyCount} copies`);

    // Stream the CAR file — bypasses the 200 MiB Uint8Array size check
    // in StorageContext, routing through uploadPieceStreaming (1 GiB limit)
    const carStream = Readable.toWeb(
      createReadStream(carResult.carPath),
    ) as ReadableStream<Uint8Array>;

    const uploadOptions: Record<string, any> = {
      pieceMetadata,
      metadata: { withIPFSIndexing: "" },  // Dataset-level: enables IPNI advertisement for gateway retrieval
      count: copyCount,
      callbacks: {
        onProviderSelected: (provider: any) => {
          gutterLine(`Provider: ${provider.id}${provider.pdp?.serviceURL ? ` (${new URL(provider.pdp.serviceURL).hostname})` : ""}`);
        },
        onDataSetResolved: (info: any) => {
          gutterLine(`Dataset: ${info.dataSetId}${info.isNew ? " (new)" : ""}`);
        },
        onProgress: (() => {
          let lastReportedPct = -1;
          return (bytesUploaded: number) => {
            const pct = Math.min(100, Math.round((bytesUploaded / carSize) * 100));
            if (process.stderr.isTTY) {
              const barW = 20;
              const filled = Math.round((pct / 100) * barW);
              const bar = "\u2588".repeat(filled) + "\u2591".repeat(barW - filled);
              process.stderr.write(`\r  ${c.dim}\u2503${c.reset}  ${bar} ${pct}% (${formatSize(bytesUploaded)} / ${formatSize(carSize)})`);
            } else {
              // Non-TTY: emit line-based progress at 10% intervals for piped consumers (focify-me, CI)
              const milestone = Math.floor(pct / 10) * 10;
              if (milestone > lastReportedPct) {
                lastReportedPct = milestone;
                gutterLine(`Uploading: ${pct}% (${formatSize(bytesUploaded)} / ${formatSize(carSize)})`);
              }
            }
          };
        })(),
        onStored: () => {
          if (process.stderr.isTTY) {
            process.stderr.write("\r" + " ".repeat(80) + "\r");
          }
          gutterLine("Upload complete, committing on-chain...");
        },
        onPiecesAdded: (txHash: string) => {
          gutterLine(`Transaction sent: ${txHash.slice(0, 14)}...`);
          gutterLine("Waiting for confirmation...");
        },
        onPiecesConfirmed: () => {
          gutterLine("Confirmed on-chain");
        },
      },
    };
    // When providerId is specified with count > 1, the SDK requires providerIds.length === count.
    // So we create contexts in two calls: one explicit + the rest auto-selected.
    if (config.providerId !== undefined && copyCount > 1) {
      const id = BigInt(config.providerId);
      const contextOpts = { metadata: uploadOptions.metadata, callbacks: uploadOptions.callbacks };
      const [explicit] = await manager.createContexts({ ...contextOpts, providerIds: [id], count: 1 });
      const auto = await manager.createContexts({ ...contextOpts, count: copyCount - 1, excludeProviderIds: [id] });
      uploadOptions.contexts = [explicit, ...auto];
    } else if (config.providerId !== undefined) {
      uploadOptions.providerIds = [BigInt(config.providerId)];
    }

    const result = await manager.upload(carStream as any, uploadOptions);
    gutterLine(`Piece CID: ${result.pieceCid}`);
    for (const copy of result.copies) {
      gutterLine(`Copy: provider ${copy.providerId}, piece ${copy.pieceId}`);
    }
    if (result.failures.length > 0) {
      for (const f of result.failures) {
        gutterLine(`Failed: provider ${f.providerId} (${f.error})`);
      }
    }
    gutterBottom();
    console.log("");
    success(`Deployed: ${c.bold}${rootCidStr}${c.reset}`);

    return { cid: rootCidStr, directory: config.directory };
  } finally {
    await cleanupCar(carResult.carPath).catch(() => {});
  }
}
