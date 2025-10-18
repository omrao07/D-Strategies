# Secrets Management Guidelines

This document describes how secrets (API keys, credentials, tokens, certificates) are handled in this project.  
It is a **policy + runbook** for developers and operators.

---

## 1. What Are "Secrets"?

Secrets include (but are not limited to):

- API keys for data providers
- Access tokens (OAuth, Bearer, JWT)
- Database credentials
- TLS private keys / certs
- Internal service tokens
- Passwords or passphrases
- Any config value that should not be public

---

## 2. Golden Rules

1. **Never commit secrets to git** (including `.env`, config files, test fixtures).
2. **Load at runtime** from environment variables, secret files with restricted permissions, or secret managers.
3. **Redact secrets in logs** — ensure keys like `*_KEY`, `*_SECRET`, `TOKEN`, `PASSWORD` are masked.
4. **Rotate regularly** — at least every 90 days, or immediately after suspected exposure.
5. **Principle of least privilege** — request minimal scopes/permissions for tokens.
6. **Audit dependencies** — no secrets should be visible in stack traces or error logs.

---

## 3. Where Secrets Live

- **Local development**
  - Use a `.env.local` file (ignored by git).
  - Restrict file perms: `chmod 600 .env.local`.
  - Load into shell with `export $(cat .env.local | xargs)` or a tool like `direnv`.

- **CI/CD**
  - Secrets are injected via CI environment (e.g., GitHub Actions secrets, GitLab CI variables).
  - Do not hardcode in YAML or scripts.

- **Production**
  - Prefer an external secrets manager (e.g., AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager).
  - If not available, use environment variables or mounted files with restrictive permissions.

---

## 4. Handling Secrets in Code

- Access via `process.env.SECRET_NAME` (Node).
- Use centralized config loading (e.g., `core/config.ts`) to avoid scattering env lookups.
- Never stringify full env objects in logs.
- Redact values using [`security/redact.ts`](./redact.ts).

---

## 5. Rotation & Expiry

- All API keys should have an **expiry date** tracked in an internal inventory.
- Rotate quarterly or on-demand.
- Document rotation procedure:
  - Generate new key.
  - Update secret manager or `.env.local`.
  - Redeploy services.
  - Invalidate old key.

---

## 6. Detection & Response

- **Detection**
  - Pre-commit hooks: scan staged files for high-entropy strings.
  - CI pipeline: run secret scanning (`trufflehog`, `gitleaks`, etc.).
- **Response**
  - If a secret leaks:
    1. Rotate immediately.
    2. Purge logs/builds/artifacts containing the secret.
    3. Review access logs for misuse.
    4. Document the incident.

---

## 7. Testing Guidelines

- Use **fake values** (`FAKE_API_KEY=12345`) in test fixtures.
- If integration testing requires real secrets:
  - Store only in CI/CD secret vaults.
  - Gate such tests behind a flag (e.g., `RUN_INTEGRATION_TESTS=true`).

---

## 8. Checklist

- [ ] Secrets never in git history.
- [ ] Secrets loaded at runtime (env / manager).
- [ ] File perms restricted (0600).
- [ ] Redaction enabled in logger.
- [ ] Rotation schedule documented.
- [ ] Secret scanning enabled in CI.

---

## 9. References

- [OWASP Secrets Management](https://owasp.org/www-community/attacks/Secrets_Management)
- [HashiCorp Vault](https://www.vaultproject.io/)
- [Mozilla: Handling Secrets](https://infosec.mozilla.org/guidelines/secrets_management)

---

_This project treats secrets as **ephemeral runtime values** — never as code._
