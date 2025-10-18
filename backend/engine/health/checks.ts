// health/checks.ts

type HealthStatus = {
  status: "ok" | "degraded" | "down"
  timestamp: string
  details?: Record<string, any>
}

function systemCheck(): HealthStatus {
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
  }
}

function dependencyCheck(name: string, isAvailable: boolean): HealthStatus {
  return {
    status: isAvailable ? "ok" : "down",
    timestamp: new Date().toISOString(),
    details: { dependency: name },
  }
}

function compositeCheck(results: HealthStatus[]): HealthStatus {
  const hasDown = results.some(r => r.status === "down")
  const hasDegraded = results.some(r => r.status === "degraded")

  let status: "ok" | "degraded" | "down" = "ok"
  if (hasDown) status = "down"
  else if (hasDegraded) status = "degraded"

  return {
    status,
    timestamp: new Date().toISOString(),
    details: { checks: results },
  }
}

export { systemCheck, dependencyCheck, compositeCheck, HealthStatus }
