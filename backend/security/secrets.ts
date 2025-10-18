// security/rbac.ts
// Lightweight, dependency-free Role-Based Access Control with:
// - Roles, permissions (resource + action) and optional condition functions
// - Role inheritance (hierarchies)
// - User → roles assignment (static or dynamic via resolver)
// - Allow/Deny semantics with deterministic evaluation order
// - “Explain” API that shows WHY access was granted/denied
// - Tiny in-memory cache you can disable or scope per-tenant
//
// This is framework-agnostic and works in Node or the browser.

export type Action = string;        // e.g. "read", "write", "delete"
export type Resource = string;      // e.g. "orders", "users:123"
export type Subject = {
  id?: string;
  roles?: string[];
  [k: string]: unknown;             // attributes for conditions
};

export type Context = {
  resource?: Resource;
  action?: Action;
  tenant?: string;
  [k: string]: unknown;             // arbitrary request or environment attrs
};

// A condition returns true if the grant applies for (subject, ctx).
export type Condition = (s: Subject, ctx: Context) => boolean | Promise<boolean>;

export type Grant = {
  resource: Resource | RegExp;
  action: Action | RegExp | Action[];  // single, regex, or list (OR)
  when?: Condition;                     // optional ABAC condition
  effect?: "allow" | "deny";            // default "allow"
  description?: string;                 // for explain()
};

export type Role = {
  name: string;
  inherits?: string[];                  // role hierarchy
  grants?: Grant[];
  description?: string;
};

export type RbacModel = {
  roles: Record<string, Role>;
  // Optional dynamic role resolver (e.g., based on org membership)
  resolveRoles?: (s: Subject, ctx: Context) => string[] | Promise<string[]>;
  // Optional cache namespace segregation (e.g., by tenant)
  cacheBy?: (s: Subject, ctx: Context) => string | undefined;
  // Set to false to disable caching
  cache?: boolean;
};

export type Decision = {
  allowed: boolean;
  role?: string;
  grant?: Grant;
  reason: "explicit-allow" | "explicit-deny" | "no-match";
  matched?: { role: string; grant: Grant }[]; // all candidates that matched resource/action before condition
};

type CacheKey = string;

// ------------------------------- Utilities --------------------------------

function toArray<T>(v: T | T[] | RegExp): (T | RegExp)[] {
  return Array.isArray(v) ? v : [v];
}

function matches(value: string, rule: string | RegExp): boolean {
  return typeof rule === "string" ? value === rule || wildcard(rule, value) : rule.test(value);
}

