import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { statSync } from "node:fs";

const execFileAsync = promisify(execFile);

const ARCHIVE_EXTENSIONS = [".zip", ".tar.gz", ".tgz", ".tar"];

/**
 * Check if a path points to a supported archive file.
 */
export function isArchive(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
  } catch {
    return false;
  }
  const lower = path.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Get the archive type from a file path.
 */
function archiveType(path: string): "zip" | "tar.gz" | "tar" {
  const lower = path.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".tar")) return "tar";
  throw new Error(`Unsupported archive format: ${extname(path)}`);
}

/**
 * Extract an archive to a temporary directory.
 * Returns the path to the extracted directory.
 * Caller is responsible for cleanup via cleanupExtracted().
 */
export async function extractArchive(archivePath: string): Promise<string> {
  const tmpDir = await mkdtemp(join(tmpdir(), "nova-"));
  const type = archiveType(archivePath);

  try {
    switch (type) {
      case "zip":
        await execFileAsync("unzip", ["-q", archivePath, "-d", tmpDir]);
        break;
      case "tar.gz":
        await execFileAsync("tar", ["-xzf", archivePath, "-C", tmpDir]);
        break;
      case "tar":
        await execFileAsync("tar", ["-xf", archivePath, "-C", tmpDir]);
        break;
    }
  } catch (err: any) {
    // Clean up on extraction failure
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `Failed to extract archive: ${archivePath}\n\n` +
        `  ${err.stderr?.trim() || err.message || "Unknown error"}\n` +
        `  Make sure the file is a valid ${type} archive.`
    );
  }

  return tmpDir;
}

/**
 * Clean up an extracted temp directory.
 */
export async function cleanupExtracted(tmpDir: string): Promise<void> {
  await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
}
