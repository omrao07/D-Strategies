# Role-Based Access Control (RBAC)

This document describes the RBAC layer implemented in [`security/rbac.ts`](./rbac.ts).  
It provides a minimal but extensible system for controlling which users and roles can perform sensitive actions (e.g., running models, viewing risk, generating reports).

---

## 1. Concepts

- **Role**: A named label assigned to a user, such as `admin`, `analyst`, or `viewer`.
- **Permission**: A string identifying an action, such as:
  - `models:run`
  - `risk:view`
  - `reports:generate`
  - `reports:view`
  - `*` (wildcard = all)
- **Policy**: Mapping of a role → allowed permissions (and optional explicit denies).
- **User**: Identified by `id` and a list of assigned roles.

---

## 2. Default Policy Set

The default policies in `rbac.ts` are:

- **admin**
  - allow: `*` (all actions)
- **analyst**
  - allow: `models:run`, `risk:view`, `reports:generate`
- **viewer**
  - allow: `reports:view`, `risk:view`
  - deny: `models:run`

---

## 3. Example: Permissions Matrix

| Role    | models:run | risk:view | reports:generate | reports:view | serve:start |
|---------|------------|-----------|------------------|--------------|-------------|
| admin   | ✅         | ✅        | ✅               | ✅           | ✅          |
| analyst | ✅         | ✅        | ✅               | ❌           | ❌          |
| viewer  | ❌         | ✅        | ❌               | ✅           | ❌          |

---

## 4. API Summary (`rbac.ts`)

```ts
const rbac = new RBAC(defaultPolicies());

// Check a role directly
rbac.canRole("analyst", "risk:view"); // true

// Check a user with roles
const user = { id: "u1", roles: ["analyst"] };
rbac.canUser(user, "models:run"); // true

// Enforce (throws if not permitted)
rbac.enforce(user, "reports:view"); // throws if analyst
