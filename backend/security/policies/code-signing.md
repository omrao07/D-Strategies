# Code Signing Policy

This policy defines how source code, builds, and release artifacts are signed to ensure authenticity and integrity.  
It applies to all developers, CI/CD pipelines, and release managers working on this project.

---

## 1. Purpose

- Guarantee that code and binaries originate from trusted developers and pipelines.
- Prevent unauthorized or malicious modifications to source or release artifacts.
- Enable downstream consumers to verify authenticity before execution.

---

## 2. Scope

- **Source commits** (git commits & tags)
- **Build artifacts** (npm packages, Docker images, tarballs, binaries)
- **Configuration & manifests** (lockfiles, schema definitions)
- **Release bundles** (reports, templates, signed archives)

---

## 3. Responsibilities

- **Developers**
  - Must sign all commits and tags with an approved GPG key.
  - Keys must be unique, protected, and not shared.
- **Release Managers**
  - Ensure all release tags are signed.
  - Publish only artifacts signed by CI/CD with an organization-controlled key.
- **CI/CD**
  - Performs build signing automatically with a centrally-managed key.
  - Verifies dependency integrity before builds.

---

## 4. Keys & Algorithms

- **Developer keys**
  - GPG (RSA ≥ 4096 or Ed25519).
  - Registered with repository hosting service (e.g., GitHub).
- **CI/CD keys**
  - Stored in secret manager (Vault, AWS KMS, GCP KMS).
  - Limited scope, rotated annually.
- **Artifacts**
  - Prefer SHA-256 or SHA-512 for checksums.
  - Detached GPG signatures (`.sig`) accompany builds.

---

## 5. Procedures

### 5.1 Commits & Tags

- Every commit must be signed (`git commit -S`).
- Every release tag must be signed (`git tag -s v1.0.0`).
- Unsigned commits may be rejected by CI/CD.

### 5.2 Build Artifacts

- CI/CD generates checksums and signatures.
- Example: `myapp-1.0.0.tgz` and `myapp-1.0.0.tgz.sig`.
- Checksums stored in `CHECKSUMS.txt` with SHA-256.

### 5.3 Verification

- Developers verify signatures with:

  ```bash
  git verify-commit <commit>
  git verify-tag <tag>
  gpg --verify myapp-1.0.0.tgz.sig myapp-1.0.0.tgz
