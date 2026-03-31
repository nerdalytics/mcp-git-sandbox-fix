export function check(ok: boolean): string {
  return ok ? "\u2713" : "\u2717";
}

export function textResult(text: string, isError?: boolean) {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text" as const, text }],
  };
}
