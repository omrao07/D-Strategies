# Dependency Management Policy

This policy defines how third-party dependencies (npm packages, libraries, modules) are selected, introduced, and maintained in this project.  
It is intended to reduce **supply chain risk**, maintain stability, and ensure audit readiness.

---

## 1. Purpose

- Minimize risk from unvetted or malicious dependencies.
- Ensure dependencies are up to date with security patches.
- Preserve reproducibility of builds through lockfiles and checksums.
- Comply with open-source license obligations.

---

## 2. Scope

- All runtime and development dependencies (npm, Node, TypeScript).
- Transitive dependencies (pulled indirectly).
- Build-time dependencies (linters, test tools).
- Scripts that download external code (disallowed unless approved).

---

## 3. Principles

1. **Prefer fewer dependencies** — implement small utilities in-house where practical.
2. **Pin versions** — use exact versions in `package-lock.json` / `pnpm-lock.yaml`.
3. **Immutable builds** — never update lockfiles casually; always commit them.
4. **Review licenses** — avoid copyleft or unknown licenses unless explicitly approved.
5. **Audit security** — run `npm audit` and dependency scanners regularly.
6. **Ban unmaintained packages** — no deps without recent updates/security support.
7. **No postinstall scripts** — dependencies with unsafe install hooks must be reviewed or rejected.

---

## 4. Dependency Lifecycle

### 4.1 Adding a Dependency

- Justify need (cannot reasonably implement in <100 lines?).
- Check:
  - GitHub activity (commits in last 12 months).
  - Community adoption (downloads/stars).
  - License compatibility.
- Submit PR with reasoning + audit log.

### 4.2 Updating a Dependency

- Use Dependabot or Renovate PRs.
- Review changelog & breaking changes.
- Re-run integration tests (`cash_conservation`, `leverage_bounds`).
- Ensure lockfile is updated and committed.

### 4.3 Removing a Dependency

- Remove unused/abandoned deps regularly.
- Replace with internal implementation if simpler.

---

## 5. Verification & Audits

- **Lockfiles**: must always be checked in (`package-lock.json`).
- **Checksums**: build pipeline should verify integrity.
- **Audits**:
  - `npm audit --production` at least monthly.
  - Review all high/critical vulnerabilities before release.
- **CI/CD**:
  - Run dependency scanner in pipeline.
  - Fail build if new critical vulnerabilities are found.

---

## 6. Supply Chain Security

- **No direct GitHub `HEAD` installs** (e.g., `user/repo#branch`).
- **No unverified forks** without security team approval.
- **Prefer signed releases** when available.
- **Consider SBOM (Software Bill of Materials)** for formal compliance.

---

## 7. License Compliance

- Track dependency licenses with `license-checker`.
- Maintain a `THIRD_PARTY_LICENSES.md` file.
- Legal review required for GPL, AGPL, or unknown licenses.

---

## 8. Enforcement

- CI/CD enforces:
  - Lockfile presence.
  - No unsigned commits introducing new deps.
  - Audit scans pass.
- PR reviewers must approve all new or updated dependencies.

---

## 9. Exceptions

- Emergency fixes may temporarily bypass checks with **security owner approval**.
- Exceptions must be documented in PR and reviewed within 7 days.

---

## 10. Review & Maintenance

- Dependency inventory reviewed **quarterly**.
- Outdated deps updated at least once per quarter.
- Security team reviews policy annually.

---

## 11. References

- [OWASP Dependency Management](https://owasp.org/www-project-dependency-check/)
- [SLSA: Supply-chain Levels for Software Artifacts](https://slsa.dev/)
- [NPM Security Best Practices](https://docs.npmjs.com/auditing-package-dependencies-for-security-vulnerabilities)

---

_This project treats dependencies as **potential attack vectors**.  
Every addition must be justified, audited, and reviewed._
