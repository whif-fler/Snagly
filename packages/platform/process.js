'use strict';

const { spawn } = require('child_process');

const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        shell: false
      });
    } catch {}
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
  const hardTimer = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  }, 3000);
  hardTimer.unref?.();
}

class ProcessError extends Error {
  constructor(
    message,
    { code = 'EPROCESS', stdout = '', stderr = '', timedOut = false, aborted = false } = {}
  ) {
    super(message);
    this.name = 'ProcessError';
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.timedOut = timedOut;
    this.aborted = aborted;
  }
}

/**
 * Shell-free subprocess runner with bounded output, timeout and tree kill.
 * Every argument is passed as an array element, so media titles can never be
 * interpolated into a command line.
 */
function runProcess(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    signal,
    timeoutMs = 0,
    maxOutputBytes = DEFAULT_MAX_OUTPUT,
    onStdout,
    onStderr,
    input
  } = options;

  if (!command) return Promise.reject(new ProcessError('Executable not found', { code: 'ENOENT' }));
  if (signal?.aborted)
    return Promise.reject(new ProcessError('Cancelled', { code: 'ABORT_ERR', aborted: true }));

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let oversized = false;
    let timedOut = false;
    let settled = false;
    let timer = null;
    let killReason = '';

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(result);
    };

    const stop = (reason) => {
      if (killReason) return;
      killReason = reason;
      killTree(child);
    };

    const onAbort = () => stop('aborted');
    signal?.addEventListener?.('abort', onAbort, { once: true });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        stop('timeout');
      }, timeoutMs);
      timer.unref?.();
    }

    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (stdout.length + text.length > maxOutputBytes) {
        oversized = true;
        stop('oversized');
        return;
      }
      stdout += text;
      onStdout?.(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (stderr.length + text.length <= maxOutputBytes) stderr += text;
      onStderr?.(text);
    });

    child.on('error', (err) => {
      finish(new ProcessError(err.message, { code: err.code || 'EPROCESS', stdout, stderr }));
    });

    child.on('close', (code) => {
      if (killReason === 'aborted') {
        return finish(new ProcessError('Cancelled', { code: 'ABORT_ERR', stdout, stderr, aborted: true }));
      }
      if (timedOut) {
        return finish(
          new ProcessError('Process timed out', { code: 'ETIMEDOUT', stdout, stderr, timedOut: true })
        );
      }
      if (oversized) {
        return finish(
          new ProcessError('Process output exceeded the limit', { code: 'EOUTPUT', stdout, stderr })
        );
      }
      if (code !== 0) {
        return finish(
          new ProcessError(
            (stderr.trim().split('\n').pop() || `Process exited with code ${code}`).slice(0, 500),
            { code: 'EEXIT', stdout, stderr }
          )
        );
      }
      finish(null, { code: code ?? 0, stdout, stderr });
    });
  });
}

module.exports = { runProcess, killTree, ProcessError };
