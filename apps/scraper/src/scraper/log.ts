// Timestamped console logging and error formatting.

export function formatErrorWithCause(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = "cause" in error ? (error as Error & { cause?: unknown; }).cause : undefined;
  if (!cause) {
    return error.message;
  }

  if (cause instanceof Error) {
    return `${error.message}; cause=${cause.name}: ${cause.message}`;
  }

  if (typeof cause === "object") {
    try {
      return `${error.message}; cause=${JSON.stringify(cause)}`;
    } catch {
      return `${error.message}; cause=[object]`;
    }
  }

  return `${error.message}; cause=${String(cause)}`;
}

export function logInfo(message: string): void {
  console.log(formatLogMessage("info", message));
}

export function logWarn(message: string): void {
  console.warn(formatLogMessage("warn", message));
}

export function logError(message: string): void {
  console.error(formatLogMessage("error", message));
}

export function formatLogMessage(level: "error" | "info" | "warn", message: string): string {
  return `[${new Date().toISOString()}] [${level}] ${message}`;
}