// Support "orders:*", "users:*:read", "orders:123" etc. '*' only, no '?'
function wildcard(pattern: string, value: string): boolean {
  if (!pattern.includes("*")) return pattern === value;
  // Escape regex special chars except '*', then turn '*' to '.*'
  const re = new RegExp("^" + pattern.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return re.test(value);
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

// ------------------------------- RBAC Core --------------------------------

export class RBAC {
  private roles: Record<string, Role>;
  private resolveRoles?: RbacModel["resolveRoles"];
  private cacheBy?: RbacModel["cacheBy"];
  private useCache: boolean;

  // cache: key -> decision (positive or negative)
  private cache = new Map<CacheKey, Decision>();

  constructor(model: RbacModel) {
    this.roles = model.roles || {};
    this.resolveRoles = model.resolveRoles;
    this.cacheBy = model.cacheBy;
    this.useCache = model.cache !== false;
  }

  /** Add/replace a role definition at runtime. */
  upsertRole(role: Role) {
    this.roles[role.name] = { grants: [], inherits: [], ...this.roles[role.name], ...role };
    // invalidate role-related cache
    if (this.useCache) for (const k of this.cache.keys()) if (k.includes(`|role:${role.name}|`)) this.cache.delete(k);
  }

  /** Resolve the full set of roles for a subject, including inheritance. */
  async rolesFor(subject: Subject, ctx: Context = {}): Promise<string[]> {
    const base = uniq([...(subject.roles || []), ...(await this.dynamicRoles(subject, ctx))]);
    const out = new Set<string>();
    const visit = (r: string, depth = 0) => {
      if (depth > 16) return; // safety
      if (!r || out.has(r)) return;
      out.add(r);
      const role = this.roles[r];
      if (role?.inherits) role.inherits.forEach((p) => visit(p, depth + 1));
    };
    base.forEach((r) => visit(r));
    return Array.from(out);
  }

  private async dynamicRoles(subject: Subject, ctx: Context): Promise<string[]> {
    try {
      const res = await Promise.resolve(this.resolveRoles?.(subject, ctx) ?? []);
      return res || [];
    } catch {
      return [];
    }
  }

  /** Check if (subject, ctx) is allowed to perform action on resource. */
  async can(subject: Subject, action: Action, resource: Resource, ctx: Context = {}): Promise<boolean> {
    const d = await this.explain(subject, action, resource, ctx);
    return d.allowed;
  }

  /** Explain the decision with the matching role/grant (if any). */
  async explain(subject: Subject, action: Action, resource: Resource, ctx: Context = {}): Promise<Decision> {
    const key = this.key(subject, action, resource, ctx);
    if (this.useCache) {
      const cached = this.cache.get(key);
      if (cached) return cached;
    }

    const roles = await this.rolesFor(subject, ctx);
    const matched: { role: string; grant: Grant }[] = [];

    // Evaluation order: DENY beats ALLOW when both conditions pass.
    // We collect potential matches (resource/action only) then evaluate conditions.
    const allowQueue: { role: string; grant: Grant }[] = [];
    const denyQueue: { role: string; grant: Grant }[] = [];

    for (const r of roles) {
      const role = this.roles[r];
      if (!role?.grants) continue;

      for (const g of role.grants) {
        const actions = toArray<Action>(g.action as any);
        const actionMatched = actions.some((a) => matches(action, a as any));
        const resMatched = matches(resource, g.resource);
        if (!actionMatched || !resMatched) continue;

        const item = { role: r, grant: g };
        matched.push(item);
        (g.effect === "deny" ? denyQueue : allowQueue).push(item);
      }
    }

    // Evaluate DENY conditions first
    for (const { role, grant } of denyQueue) {
      const ok = grant.when ? await Promise.resolve(grant.when(subject, ctx)) : true;
      if (ok) {
        const decision: Decision = {
          allowed: false,
          role,
          grant,
          reason: "explicit-deny",
          matched,
        };
        if (this.useCache) this.cache.set(key, decision);
        return decision;
      }
    }

    // Evaluate ALLOW conditions
    for (const { role, grant } of allowQueue) {
      const ok = grant.when ? await Promise.resolve(grant.when(subject, ctx)) : true;
      if (ok) {
        const decision: Decision = {
          allowed: true,
          role,
          grant,
          reason: "explicit-allow",
          matched,
        };
        if (this.useCache) this.cache.set(key, decision);
        return decision;
      }
    }

    const decision: Decision = { allowed: false, reason: "no-match", matched };
    if (this.useCache) this.cache.set(key, decision);
    return decision;
  }

  /** Clear cache (optionally by tenant or predicate). */
  clearCache(pred?: (key: string, decision: Decision) => boolean) {
    if (!this.useCache) return;
    if (!pred) this.cache.clear();
    else for (const k of [...this.cache.keys()]) {
      const v = this.cache.get(k)!;
      if (pred(k, v)) this.cache.delete(k);
    }
  }

  // ---------------------------- Convenience -----------------------------

  /** Guard helper for HTTP handlers. Throws 403 on deny. */
  async assert(subject: Subject, action: Action, resource: Resource, ctx: Context = {}) {
    const d = await this.explain(subject, action, resource, ctx);
    if (!d.allowed) {
      const msg = `Forbidden: ${action} ${resource} (${d.reason}${d.role ? ` via ${d.role}` : ""})`;
      const err = Object.assign(new Error(msg), { statusCode: 403, decision: d });
      throw err;
    }
  }

  // Build a stable cache key capturing tenant/domain separation if provided.
  private key(subject: Subject, action: Action, resource: Resource, ctx: Context): string {
    const tenant = this.cacheBy?.(subject, ctx) ?? ctx.tenant ?? "";
    const roles = (subject.roles || []).slice().sort().join(",");
    const hint = `t:${tenant}|a:${action}|r:${resource}|roles:${roles}`;
    // include role names present in model to invalidate rough scope on upserts
    const modelSig = Object.keys(this.roles).sort().join(",");
    return `${hint}|model:${modelSig}`;
  }
}

// ------------------------------- Helpers ----------------------------------

// Shorthand to create a role with convenient wildcard grants.
export function role(name: string, grants: Array<Partial<Grant> & Pick<Grant, "resource" | "action">>, inherits: string[] = []): Role {
  return {
    name,
    inherits,
    grants: grants.map((g) => ({
      effect: "allow",
      when: undefined,
      description: undefined,
      ...g,
    })),
  };
}

// Example condition factories
export const when = {
  // subject.id must equal ctx.ownerId
  owner: (field: string = "ownerId"): Condition => (s, ctx) => String((s as any).id) === String((ctx as any)[field]),
  // subject has attribute true
  flag: (attr: string): Condition => (s) => Boolean((s as any)[attr]),
  // tenant match
  tenant: (): Condition => (s, ctx) => (s as any).tenant === ctx.tenant,
};

// ------------------------------- Example ----------------------------------
// const model: RbacModel = {
//   roles: {
//     admin: role("admin", [{ resource: "*", action: "*"}]),
//     analyst: role("analyst", [{ resource: "reports:*", action: ["read", "export"] }]),
//     owner: role("owner", [
//       { resource: "orders:*", action: "read", when: when.owner("orderOwnerId") },
//       { resource: "orders:*", action: "update", when: when.owner("orderOwnerId") },
//     ]),
//   },
//   cacheBy: (_s, ctx) => ctx.tenant,
// };
// const rbac = new RBAC(model);
// await rbac.can({ id: "u1", roles: ["analyst"] }, "read", "reports:daily", { tenant: "acme" });
