# Compliance Guidelines

This document describes how the project aligns with common security & compliance frameworks (SOC 2, ISO 27001, NIST CSF).  
It is not a certification but a **control mapping** to guide audits and internal reviews.

---

## 1. Scope

- Core system (engine, orchestrator, adapters, portfolio core)
- Data ingestion (feeds, quotes, chains)
- Secrets handling
- Observability (logging, metrics, health)
- CLI + optional HTTP server
- Reports (HTML, Markdown, CSV)
- Development & CI/CD pipeline

---

## 2. Compliance Objectives

We aim to provide **reasonable assurance** in line with:

- **SOC 2**: Security, Availability, Confidentiality
- **ISO/IEC 27001**: Information Security Management System (ISMS)
- **NIST Cybersecurity Framework (CSF)**: Identify, Protect, Detect, Respond, Recover
- **OWASP ASVS**: Secure coding standards
- **GDPR/Privacy**: (if user data is processed — minimal expected here)

---

## 3. Control Mapping

| Domain         | Control                            | Current Status | Notes |
|----------------|------------------------------------|----------------|-------|
| Access Control | Role-based access (`security/rbac.ts`) | ✅ Implemented | Roles: admin, analyst, viewer |
| Secrets Mgmt   | Secrets never in code, `.env` ignored, rotation | ✅ Implemented | See `security/secrets.md` |
| Logging        | Redaction of sensitive keys        | ✅ Implemented | `security/redact.ts` |
| Availability   | Watchdog, retries, rate limiting   | ✅ Implemented | `sched/watchdog.ts` |
| Integrity      | Input validation (`engine/invariants.ts`) | ✅ Implemented | Rejects NaN/crossed books |
| Supply Chain   | Lockfiles, audits, reproducible builds | ⚠️ In Progress | CI attestation not complete |
| Privacy        | No PII stored by default           | ✅ Implemented | Logs/report contain no personal data |
| Incident Resp. | Threat model & runbook             | ✅ Implemented | `security/threat-model.ts` |

---

## 4. Key Practices

### Identity & Access

- RBAC enforced at command level.
- Least privilege: viewer cannot run models.

### Secrets

- Secrets loaded from env/secret manager.
- Redaction enforced at log sink.
- Rotation procedure documented.

### Change Management

- All commits go through PR review.
- CI runs integration tests (cash conservation, leverage bounds).
- Security scans included in pipeline.

### Logging & Monitoring

- NDJSON structured logs.
- Ring-buffered event streams.
- Health endpoint exposes minimal info only.

### Availability

- Retry + backoff in schedulers.
- Watchdog monitors background tasks.
- DoS protection via rate limiting & payload caps.

### Supply Chain

- npm lockfiles committed.
- Manual dependency review.
- Plan: integrate dependency signing/attestation.

---

## 5. Audit Readiness Checklist

- [ ] Access logs retained 30 days.
- [ ] Secrets rotated quarterly.
- [ ] Vulnerability scans run monthly.
- [ ] Incident runbooks reviewed quarterly.
- [ ] Threat model updated after major changes.
- [ ] CI/CD enforces dependency lockfiles.
- [ ] RBAC policy reviewed annually.

---

## 6. Incident Response Alignment

- **Identify**: monitoring & observability.
- **Protect**: RBAC, redaction, invariants.
- **Detect**: log anomaly detection, watchdog alerts.
- **Respond**: rotate secrets, block offending IPs, patch modules.
- **Recover**: redeploy clean builds, verify checksums.

---

## 7. Certifications (Future Targets)

- **SOC 2 Type I**: target 2026.
- **ISO 27001**: align policies, gap analysis pending.
- **GDPR**: verify data flows if end-user data introduced.

---

## 8. References

- [SOC 2 Trust Services Criteria](https://www.aicpa.org/soc)
- [ISO/IEC 27001 Standard](https://www.iso.org/isoiec-27001-information-security.html)
- [NIST Cybersecurity Framework](https://www.nist.gov/cyberframework)
- [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)

---

_This compliance doc is **living**: update quarterly or after material system changes._
