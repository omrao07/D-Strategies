// options/pricing.js
// Option pricing models: Black-Scholes and Bachelier
// Provides price + greeks for calls/puts

/**
 * @typedef {"C"|"P"} Right
 * @typedef {"bs"|"bachelier"} Model
 */

const sqrt = Math.sqrt, exp = Math.exp, log = Math.log, pow = Math.pow;

/** Standard normal pdf */
function phi(x) {
  return (1/Math.sqrt(2*Math.PI)) * Math.exp(-0.5*x*x);
}
/** Standard normal cdf (approx via erf) */
function Phi(x) {
  return 0.5 * (1 + erf(x/Math.SQRT2));
}
/** Error function approximation */
function erf(x) {
  // Abramowitz-Stegun approx
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1/(1+0.3275911*x);
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429;
  const y = 1 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return sign*y;
}

/**
 * Black-Scholes price + greeks
 * @param {"C"|"P"} right
 * @param {number} S spot
 * @param {number} K strike
 * @param {number} T time to expiry (years)
 * @param {number} r risk-free rate
 * @param {number} q dividend yield
 * @param {number} vol volatility (annualized, decimal)
 */
export function bs(right, S, K, T, r, q, vol) {
  if (T <= 0 || vol <= 0) {
    const intrinsic = Math.max((right==="C"?S-K:K-S),0);
    return { price: intrinsic, delta:0, gamma:0, vega:0, theta:0, rho:0 };
  }
  const d1 = (Math.log(S/K) + (r - q + 0.5*vol*vol)*T)/(vol*Math.sqrt(T));
  const d2 = d1 - vol*Math.sqrt(T);

  let price, delta, gamma, vega, theta, rho;
  if (right === "C") {
    price = S*Math.exp(-q*T)*Phi(d1) - K*Math.exp(-r*T)*Phi(d2);
    delta = Math.exp(-q*T)*Phi(d1);
    gamma = Math.exp(-q*T)*phi(d1)/(S*vol*Math.sqrt(T));
    vega  = S*Math.exp(-q*T)*phi(d1)*Math.sqrt(T);
    theta = -(S*phi(d1)*vol*Math.exp(-q*T))/(2*Math.sqrt(T))
            - r*K*Math.exp(-r*T)*Phi(d2)
            + q*S*Math.exp(-q*T)*Phi(d1);
    rho   = K*T*Math.exp(-r*T)*Phi(d2);
  } else {
    price = K*Math.exp(-r*T)*Phi(-d2) - S*Math.exp(-q*T)*Phi(-d1);
    delta = -Math.exp(-q*T)*Phi(-d1);
    gamma = Math.exp(-q*T)*phi(d1)/(S*vol*Math.sqrt(T));
    vega  = S*Math.exp(-q*T)*phi(d1)*Math.sqrt(T);
    theta = -(S*phi(d1)*vol*Math.exp(-q*T))/(2*Math.sqrt(T))
            + r*K*Math.exp(-r*T)*Phi(-d2)
            - q*S*Math.exp(-q*T)*Phi(-d1);
    rho   = -K*T*Math.exp(-r*T)*Phi(-d2);
  }
  return { price, delta, gamma, vega, theta, rho };
}

/**
 * Bachelier model price + greeks
 * (Normal model, useful for low rates / IR options)
 */
export function bachelier(right, S, K, T, r, q, vol) {
  if (T <= 0 || vol <= 0) {
    const intrinsic = Math.max((right==="C"?S-K:K-S),0);
    return { price: intrinsic, delta:0, gamma:0, vega:0, theta:0, rho:0 };
  }
  const fwd = S * Math.exp((r-q)*T);
  const sigmaT = vol*Math.sqrt(T);
  const d = (fwd - K)/sigmaT;
  const call = exp(-r*T)*((fwd-K)*Phi(d) + sigmaT*phi(d));
  const put  = exp(-r*T)*((K-fwd)*Phi(-d) + sigmaT*phi(d));
  let price, delta, gamma, vega, theta, rho;
  if (right==="C") price=call; else price=put;

  // Greeks (approx, under normal model)
  const nd = phi(d);
  const fd = Phi(d);
  if (right==="C") {
    delta = exp(-r*T)*fd; // crude
  } else {
    delta = -exp(-r*T)*Phi(-d);
  }
  gamma = exp(-r*T)*nd/sigmaT;
  vega  = exp(-r*T)*nd*sqrt(T);
  theta = -0.5*vega*vol/sqrt(T);
  rho   = -T*price; // placeholder
  return { price, delta, gamma, vega, theta, rho };
}

/**
 * Unified entry
 * @param {Model} model
 */
export function priceGreeks(model, right, S, K, T, r, q, vol) {
  if (model === "bs") return bs(right,S,K,T,r,q,vol);
  if (model === "bachelier") return bachelier(right,S,K,T,r,q,vol);
  throw new Error(`Unknown model: ${model}`);
}

export default { bs, bachelier, priceGreeks };
const { priceGrid, curve } = await load.payoff();
const { summarize } = await load.strategies();
const { priceGreeks } = await load.pricing();
const OptMargin = await load.margin();

const { StrategyRegistry } = await load.registry();
const { runStrategy }      = await load.runner();
const { makeContext }      = await load.context();
const { DemoFeed }         = await load.demoFeed();
const { PaperBroker }      = await load.paperBroker();
const { FSRepo }           = await load.fsRepo();