# Definition of Done (DoD)

The **Definition of Done** provides a shared understanding of what it means for work to be "complete" in this project.  
A feature, story, bugfix, or task is not considered done until **all** of the following criteria are met.

---

## ✅ General Criteria

- Code is written, committed, and pushed to the main repository branch.
- Code compiles/builds without errors or warnings.
- All unit tests are written, updated, and pass successfully.
- Integration and end-to-end tests (if applicable) pass without failures.
- Linting, formatting, and static analysis checks pass (e.g., `eslint`, `tsc`, `prettier`).
- Security scans and secret scans return no critical/high findings.
- No known performance regressions introduced.

---

## 🛠 Code Quality

- Code follows established project style guides and conventions.
- Code is peer-reviewed and approved via pull request.
- Naming is clear and consistent; functions and classes are self-documenting where possible.
- No dead code, commented-out code, or TODOs remain unless tracked with a ticket.
- Observability hooks (logging, metrics, tracing) added where relevant.
- Error handling is explicit, not swallowed silently.

---

## 🧪 Testing

- Unit tests exist for new or changed logic with meaningful assertions.
- Coverage is maintained or improved; critical paths are covered.
- Edge cases and failure modes are tested.
- Automated CI pipeline is green.
- For bugfixes, regression tests reproduce the bug and validate the fix.

---

## 🔒 Security & Compliance

- No hardcoded secrets; sensitive configs are loaded from secure sources.
- RBAC and security policies are respected.
- Security audit passes (no new critical issues).
- Dependencies updated and free of known vulnerabilities (verified via `npm audit` or equivalent).
- Compliance documentation updated if needed (e.g., GDPR, SOC2, FINRA).

---

## 📖 Documentation

- Code is documented with inline comments where non-trivial.
- Public APIs, CLI commands, or modules are documented in `README.md` or relevant docs.
- Configuration changes are reflected in `config/*.json` or docs.
- Changelog (`docs/changelog.md`) updated if user-visible change.
- ADR (Architecture Decision Record) updated if major design decisions changed.

---

## 📊 Observability & Ops

- Health endpoints (/live, /ready, /health) updated if needed.
- Metrics exported for new critical logic.
- Logs are structured, contextual, and tested with realistic scenarios.
- SLO/SLA impact considered; alerting rules updated if needed.
- Runbooks/playbooks updated if operations workflows change.

---

## 🚀 Deployment & Release

- Build artifacts created and stored in release directory (`RELEASES/`).
- Manifest (`MANIFEST.json`) generated and includes version, commit, checksums.
- Deployment has been tested in a staging or demo environment.
- Rollback plan documented for production deploys.
- Feature flags applied if rollout is partial.

---

## 📦 Acceptance

- Stakeholder or product owner has reviewed and accepted the work.
- Meets the requirements of the linked issue, story, or ticket.
- No open blockers remain.

---

### 🔑 Summary

**Done = Coded + Tested + Reviewed + Secure + Documented + Deployable + Accepted.**
