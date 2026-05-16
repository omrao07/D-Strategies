import numpy as np
from scipy.optimize import minimize

rng = np.random.default_rng(11)
n = 10
A = rng.normal(size=(n, n))
Sigma = A @ A.T
d = np.sqrt(np.diag(Sigma))
Sigma = Sigma / np.outer(d, d)
vols = rng.uniform(0.1, 0.35, size=n)
Sigma = Sigma * np.outer(vols, vols)

target = 1.0 / n

def obj_normalized(w):
    pv = max(1e-14, float(w @ Sigma @ w))
    rc = w * (Sigma @ w) / pv
    return float(np.sum((rc - target) ** 2))

# Test with lb=1e-4
lb, ub = 1e-4, 0.4
best_w, best_val = None, float('inf')
for seed in range(20):
    rng2 = np.random.default_rng(seed)
    w0 = rng2.dirichlet(np.ones(n))
    w0 = np.clip(w0, lb, ub)
    w0 = w0 / w0.sum()
    res = minimize(obj_normalized, w0, method='SLSQP',
        bounds=[(lb, ub)]*n,
        constraints=[{'type':'eq','fun':lambda w: np.sum(w)-1.0}],
        options={'maxiter':5000, 'ftol':1e-14})
    if res.fun < best_val:
        best_val, best_w = res.fun, res.x

w = best_w
rc = w * (Sigma @ w)
print("lb=1e-4, normalized objective:")
print("RC:", rc)
print("max-min:", float(np.max(rc) - np.min(rc)))
print("0.10*mean+1e-6:", float(0.10*np.mean(rc)+1e-6))
print("PASS:", bool(np.max(rc) - np.min(rc) <= 0.10*np.mean(rc)+1e-6))
print()

# Try with Maillard 2010 approach: unconstrained then normalize
def obj_maillard(y):
    pv = max(1e-14, float(y @ Sigma @ y))
    rc = y * (Sigma @ y) / pv
    return float(np.sum((rc - target) ** 2))

y0 = np.full(n, 1.0)
res = minimize(obj_maillard, y0, method='SLSQP',
    bounds=[(1e-6, None)]*n,
    options={'maxiter':5000, 'ftol':1e-14})
w_m = res.x / res.x.sum()
rc_m = w_m * (Sigma @ w_m)
print("Maillard (unconstrained then normalize):")
print("RC:", rc_m)
print("max-min:", float(np.max(rc_m) - np.min(rc_m)))
print("PASS:", bool(np.max(rc_m) - np.min(rc_m) <= 0.10*np.mean(rc_m)+1e-6))
