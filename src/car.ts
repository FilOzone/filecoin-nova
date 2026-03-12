/**
 * CAR file builder for directories.
 *
 * Converts a filesystem directory into a UnixFS DAG stored in a CAR file.
 * Used by upload.ts to prepare content for Filecoin Onchain Cloud.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { globSource, unixfs } from "@helia/unixfs";
import { CarWriter } from "@ipld/car";
import { BaseBlockstore } from "blockstore-core";
import { CID } from "multiformats/cid";

// Placeholder CID for the CAR header (replaced with actual root after DAG is built)
const PLACEHOLDER_CID = CID.parse(
  "bafyaaiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);

/**
 * A blockstore that writes blocks to a CAR file on disk
 * while keeping them in memory for read-back during DAG construction.
 */
class CARBlockstore extends BaseBlockstore {
  private blocks = new Map<string, Uint8Array>();
  private writer: Awaited<ReturnType<typeof CarWriter.create>>["writer"] | null =
    null;
  private pipelinePromise: Promise<void> | null = null;

  async initialize(outputPath: string): Promise<void> {
    const { writer, out } = CarWriter.create([PLACEHOLDER_CID]);
    this.writer = writer;

    const writeStream = createWriteStream(outputPath);
    const readable = Readable.from(out);
    this.pipelinePromise = pipeline(readable, writeStream);

    // Wait for the CAR header to be flushed
    await (this.writer as any)._mutex;
  }

  async put(key: CID, val: Uint8Array): Promise<CID> {
    const keyStr = key.toString();
    if (!this.blocks.has(keyStr)) {
      this.blocks.set(keyStr, val);
      await this.writer!.put({ cid: key, bytes: val });
      await (this.writer as any)._mutex;
    }
    return key;
  }

  async *get(key: CID): AsyncGenerator<Uint8Array> {
    const val = this.blocks.get(key.toString());
    if (!val) throw new Error(`Block not found: ${key}`);
    yield val;
  }

  async has(key: CID): Promise<boolean> {
    return this.blocks.has(key.toString());
  }

  async finalize(): Promise<void> {
    await this.writer?.close();
    this.writer = null;

    if (this.pipelinePromise) {
      try {
        await this.pipelinePromise;
      } catch (err: any) {
        if (err.code !== "ERR_STREAM_PREMATURE_CLOSE") throw err;
      }
    }

    // Release block memory
    this.blocks.clear();
  }
}

export interface CarResult {
  carPath: string;
  rootCid: CID;
}

/**
 * Create a CAR file from a directory.
 * Returns the path to the temporary CAR file and the IPFS root CID.
 */
export async function createCarFromDirectory(
  dirPath: string,
  onFile?: (path: string) => void,
): Promise<CarResult> {
  const carPath = join(
    tmpdir(),
    `nova-${Date.now()}-${randomBytes(4).toString("hex")}.car`,
  );

  const blockstore = new CARBlockstore();
  await blockstore.initialize(carPath);

  const fs = unixfs({ blockstore });

  const absolutePath = resolve(dirPath);
  const parentDir = dirname(absolutePath);
  const dirName = basename(absolutePath);
  const pattern = `${dirName}/**/*`;

  // Wrap source to report progress
  async function* tracked(source: AsyncIterable<any>) {
    for await (const entry of source) {
      onFile?.(entry.path);
      yield entry;
    }
  }

  const entries = [];
  for await (const entry of fs.addAll(
    tracked(globSource(parentDir, pattern, { hidden: true })),
  )) {
    entries.push(entry);
  }

  // Last entry from addAll is the root directory
  const rootCid = entries[entries.length - 1]?.cid;
  if (!rootCid) {
    await blockstore.finalize();
    await cleanupCar(carPath);
    throw new Error(`Directory is empty: ${dirPath}`);
  }

  await blockstore.finalize();

  // Replace placeholder root CID in the CAR header with the actual root
  const fd = await open(carPath, "r+");
  try {
    await CarWriter.updateRootsInFile(fd, [rootCid]);
  } finally {
    await fd.close();
  }

  return { carPath, rootCid };
}

/**
 * Clean up a temporary CAR file.
 */
export async function cleanupCar(carPath: string): Promise<void> {
  try {
    await unlink(carPath);
  } catch {
    // Best-effort cleanup
  }
}
