#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
reinforcement_learning_exec.py — Q-learning agent for execution optimization
=============================================================================
Implements a tabular Q-learning agent for optimal order execution (TWAP/VWAP
improvement). State = (time_remaining, inventory_remaining, spread_regime, vol_regime).
Actions = aggressive/passive/skip. Reward = signed P&L vs VWAP benchmark.
Discrete state space allows tabular Q-table without function approximation.

Inputs (CSV)
------------
--orderbook orderbook_data.csv
    Columns: date, time, ticker, bid, ask, bid_size, ask_size, mid, vwap,
             volume (cumulative), volatility_5m

Outputs
-------
outdir/rl_policy.csv        state, best_action, q_value
outdir/execution_log.csv    episode, steps, total_slippage, vs_vwap_bps
outdir/training_curve.csv   episode, avg_reward
outdir/summary.json
"""

import argparse, json, os
import numpy as np
import pandas as pd
import random
from collections import defaultdict


# State space discretization
TIME_BINS = 5       # 0-20%, 20-40%, 40-60%, 60-80%, 80-100% of trading day
INV_BINS = 5        # fraction of order remaining
SPREAD_BINS = 3     # tight/normal/wide
VOL_BINS = 3        # low/normal/high

ACTIONS = ["aggressive", "passive", "skip"]
N_EPISODES = 500
GAMMA = 0.95
EPSILON_START = 1.0
EPSILON_END = 0.05
EPSILON_DECAY = 0.995
ALPHA = 0.1  # Q-learning rate


def discretize_state(time_pct: float, inv_pct: float,
                     spread_z: float, vol_z: float) -> tuple:
    t = min(int(time_pct * TIME_BINS), TIME_BINS - 1)
    i = min(int(inv_pct * INV_BINS), INV_BINS - 1)
    s = 0 if spread_z < -0.5 else (2 if spread_z > 0.5 else 1)
    v = 0 if vol_z < -0.5 else (2 if vol_z > 0.5 else 1)
    return (t, i, s, v)


def simulate_execution(episode_data: pd.DataFrame, policy: dict,
                       order_size: float, epsilon: float) -> tuple:
    n = len(episode_data)
    inventory = order_size
    total_cost = 0.0
    vwap_cost = 0.0
    vwap_sum = episode_data["vwap"].mean() if "vwap" in episode_data.columns else episode_data["mid"].mean()

    spread_mean = (episode_data["ask"] - episode_data["bid"]).mean()
    spread_std = (episode_data["ask"] - episode_data["bid"]).std() + 1e-10
    vol_mean = episode_data["volatility_5m"].mean() if "volatility_5m" in episode_data.columns else 0
    vol_std = episode_data["volatility_5m"].std() + 1e-10 if "volatility_5m" in episode_data.columns else 1

    rewards = []
    transitions = []

    for step, (_, row) in enumerate(episode_data.iterrows()):
        if inventory <= 0:
            break
        time_pct = step / n
        inv_pct = inventory / order_size
        spread = row["ask"] - row["bid"]
        vol = row.get("volatility_5m", vol_mean)
        spread_z = (spread - spread_mean) / spread_std
        vol_z = (vol - vol_mean) / vol_std

        state = discretize_state(time_pct, inv_pct, spread_z, vol_z)

        if random.random() < epsilon:
            action = random.choice(ACTIONS)
        else:
            q_vals = {a: policy.get((state, a), 0.0) for a in ACTIONS}
            action = max(q_vals, key=q_vals.get)

        # Simulate execution
        mid = row["mid"]
        if action == "aggressive":
            exec_price = row["ask"]
            exec_qty = min(inventory, float(row.get("ask_size", order_size * 0.1)))
            exec_cost = exec_price * exec_qty
        elif action == "passive":
            exec_price = row["bid"] + spread * 0.3
            exec_qty = min(inventory, float(row.get("bid_size", order_size * 0.05)))
            exec_cost = exec_price * exec_qty
        else:  # skip
            exec_qty = 0
            exec_cost = 0

        vwap_equiv = vwap_sum * exec_qty
        reward = (vwap_equiv - exec_cost) / (vwap_sum + 1e-10) * 10000  # bps vs VWAP

        # Urgency penalty if time running out with inventory
        if time_pct > 0.9 and inventory > order_size * 0.2:
            reward -= 5 * (inv_pct)

        inventory -= exec_qty
        total_cost += exec_cost
        vwap_cost += vwap_sum * exec_qty
        rewards.append(reward)
        transitions.append((state, action, reward, time_pct, inv_pct))

    return transitions, rewards, total_cost, vwap_cost


def run(cfg):
    np.random.seed(42)
    random.seed(42)
    os.makedirs(cfg.outdir, exist_ok=True)

    ob = pd.read_csv(cfg.orderbook_file, parse_dates=["date"])
    ob.columns = [c.lower().strip() for c in ob.columns]

    if "mid" not in ob.columns:
        ob["mid"] = (ob["bid"] + ob["ask"]) / 2
    if "volatility_5m" not in ob.columns:
        ob["volatility_5m"] = ob["mid"].pct_change(5).rolling(5).std().fillna(0.001)

    tickers = ob["ticker"].unique() if "ticker" in ob.columns else ["default"]
    Q = defaultdict(float)
    epsilon = EPSILON_START
    training_records = []
    exec_records = []

    for episode in range(cfg.n_episodes):
        # Sample a random trading day/ticker
        ticker = random.choice(tickers)
        sub = ob[ob["ticker"] == ticker] if "ticker" in ob.columns else ob
        if len(sub) < 10:
            continue
        date = random.choice(sub["date"].dt.date.unique()) if "date" in sub.columns else None
        if date:
            day_data = sub[sub["date"].dt.date == date].sort_values("date").head(100)
        else:
            day_data = sub.head(100)

        if len(day_data) < 5:
            continue

        order_size = float(day_data.get("bid_size", pd.Series([1000])).mean() * 10)
        transitions, rewards, total_cost, vwap_cost = simulate_execution(
            day_data, Q, order_size, epsilon
        )

        # Q-learning update
        for step, (state, action, reward, t_pct, i_pct) in enumerate(transitions):
            next_t_pct = (step + 1) / len(day_data)
            next_inv = max(0, 1 - (step + 1) / len(transitions)) if transitions else 0
            next_state = discretize_state(next_t_pct, next_inv, 0, 0)
            max_q_next = max(Q.get((next_state, a), 0.0) for a in ACTIONS)
            key = (state, action)
            Q[key] = Q[key] + ALPHA * (reward + GAMMA * max_q_next - Q[key])

        avg_reward = float(np.mean(rewards)) if rewards else 0
        slippage_bps = float((total_cost - vwap_cost) / (vwap_cost + 1e-10) * 10000) if vwap_cost > 0 else 0
        training_records.append({"episode": episode, "avg_reward": avg_reward,
                                  "slippage_bps": slippage_bps, "epsilon": epsilon})
        exec_records.append({"episode": episode, "steps": len(transitions),
                              "total_slippage": slippage_bps, "vs_vwap_bps": -slippage_bps})

        epsilon = max(EPSILON_END, epsilon * EPSILON_DECAY)

    # Export policy table
    policy_records = []
    for (state, action), q_val in Q.items():
        policy_records.append({"state": str(state), "action": action, "q_value": float(q_val)})

    pd.DataFrame(policy_records).to_csv(os.path.join(cfg.outdir, "rl_policy.csv"), index=False)
    pd.DataFrame(exec_records).to_csv(os.path.join(cfg.outdir, "execution_log.csv"), index=False)
    pd.DataFrame(training_records).to_csv(os.path.join(cfg.outdir, "training_curve.csv"), index=False)

    train_df = pd.DataFrame(training_records)
    summary = {
        "n_episodes": cfg.n_episodes,
        "final_epsilon": float(epsilon),
        "avg_reward_last_100": float(train_df.tail(100)["avg_reward"].mean()) if len(train_df) >= 100 else None,
        "avg_slippage_last_100_bps": float(train_df.tail(100)["slippage_bps"].mean()) if len(train_df) >= 100 else None,
        "q_table_size": len(Q),
        "best_action_aggressive_pct": float((train_df["avg_reward"] > 0).mean() * 100),
        "params": {"gamma": GAMMA, "alpha": ALPHA, "epsilon_start": EPSILON_START,
                   "epsilon_end": EPSILON_END, "n_episodes": cfg.n_episodes}
    }
    with open(os.path.join(cfg.outdir, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2, default=str)
    print(f"RL Execution | Episodes: {cfg.n_episodes} | Q-table: {len(Q)} states | Avg reward: {summary['avg_reward_last_100']:.2f if summary['avg_reward_last_100'] else 'N/A'} | Written to {cfg.outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--orderbook", required=True, dest="orderbook_file")
    ap.add_argument("--n-episodes", type=int, default=N_EPISODES)
    ap.add_argument("--outdir", default="./artifacts/rl_execution")
    args = ap.parse_args()
    run(args)

if __name__ == "__main__":
    main()
