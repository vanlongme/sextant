import { invoke } from "@tauri-apps/api/core";
import type { ErrorCode } from "./generated/ErrorCode";

export class IpcFailure extends Error {
  code: ErrorCode;
  details?: string;

  constructor(code: ErrorCode, message: string, details?: string) {
    super(message);
    this.name = "IpcFailure";
    this.code = code;
    this.details = details;
  }
}

function isIpcError(
  value: unknown,
): value is { code: ErrorCode; message: string; details?: string | null } {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    "message" in value
  );
}

function toFailure(error: unknown): IpcFailure {
  if (isIpcError(error)) {
    return new IpcFailure(
      error.code,
      error.message,
      error.details ?? undefined,
    );
  }
  return new IpcFailure(
    "Internal",
    error instanceof Error ? error.message : String(error),
  );
}

/** Calls a backend command. Every rejection is an `IpcFailure`. */
export async function call<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (error) {
    throw toFailure(error);
  }
}

export function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
