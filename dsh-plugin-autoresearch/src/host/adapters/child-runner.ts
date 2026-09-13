/**
 * Detached timed command execution (port of pi-autoresearch run_experiment's
 * spawn core): `bash -c` in the workdir, detached process group, rolling tail
 * buffer (2× the display budget) with newline/UTF-8 boundary trimming, full
 * output spill to a temp file once past the threshold, timeout via process-tree
 * kill, and abort-signal support.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import type { WriteStream } from "node:fs";
import type { CommandRunner, RunCommandOptions, TimedRunResult } from "../app/ports";
import { truncateTail } from "./truncate";




function killTree(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have already exited.
    }
  }
}

/** Lazy temp file allocator — one path per run. */
export function createTempFileAllocator(prefix: string): () => string {
  let p: string | undefined;
  return () => {
    if (!p) {
      const id = randomBytes(8).toString("hex");
      p = path.join(tmpdir(), `${prefix}-${id}.log`);
    }
    return p;
  };
}

export function runCommand(options: RunCommandOptions): Promise<TimedRunResult> {
  const { workDir, command, timeoutMs, signal, onUpdate } = options;
  const maxChunksBytes = options.maxBytes * 2;
  const getTempFile = createTempFileAllocator("dsh-experiment");

  const t0 = Date.now();
  return new Promise<TimedRunResult>((resolve, reject) => {
    let processTimedOut = false;
    let signalAborted = false;

    let child;
    try {
      child = spawn("bash", ["-c", command], {
        cwd: workDir,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(err);
      return;
    }

    const chunks: Buffer[] = [];
    let chunksBytes = 0;
    let chunksGeneration = 0;
    let cachedGeneration = -1;
    let cachedText = "";

    let tempFilePath: string | undefined;
    let tempFileStream: WriteStream | undefined;
    let totalBytes = 0;

    const getBufferText = (): string => {
      if (cachedGeneration === chunksGeneration) return cachedText;
      cachedText = Buffer.concat(chunks).toString("utf-8");
      cachedGeneration = chunksGeneration;
      return cachedText;
    };

    const timerInterval = setInterval(() => {
      if (!onUpdate) return;
      onUpdate({
        elapsedMs: Date.now() - t0,
        tail: truncateTail(getBufferText(), { maxLines: options.maxLines, maxBytes: options.maxBytes }),
        fullOutputPath: tempFilePath,
      });
    }, 1000);

    const handleData = (data: Buffer): void => {
      totalBytes += data.length;

      if (totalBytes > options.maxBytes && tempFilePath === undefined) {
        tempFilePath = getTempFile();
        tempFileStream = createWriteStream(tempFilePath);
        for (const chunk of chunks) tempFileStream.write(chunk);
      }
      tempFileStream?.write(data);

      chunks.push(data);
      chunksBytes += data.length;
      while (chunksBytes > maxChunksBytes && chunks.length > 1) {
        const removed = chunks.shift()!;
        chunksBytes -= removed.length;
      }
      if (chunks.length > 0 && chunksBytes > maxChunksBytes) {
        const buf = chunks[0];
        const nlIdx = buf.indexOf(0x0a);
        if (nlIdx !== -1 && nlIdx < buf.length - 1) {
          chunks[0] = buf.subarray(nlIdx + 1);
          chunksBytes -= nlIdx + 1;
        }
      }
      chunksGeneration++;
    };

    child.stdout?.on("data", handleData);
    child.stderr?.on("data", handleData);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        processTimedOut = true;
        if (child.pid) killTree(child.pid);
      }, timeoutMs);
    }

    const onAbort = (): void => {
      signalAborted = true;
      if (child.pid) killTree(child.pid);
      else child.kill();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      clearInterval(timerInterval);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      tempFileStream?.end();
      reject(err);
    });

    child.on("close", (code) => {
      clearInterval(timerInterval);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      tempFileStream?.end();

      const fullBuffer = Buffer.concat(chunks);
      resolve({
        exitCode: code,
        killed: processTimedOut || signalAborted,
        aborted: signalAborted && !processTimedOut,
        output: fullBuffer.toString("utf-8"),
        tempFilePath,
        actualTotalBytes: totalBytes,
        durationSeconds: (Date.now() - t0) / 1000,
      });
    });
  });
}

/** Node child_process implementation of the CommandRunner port. */
export const childRunner: CommandRunner = { run: runCommand };