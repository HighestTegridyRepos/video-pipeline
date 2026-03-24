export type LogLevel = "info" | "warn" | "error"

export function log(level: LogLevel, route: string, message: string, meta?: Record<string, unknown>) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    route,
    message,
    ...(meta ? { meta } : {}),
  }
  if (level === "error") console.error(JSON.stringify(entry))
  else if (level === "warn") console.warn(JSON.stringify(entry))
  else console.log(JSON.stringify(entry))
}

export function logInfo(route: string, message: string, meta?: Record<string, unknown>) {
  log("info", route, message, meta)
}

export function logWarn(route: string, message: string, meta?: Record<string, unknown>) {
  log("warn", route, message, meta)
}

export function logError(route: string, message: string, meta?: Record<string, unknown>) {
  log("error", route, message, meta)
}
