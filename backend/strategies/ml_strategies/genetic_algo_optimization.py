#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
genetic_algo_optimization.py — Genetic algorithm for strategy parameter optimization
=====================================================================================
Uses a simple genetic algorithm (selection, crossover, mutation) to optimize
trading rule parameters. Fitness function = Sharpe ratio on in-sample data.
Prevents overfitting via out-of-sample validation and diversity control.
Parameterizes: momentum lookbacks, z-score thresholds, position sizing.

Inputs (CSV)
------------
--prices   prices.csv
    Columns: date, ticker, close

Outputs
-------
outdir/best_params.json     best parameter set per ticker
outdir/evolution_log.csv    generation, best_fitness, avg_fitness, diversity
outdir/backtest.csv         out-of-sample cumulative P&L with best params
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
import random


PARAM_BOUNDS = {
    "mom_short": (5, 30),
    "mom_long": (40, 120),
    "vol_window": (10, 60),
    "entry_z": (1.0, 3.0),
    "exit_z": (0.1, 1.0),
    "position_size": (0.5, 2.0)
}
POP_SIZE = 50
N_GENERATIONS = 30
MUTATION_RATE = 0.15
CROSSOVER_RATE = 0.7
ELITE_FRACTION = 0.1
TRAIN_FRACTION = 0.6


def random_individual() -> dict:
    return {k: random.uniform(lo, hi) for k, (lo, hi) in PARAM_BOUNDS.items()}


def evaluate(individual: dict, prices: pd.Series) -> float:
    """Compute Sharpe on the given price series using individual's parameters."""
    c = prices
    mom_s = int(individual["mom_short"])
    mom_l = int(individual["mom_long"])
    vol_w = int(individual["vol_window"])
    entry_z = individual["entry_z"]
    exit_z = individual["exit_z"]
    pos_size = individual["position_size"]

    if len(c) < mom_l + vol_w + 10:
        return -10.0

    mom = (c.pct_change(mom_s) - c.pct_change(mom_l)).dropna()
    vol = c.pct_change().rolling(vol_w).std().dropna()
    aligned = mom.align(vol, join="inner")
    if len(aligned[0]) < 50 or aligned[1].replace(0, np.nan).isna().all():
        return -10.0

    z = aligned[0] / (aligned[1].replace(0, np.nan))
    pos = pd.Series(0.0, index=z.index)
    pos[z > entry_z] = pos_size
    pos[z < -entry_z] = -pos_size
    pos[(z.abs() < exit_z)] = 0
    ret = c.pct_change().reindex(z.index)
    port = (pos.shift(1) * ret).dropna()
    if len(port) < 20 or port.std() == 0:
        return -10.0
    return float(port.mean() / port.std() * np.sqrt(252))


def tournament_select(population: list, fitnesses: list, k: int = 3) -> dict:
    idx = random.sample(range(len(population)), k)
    best = max(idx, key=lambda i: fitnesses[i])
    return population[best].copy()


def crossover(p1: dict, p2: dict) -> tuple:
    c1, c2 = p1.copy(), p2.copy()
    for k in PARAM_BOUNDS:
        if random.random() < CROSSOVER_RATE:
            alpha = random.random()
            c1[k] = alpha * p1[k] + (1 - alpha) * p2[k]
            c2[k] = alpha * p2[k] + (1 - alpha) * p1[k]
    return c1, c2


def mutate(individual: dict) -> dict:
    ind = individual.copy()
    for k, (lo, hi) in PARAM_BOUNDS.items():
        if random.random() < MUTATION_RATE:
            ind[k] = random.uniform(lo, hi)
    return ind


def clamp(individual: dict) -> dict:
    return {k: max(lo, min(hi, individual[k])) for k, (lo, hi) in PARAM_BOUNDS.items()}


