const MAX_OUTPUT_LENGTH = 1_048_576; // 1 MB

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function check(ok: boolean): string {
  return ok ? "\u2713" : "\u2717";
}

export function textResult(text: string, isError?: boolean) {
  const sanitized = stripAnsi(text);
  const truncated = sanitized.length > MAX_OUTPUT_LENGTH
    ? sanitized.slice(0, MAX_OUTPUT_LENGTH) + "\n... (output truncated)"
    : sanitized;
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text: truncated }],
  };
}
