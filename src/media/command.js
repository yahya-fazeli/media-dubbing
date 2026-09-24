import { spawn } from 'node:child_process';
import { MediaError, TimeoutError, ErrorCode } from '../core/errors.js';
import { isCancellation } from '../core/cancellation.js';

/**
 * Runs an external media tool with a hard timeout, output caps, and full
 * cancellation support. Arguments are always passed as an array so no shell is
 * involved and user-supplied paths can never be interpreted as commands.
 */

const DEFAULT_MAX_OUTPUT_CHARS = 64 * 1024;

export async function runCommand(command, args, options = {}) {
  const {
    timeoutMs = 10 * 60 * 1000,
    signal,
    maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
    cwd,
    env,
    toolName = command,
    allowMissing = false,
  } = options;

  if (signal?.aborted) {
    throw new MediaError('Command aborted before start', {
      code: ErrorCode.CANCELLED,
      retryable: false,
      recoveryScope: 'job',
    });
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      if (err.code === 'ENOENT' && allowMissing) {
        resolve({ missing: true, code: 127, stdout: '', stderr: '', durationMs: 0 });
        return;
      }
      reject(missingToolError(err, toolName));
      return;
    }

    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const cleanup = () => {
      offAbort();
      clearTimeout(timer);
    };

    const onAbort = () => {
      if (settled) return;
      killTree(child, 'SIGKILL');
    };
    const offAbort = signal
      ? (() => {
          signal.addEventListener('abort', onAbort, { once: true });
          return () => signal.removeEventListener('abort', onAbort);
        })()
      : () => {};

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < maxOutputChars) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < maxOutputChars) stderr += chunk.toString();
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err.code === 'ENOENT' && allowMissing) {
        resolve({ missing: true, code: 127, stdout: '', stderr: '', durationMs: 0 });
        return;
      }
      reject(missingToolError(err, toolName));
    });

    child.on('close', (code, signalName) => {
      if (settled) return;
      settled = true;
      cleanup();
      const durationMs = Date.now() - start;

      if (timedOut) {
        reject(new TimeoutError(`${toolName} exceeded its ${Math.round(timeoutMs / 1000)}s time limit`, {
          stage: options.stage ?? null,
          segmentId: options.segmentId ?? null,
          details: { tool: toolName, stderr: stderr.slice(0, 2000) },
          recommendedAction: 'Retry the stage or raise DUB_MEDIA_TIMEOUT_MS for very long media.',
        }));
        return;
      }

      if (signal?.aborted) {
        reject(new MediaError(`${toolName} cancelled`, {
          code: ErrorCode.CANCELLED,
          retryable: false,
          recoveryScope: 'job',
        }));
        return;
      }

      if (code !== 0) {
        reject(new MediaError(`${toolName} failed with exit code ${code}`, {
          stage: options.stage ?? null,
          segmentId: options.segmentId ?? null,
          details: { tool: toolName, exitCode: code, signal: signalName, stderr: stderr.slice(0, 2000) },
          recommendedAction: 'Inspect the tool output; the source media or arguments may be invalid.',
        }));
        return;
      }

      resolve({ code, stdout, stderr, durationMs });
    });
  });
}

function missingToolError(err, toolName) {
  if (err?.code === 'ENOENT') {
    return new MediaError(`Required media tool "${toolName}" is not installed`, {
      code: ErrorCode.MEDIA_TOOL_MISSING,
      retryable: false,
      details: { tool: toolName },
      recommendedAction: 'Install the tool or switch DUB_MEDIA_ENGINE to "mock".',
    });
  }
  return new MediaError(`Failed to start ${toolName}: ${err?.message ?? err}`, { cause: err });
}

/**
 * Kills the process group so ffmpeg's child threads do not outlive a cancel or
 * timeout. Falls back to a direct kill when the group is unavailable.
 */
function killTree(child, signalName) {
  try {
    if (child.pid && process.platform !== 'win32') {
      process.kill(-child.pid, signalName);
    }
  } catch {
    // Group kill can fail if the process already exited or lacks a group.
  }
  try {
    child.kill(signalName);
  } catch {
    // Already dead.
  }
}

/** Checks whether a binary exists and is runnable. */
export async function probeTool(command, args = ['-version']) {
  try {
    const result = await runCommand(command, args, {
      timeoutMs: 10_000,
      allowMissing: true,
      toolName: command,
    });
    return { available: !result.missing, version: firstLine(result.stdout || result.stderr) };
  } catch {
    return { available: false, version: null };
  }
}

function firstLine(text) {
  return String(text ?? '').split('\n')[0]?.trim() ?? null;
}

export { isCancellation };
