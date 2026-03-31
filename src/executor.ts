import { execFile } from "node:child_process";

export interface ExecOptions {
  args: string[];
  cwd?: string;
  stdin?: string;
  timeout_ms?: number;
  extraEnv?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  errorCode?: string; // 'ENOENT', 'ETIMEDOUT', etc.
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1_000_000;

export function execCommand(
  binary: string,
  options: ExecOptions,
): Promise<ExecResult> {
  const { args, cwd, stdin, timeout_ms, extraEnv } = options;

  return new Promise((resolve) => {
    const child = execFile(
      binary,
      args,
      {
        cwd: cwd || process.cwd(),
        timeout: timeout_ms ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        // Do NOT spread process.env into an explicit env object.
        // Bun compiled binaries may have an incomplete process.env proxy,
        // causing child processes to lose environment variables that git
        // needs for SSH signing. Omitting env lets the child inherit the
        // full C-level environ directly.
        ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
      },
      (error, stdout, stderr) => {
        let exitCode = 0;
        let errorCode: string | undefined;

        if (error && "code" in error && typeof error.code === "string") {
          errorCode = error.code;
          exitCode = 1;
        } else if (
          error &&
          "code" in error &&
          typeof error.code === "number"
        ) {
          exitCode = error.code;
        } else if (error) {
          exitCode = 1;
        }

        resolve({
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          exitCode,
          errorCode,
        });
      },
    );

    if (stdin && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}
