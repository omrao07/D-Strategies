# Security Threat Model

This document summarizes the threats, assets, controls, and risks for the system.  
It is the human-readable companion to [`security/threat-model.ts`](./threat-model.ts), which is executable and produces Markdown/JSON reports.

---

## 1. Scope

The threat model covers:

- CLI and background services
- Adapters (quotes, chains)
- Engine (bridge, orchestrator, stream)
- Commodity math (Black76, curves, margin)
- Reports/templates
- Observability (logging, metrics, health)
- Optional HTTP server (`commands/serve`)

---

## 2. Assumptions

- Secrets are injected at runtime (not committed to code).
- System runs on trusted hosts by default.
- Observability endpoints are TLS-protected when remote.

---

## 3. Out of Scope

- Key management service (KMS) implementation
- Multi-tenant identity & user account management
- Ultra-low-latency (HFT-grade) protections

---

## 4. Assets

- **API Keys & Credentials** (Confidentiality)  
- **Strategies/Models/Params** (Confidentiality)  
- **Positions, Risk & Reports** (Confidentiality)  
- **Price/Chain Inputs** (Integrity)  
- **Build Artifacts** (Integrity, supply chain)  
- **Live Streams & Health Endpoints** (Availability)

---

## 5. Threats (STRIDE)

- **Secret Leakage in Logs/Errors** (I)  
  _Secrets printed in logs or errors_  
  → affects API keys  

- **Feed Tampering / Malformed Inputs** (T, I, D)  
  _Corrupted or adversarial inputs alter results or crash processes_  
  → affects inputs, positions  

- **Unauthenticated HTTP Access** (S, E)  
  _Endpoints reachable without auth allow spoofing or privilege escalation_  
  → affects live services, secrets, positions  

- **Resource Exhaustion / DoS** (D)  
  _Large payloads or deep books exhaust CPU/memory_  
  → affects availability  

- **Supply Chain Compromise** (T, E)  
  _Malicious dependency or build process injects code_  
  → affects binaries, models

---

## 6. Controls

- **Log Redaction**  
  Preventive — redact secrets (`*_KEY`, `*_SECRET`, `TOKEN`), limit log size  

- **Input Validation (Invariants)**  
  Preventive — schema checks for ticks/books/curves, reject NaN/crossed books  

- **Auth + Rate Limits**  
  Preventive — bearer tokens, timing-safe compare, IP allowlists, token bucket  

- **Build Integrity**  
  Preventive — pinned toolchains, lockfiles, immutable builds  

- **Observability**  
  Detective — structured NDJSON logs, event stream, minimal health endpoint

---

## 7. Risks (Likelihood × Impact)

| Threat                        | Likelihood | Impact | Controls                           | Residual Level |
|-------------------------------|------------|--------|------------------------------------|----------------|
| Secret leakage in logs        | 2          | 5      | Log redaction                      | Low            |
| Feed tampering / malformed    | 3          | 4      | Input validation                   | Medium         |
| Unauthenticated HTTP access   | 3          | 5      | Auth + rate limits                 | Medium         |
| Resource exhaustion / DoS     | 3          | 4      | Input validation, rate limits, obs | Medium         |
| Supply chain compromise       | 2          | 5      | Build integrity (planned)          | High           |

---

## 8. Recommendations

- Ensure **log redaction** is tested regularly with canary secrets.
- Fuzz test adapters and enforce **input caps** (book depth, chain size).
- Bind `serve` to `127.0.0.1` by default; require token for remote use.
- Add CI supply-chain checks (dependency auditing, reproducible builds).
- Rotate secrets quarterly or after incident.

---

## 9. Verification & Testing

- Unit: invariants, math (determinism, bounds)
- Integration: cash conservation, leverage bounds
- Security tests:  
  - fuzz adapters with random/corrupted inputs  
  - DoS attempts with oversized inputs  
  - CLI arg injection attempts  
- Dependency audits (`npm audit`, lockfile checks)

---

## 10. Review Cadence

- Owner: Security/Platform team
- Reviewed: quarterly or upon material change
- Incident runbooks documented in `security/threat-model.ts`

---

_This markdown file is for quick reading. For live risk scores and structured output, run:_

```bash
ts-node backend/security/threat-model.ts > threat-report.md
