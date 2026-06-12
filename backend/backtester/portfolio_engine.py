# backend/backtester/portfolio_engine.py
"""
Portfolio engine: NAV, margin, leverage, exposure, position sizing,
rebalancing, and multi-strategy weight allocation.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd

# ── Position ──────────────────────────────────────────────────────────────────

@dataclass
class Position:
    symbol: str
    qty: float = 0.0            # positive = long, negative = short
    avg_cost: float = 0.0       # average cost basis
    last_price: float = 0.0     # most recent mark price
    realized_pnl: float = 0.0
    strategy: str = ""

    @property
    def notional(self) -> float:
        return self.qty * self.last_price

    @property
    def unrealized_pnl(self) -> float:
        return self.qty * (self.last_price - self.avg_cost)

    @property
    def total_pnl(self) -> float:
        return self.realized_pnl + self.unrealized_pnl

    @property
    def is_long(self) -> bool:
        return self.qty > 0

    @property
    def is_short(self) -> bool:
        return self.qty < 0

    @property
    def is_flat(self) -> bool:
        return abs(self.qty) < 1e-9

    def market_value(self) -> float:
        """Signed market value (negative for short positions)."""
        return self.qty * self.last_price

    def update_price(self, price: float) -> None:
        self.last_price = price

    def apply_fill(self, fill_qty: float, fill_price: float, side: str) -> float:
        """
        Apply a fill to this position. Returns realized PnL from this fill.
        side: "buy" or "sell"
        """
        if side == "buy":
            if self.is_short:
                # Covering a short
                cover_qty = min(abs(self.qty), fill_qty)
                realized = cover_qty * (self.avg_cost - fill_price)
                self.realized_pnl += realized
                self.qty += cover_qty
                remaining = fill_qty - cover_qty
                if remaining > 1e-9:
                    # Excess becomes long
                    self.avg_cost = fill_price
                    self.qty = remaining
                elif abs(self.qty) < 1e-9:
                    self.qty = 0.0
                    self.avg_cost = 0.0
                return realized
            else:
                # Adding to long / opening long
                total_cost = self.qty * self.avg_cost + fill_qty * fill_price
                self.qty += fill_qty
                self.avg_cost = total_cost / self.qty if self.qty > 0 else 0.0
                return 0.0
        else:  # sell
            if self.is_long:
                # Selling a long
                sell_qty = min(self.qty, fill_qty)
                realized = sell_qty * (fill_price - self.avg_cost)
                self.realized_pnl += realized
                self.qty -= sell_qty
                remaining = fill_qty - sell_qty
                if remaining > 1e-9:
                    # Excess becomes short
                    self.avg_cost = fill_price
                    self.qty = -remaining
                elif abs(self.qty) < 1e-9:
                    self.qty = 0.0
                    self.avg_cost = 0.0
                return realized
            else:
                # Adding to short / opening short
                total_cost = abs(self.qty) * self.avg_cost + fill_qty * fill_price
                self.qty -= fill_qty
                self.avg_cost = total_cost / abs(self.qty) if abs(self.qty) > 0 else 0.0
                return 0.0


# ── Portfolio book ────────────────────────────────────────────────────────────

class PortfolioEngine:
    """
    Central portfolio state: cash, positions, NAV, margin, leverage, exposure.

    All monetary values in INR (or whatever base currency is configured).
    """

    def __init__(
        self,
        starting_capital: float = 10_000_000.0,
        margin_rate: float = 0.20,          # SPAN margin as fraction of notional
        max_leverage: float = 5.0,
        max_concentration: float = 0.20,    # max single-position pct of NAV
    ):
        self.starting_capital = starting_capital
        self.margin_rate = margin_rate
        self.max_leverage = max_leverage
        self.max_concentration = max_concentration

        self.cash: float = starting_capital
        self._positions: Dict[str, Position] = {}  # symbol → Position
        self._prices: Dict[str, float] = {}        # latest prices

        # PnL history
        self.daily_pnl: List[float] = []
        self.equity_history: List[Tuple] = []      # (ts, nav)

    # ── Position management ───────────────────────────────────────────────────

    def get_position(self, symbol: str) -> Position:
        if symbol not in self._positions:
            self._positions[symbol] = Position(symbol=symbol)
        return self._positions[symbol]

    def apply_fill(
        self,
        symbol: str,
        fill_qty: float,
        fill_price: float,
        side: str,
        total_cost: float,
        strategy: str = "",
    ) -> float:
        """
        Apply an execution fill to the portfolio.
        Returns realized PnL from this fill.
        """
        pos = self.get_position(symbol)
        pos.strategy = strategy
        pos.last_price = fill_price
        self._prices[symbol] = fill_price

        realized = pos.apply_fill(fill_qty, fill_price, side)

        # Cash adjustment
        notional = fill_qty * fill_price
        if side == "buy":
            self.cash -= (notional + total_cost)
        else:
            self.cash += (notional - total_cost)

        return realized

    def update_prices(self, prices: Dict[str, float]) -> None:
        """Update mark prices for all symbols."""
        self._prices.update(prices)
        for sym, price in prices.items():
            if sym in self._positions:
                self._positions[sym].update_price(price)

    # ── NAV & Equity ──────────────────────────────────────────────────────────

    def calculate_nav(self) -> float:
        """Net Asset Value = cash + sum of position market values."""
        position_value = sum(
            pos.qty * self._prices.get(sym, pos.avg_cost)
            for sym, pos in self._positions.items()
        )
        return self.cash + position_value

    def calculate_gross_exposure(self) -> float:
        """Sum of |position notional| across all positions."""
        return sum(
            abs(pos.qty) * self._prices.get(sym, pos.avg_cost)
            for sym, pos in self._positions.items()
        )

    def calculate_net_exposure(self) -> float:
        """Sum of signed position notional."""
        return sum(
            pos.qty * self._prices.get(sym, pos.avg_cost)
            for sym, pos in self._positions.items()
        )

    def calculate_leverage(self) -> float:
        """Gross exposure / NAV."""
        nav = self.calculate_nav()
        if nav <= 0:
            return 0.0
        return self.calculate_gross_exposure() / nav

    def calculate_exposure(self) -> Dict[str, float]:
        """Per-symbol exposure as fraction of NAV."""
        nav = self.calculate_nav()
        if nav <= 0:
            return {}
        return {
            sym: pos.qty * self._prices.get(sym, pos.avg_cost) / nav
            for sym, pos in self._positions.items()
            if not pos.is_flat
        }

    # ── Margin ────────────────────────────────────────────────────────────────

    def calculate_margin_used(self) -> float:
        """SPAN margin = margin_rate * gross notional of F&O positions."""
        return self.calculate_gross_exposure() * self.margin_rate

    def calculate_buying_power(self) -> float:
        """
        Available cash minus margin requirement.
        For leveraged accounts: (cash + long_notional) / margin_rate - gross_notional
        """
        nav = self.calculate_nav()
        margin_used = self.calculate_margin_used()
        return max(0.0, nav - margin_used)

    def update_margin(self, symbol: str, price: float) -> Dict[str, float]:
        """Return margin status for a given symbol update."""
        pos = self.get_position(symbol)
        pos.update_price(price)
        return {
            "margin_used": self.calculate_margin_used(),
            "buying_power": self.calculate_buying_power(),
            "leverage": self.calculate_leverage(),
            "nav": self.calculate_nav(),
        }

    # ── Position sizing ───────────────────────────────────────────────────────

    def size_by_volatility(
        self, symbol: str, price: float, vol: float, risk_per_trade: float = 0.01
    ) -> float:
        """
        ATR / Volatility-based position sizing.
        risk_per_trade: fraction of NAV to risk per unit of vol.
        Returns target qty.
        """
        nav = self.calculate_nav()
        dollar_risk = nav * risk_per_trade
        dollar_vol = price * vol
        if dollar_vol <= 0:
            return 0.0
        return dollar_risk / dollar_vol

    def size_by_kelly(
        self, win_rate: float, avg_win: float, avg_loss: float, kelly_fraction: float = 0.25
    ) -> float:
        """
        Kelly criterion: f = (p*b - q) / b
        kelly_fraction: fractional Kelly (0.25 = quarter Kelly).
        Returns weight [0, 1] as fraction of NAV.
        """
        b = avg_win / max(avg_loss, 1e-9)
        p = win_rate
        q = 1.0 - p
        f = (p * b - q) / max(b, 1e-9)
        f = max(0.0, min(1.0, f))    # clamp [0,1]
        return f * kelly_fraction

    def size_by_equal_weight(self, n_assets: int) -> float:
        """1/N equal weight as fraction of NAV."""
        if n_assets <= 0:
            return 0.0
        return 1.0 / n_assets

    def size_by_risk_parity(
        self, vols: Dict[str, float]
    ) -> Dict[str, float]:
        """
        Risk-parity weights: w_i = (1/vol_i) / sum(1/vol_j)
        Returns dict of symbol → weight.
        """
        syms = list(vols.keys())
        inv_vols = np.array([1.0 / max(vols[s], 1e-9) for s in syms])
        weights = inv_vols / inv_vols.sum()
        return dict(zip(syms, weights.tolist()))

    # ── Rebalancing ───────────────────────────────────────────────────────────

    def rebalance_portfolio(
        self,
        target_weights: Dict[str, float],
        prices: Dict[str, float],
        threshold: float = 0.02,
    ) -> Dict[str, float]:
        """
        Compute rebalance trades needed to hit target weights.
        threshold: only trade if drift > threshold (avoids excessive turnover).
        Returns dict of symbol → trade_qty (positive=buy, negative=sell).
        """
        nav = self.calculate_nav()
        trades: Dict[str, float] = {}

        for sym, target_w in target_weights.items():
            price = prices.get(sym, self._prices.get(sym, 0.0))
            if price <= 0:
                continue
            target_notional = nav * target_w
            target_qty = target_notional / price

            current_qty = self._positions.get(sym, Position(sym)).qty
            current_notional = current_qty * price
            current_w = current_notional / max(nav, 1.0)

            drift = abs(target_w - current_w)
            if drift > threshold:
                delta_qty = target_qty - current_qty
                if abs(delta_qty) * price > 1_000:  # min 1k notional
                    trades[sym] = delta_qty

        return trades

    # ── Concentration check ───────────────────────────────────────────────────

    def check_concentration(self, symbol: str, proposed_notional: float) -> Tuple[bool, float]:
        """
        Check if adding proposed_notional to symbol would breach concentration limit.
        Returns (ok, current_concentration_pct).
        """
        nav = self.calculate_nav()
        if nav <= 0:
            return True, 0.0
        current_notional = abs(self.get_position(symbol).market_value())
        total_notional = current_notional + proposed_notional
        pct = total_notional / nav
        return pct <= self.max_concentration, pct

    # ── Snapshot ──────────────────────────────────────────────────────────────

    def snapshot(self) -> Dict:
        nav = self.calculate_nav()
        return {
            "cash": round(self.cash, 2),
            "nav": round(nav, 2),
            "gross_exposure": round(self.calculate_gross_exposure(), 2),
            "net_exposure": round(self.calculate_net_exposure(), 2),
            "leverage": round(self.calculate_leverage(), 3),
            "margin_used": round(self.calculate_margin_used(), 2),
            "buying_power": round(self.calculate_buying_power(), 2),
            "positions": {
                sym: {
                    "qty": pos.qty,
                    "avg_cost": round(pos.avg_cost, 4),
                    "last_price": round(pos.last_price, 4),
                    "unrealized_pnl": round(pos.unrealized_pnl, 2),
                    "realized_pnl": round(pos.realized_pnl, 2),
                    "notional": round(pos.notional, 2),
                }
                for sym, pos in self._positions.items()
                if not pos.is_flat
            },
        }

    def positions_df(self) -> pd.DataFrame:
        rows = []
        for sym, pos in self._positions.items():
            if pos.is_flat:
                continue
            rows.append({
                "symbol": sym,
                "qty": pos.qty,
                "avg_cost": pos.avg_cost,
                "last_price": pos.last_price,
                "unrealized_pnl": pos.unrealized_pnl,
                "realized_pnl": pos.realized_pnl,
                "notional": pos.notional,
                "strategy": pos.strategy,
            })
        return pd.DataFrame(rows)

    def reset(self) -> None:
        self.cash = self.starting_capital
        self._positions.clear()
        self._prices.clear()
        self.daily_pnl.clear()
        self.equity_history.clear()