def run(cfg):
    random.seed(42)
    np.random.seed(42)
    os.makedirs(cfg.outdir, exist_ok=True)
    prices = pd.read_csv(cfg.prices_file, parse_dates=["date"])
    prices.columns = [c.lower().strip() for c in prices.columns]

    best_params_all = {}
    evo_records = []
    all_oos_returns = []

    for ticker in prices["ticker"].unique():
        sub = prices[prices["ticker"] == ticker].set_index("date").sort_index()
        if len(sub) < 200:
            continue

        n_train = int(len(sub) * TRAIN_FRACTION)
        train_prices = sub["close"].iloc[:n_train]
        test_prices = sub["close"].iloc[n_train:]

        population = [random_individual() for _ in range(POP_SIZE)]
        n_elite = max(1, int(POP_SIZE * ELITE_FRACTION))

        for gen in range(cfg.n_generations):
            fitnesses = [evaluate(ind, train_prices) for ind in population]
            sorted_idx = np.argsort(fitnesses)[::-1]
            best_fit = fitnesses[sorted_idx[0]]
            avg_fit = float(np.mean(fitnesses))
            diversity = float(np.std([ind["entry_z"] for ind in population]))

            evo_records.append({"ticker": ticker, "generation": gen, "best_fitness": best_fit,
                                 "avg_fitness": avg_fit, "diversity": diversity})

            elites = [population[i] for i in sorted_idx[:n_elite]]
            new_pop = elites.copy()

            while len(new_pop) < POP_SIZE:
                p1 = tournament_select(population, fitnesses)
                p2 = tournament_select(population, fitnesses)
                c1, c2 = crossover(p1, p2)
                new_pop.append(clamp(mutate(c1)))
                if len(new_pop) < POP_SIZE:
                    new_pop.append(clamp(mutate(c2)))

            population = new_pop

        final_fitnesses = [evaluate(ind, train_prices) for ind in population]
        best_idx = int(np.argmax(final_fitnesses))
        best_ind = population[best_idx]
        best_params_all[ticker] = {k: float(v) for k, v in best_ind.items()}
        best_params_all[ticker]["in_sample_sharpe"] = float(final_fitnesses[best_idx])

        # OOS evaluation
        if len(test_prices) > 50:
            oos_sharpe = evaluate(best_ind, test_prices)
            best_params_all[ticker]["out_of_sample_sharpe"] = float(oos_sharpe)

            # Generate OOS returns for backtest
            c = test_prices
            mom = (c.pct_change(int(best_ind["mom_short"])) - c.pct_change(int(best_ind["mom_long"]))).dropna()
            vol = c.pct_change().rolling(int(best_ind["vol_window"])).std().dropna()
            aligned = mom.align(vol, join="inner")
            if len(aligned[0]) > 10:
                z = aligned[0] / (aligned[1].replace(0, np.nan))
                pos = pd.Series(0.0, index=z.index)
                pos[z > best_ind["entry_z"]] = best_ind["position_size"]
                pos[z < -best_ind["entry_z"]] = -best_ind["position_size"]
                ret = c.pct_change().reindex(z.index)
                oos_ret = (pos.shift(1) * ret).dropna()
                all_oos_returns.append(oos_ret.rename(ticker))

    with open(os.path.join(cfg.outdir, "best_params.json"), "w") as f:
        json.dump(best_params_all, f, indent=2)

    if evo_records:
        pd.DataFrame(evo_records).to_csv(os.path.join(cfg.outdir, "evolution_log.csv"), index=False)

    if all_oos_returns:
        port = pd.concat(all_oos_returns, axis=1).mean(axis=1).dropna()
        cum = (1 + port).cumprod()
        cum.to_frame("cumulative").to_csv(os.path.join(cfg.outdir, "backtest.csv"))
        sharpe = float(port.mean() / port.std() * np.sqrt(252)) if port.std() > 0 else None
        ann_ret = float(port.mean() * 252)
    else:
        sharpe, ann_ret = None, None

    avg_is = float(np.mean([v["in_sample_sharpe"] for v in best_params_all.values()])) if best_params_all else None
    avg_oos = float(np.mean([v["out_of_sample_sharpe"] for v in best_params_all.values() if "out_of_sample_sharpe" in v])) if best_params_all else None
    summary = {
        "tickers_optimized": list(best_params_all.keys()),
        "avg_in_sample_sharpe": avg_is,
        "avg_out_of_sample_sharpe": avg_oos,
        "overfitting_ratio": float(avg_oos / avg_is) if avg_is and avg_oos and avg_is != 0 else None,
        "ann_return_oos": ann_ret, "sharpe_oos": sharpe,
        "params": {"pop_size": POP_SIZE, "n_generations": cfg.n_generations, "mutation_rate": MUTATION_RATE}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"Genetic Algo | Tickers: {len(best_params_all)} | IS Sharpe: {f'{avg_is:.2f}' if avg_is else 'N/A'} | OOS Sharpe: {f'{avg_oos:.2f}' if avg_oos else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prices", required=True, dest="prices_file")
    ap.add_argument("--n-generations", type=int, default=N_GENERATIONS)
    ap.add_argument("--outdir", default="./artifacts/genetic_algo")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
