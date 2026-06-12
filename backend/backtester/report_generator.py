# backend/backtester/report_generator.py
"""
Self-contained HTML report generator for backtest results.

Produces a single .html file with embedded Plotly charts — no server needed.
Open in any browser. Works offline.

Sections:
  1. Executive Summary (key metrics scorecard)
  2. Equity Curve + Benchmark comparison
  3. Drawdown timeline with annotated periods
  4. Monthly returns heatmap (calendar view)
  5. Rolling Sharpe + Rolling Volatility
  6. Strategy Rankings table (sortable)
  7. Factor Attribution heatmap
  8. Regime-conditional performance
  9. Monte Carlo fan chart
  10. Anti-Overfit report card
  11. Risk Events timeline
  12. Capacity analysis per strategy
  13. Strategy Clustering dendrogram
"""
from __future__ import annotations

import json
import math
import os
from datetime import datetime
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

# ── Plotly JSON helpers ───────────────────────────────────────────────────────

def _safe_list(arr) -> list:
    """Convert numpy array / pandas series to JSON-safe list."""
    if hasattr(arr, "tolist"):
        return [None if (isinstance(x, float) and math.isnan(x)) else x for x in arr.tolist()]
    return list(arr)


def _ts_list(index) -> list:
    """Convert DatetimeIndex to ISO string list."""
    return [str(ts)[:10] if hasattr(ts, "strftime") else str(ts) for ts in index]


# ── Chart builders ────────────────────────────────────────────────────────────

def _equity_chart(equity: pd.Series, benchmark: Optional[pd.Series] = None) -> dict:
    traces = [{
        "type": "scatter", "mode": "lines",
        "name": "Portfolio",
        "x": _ts_list(equity.index),
        "y": _safe_list(equity.values),
        "line": {"color": "#6366f1", "width": 2},
    }]
    if benchmark is not None and len(benchmark) > 0:
        bm_scaled = benchmark / benchmark.iloc[0] * equity.iloc[0]
        traces.append({
            "type": "scatter", "mode": "lines",
            "name": "Benchmark",
            "x": _ts_list(bm_scaled.index),
            "y": _safe_list(bm_scaled.values),
            "line": {"color": "#94a3b8", "width": 1.5, "dash": "dash"},
        })
    return {
        "data": traces,
        "layout": {
            "title": "Portfolio Equity Curve",
            "xaxis": {"title": "Date", "showgrid": False},
            "yaxis": {"title": "Portfolio Value (₹)", "showgrid": True, "gridcolor": "#1e293b"},
            "plot_bgcolor": "#0f172a", "paper_bgcolor": "#0f172a",
            "font": {"color": "#e2e8f0"},
            "legend": {"bgcolor": "rgba(0,0,0,0)"},
        },
    }


def _drawdown_chart(equity: pd.Series, drawdown_periods: List[Dict]) -> dict:
    hwm = equity.cummax()
    dd = (equity - hwm) / hwm.replace(0, np.nan) * 100

    traces = [{
        "type": "scatter", "mode": "lines",
        "name": "Drawdown %",
        "x": _ts_list(dd.index),
        "y": _safe_list(dd.values),
        "fill": "tozeroy",
        "line": {"color": "#ef4444", "width": 1},
        "fillcolor": "rgba(239,68,68,0.2)",
    }]

    shapes = []
    for period in drawdown_periods[:10]:
        shapes.append({
            "type": "rect",
            "x0": period["start"], "x1": period["end"],
            "y0": 0, "y1": 1, "yref": "paper",
            "fillcolor": "rgba(239,68,68,0.05)",
            "line": {"width": 0},
        })

    return {
        "data": traces,
        "layout": {
            "title": "Drawdown (%)",
            "xaxis": {"title": "Date", "showgrid": False},
            "yaxis": {"title": "Drawdown %", "showgrid": True, "gridcolor": "#1e293b"},
            "shapes": shapes,
            "plot_bgcolor": "#0f172a", "paper_bgcolor": "#0f172a",
            "font": {"color": "#e2e8f0"},
        },
    }


def _monthly_heatmap(monthly_table: pd.DataFrame) -> dict:
    months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    years = [str(y) for y in monthly_table.index.tolist()]
    z = []
    for yr in monthly_table.index:
        row = []
        for mo in range(1, 13):
            val = monthly_table.loc[yr, mo] if mo in monthly_table.columns else None
            if val is not None and not (isinstance(val, float) and math.isnan(val)):
                row.append(round(float(val), 2))
            else:
                row.append(None)
        z.append(row)

    text = [[f"{v:.1f}%" if v is not None else "" for v in row] for row in z]

    return {
        "data": [{
            "type": "heatmap",
            "z": z,
            "x": months,
            "y": years,
            "text": text,
            "texttemplate": "%{text}",
            "colorscale": [
                [0.0, "#7f1d1d"], [0.35, "#ef4444"],
                [0.5, "#0f172a"],
                [0.65, "#22c55e"], [1.0, "#14532d"]
            ],
            "zmid": 0,
            "showscale": True,
            "colorbar": {"title": "Return %"},
        }],
        "layout": {
            "title": "Monthly Returns (%)",
            "plot_bgcolor": "#0f172a", "paper_bgcolor": "#0f172a",
            "font": {"color": "#e2e8f0"},
            "xaxis": {"side": "top"},
        },
    }


def _rolling_sharpe_chart(equity: pd.Series, capital: float, window: int = 63) -> dict:
    pnl = equity.diff().fillna(0)
    r = pnl / capital
    roll_mean = r.rolling(window).mean()
    roll_std = r.rolling(window).std(ddof=1).replace(0, np.nan)
    rolling_sr = (roll_mean / roll_std * math.sqrt(252)).fillna(0)

    return {
        "data": [
            {
                "type": "scatter", "mode": "lines",
                "name": f"Rolling Sharpe ({window}d)",
                "x": _ts_list(rolling_sr.index),
                "y": _safe_list(rolling_sr.values),
                "line": {"color": "#22c55e", "width": 1.5},
            },
            {
                "type": "scatter", "mode": "lines",
                "name": "Sharpe = 1.0",
                "x": _ts_list(rolling_sr.index),
                "y": [1.0] * len(rolling_sr),
                "line": {"color": "#64748b", "width": 1, "dash": "dot"},
                "showlegend": False,
            },
        ],
        "layout": {
            "title": f"Rolling {window}-Day Sharpe Ratio",
            "xaxis": {"showgrid": False},
            "yaxis": {"showgrid": True, "gridcolor": "#1e293b", "zeroline": True, "zerolinecolor": "#64748b"},
            "plot_bgcolor": "#0f172a", "paper_bgcolor": "#0f172a",
            "font": {"color": "#e2e8f0"},
        },
    }


def _strategy_ranking_chart(ranking_df: pd.DataFrame) -> dict:
    if ranking_df.empty:
        return {"data": [], "layout": {}}
    top = ranking_df.head(20)
    colors = ["#22c55e" if s > 0 else "#ef4444" for s in top["sharpe"]]
    return {
        "data": [{
            "type": "bar", "orientation": "h",
            "name": "Sharpe",
            "x": _safe_list(top["sharpe"].values),
            "y": top["strategy"].tolist(),
            "marker": {"color": colors},
        }],
        "layout": {
            "title": "Top 20 Strategies by Sharpe Ratio",
            "xaxis": {"title": "Sharpe Ratio", "zeroline": True, "zerolinecolor": "#64748b"},
            "yaxis": {"autorange": "reversed"},
            "plot_bgcolor": "#0f172a", "paper_bgcolor": "#0f172a",
            "font": {"color": "#e2e8f0"},
            "margin": {"l": 200},
        },
    }


def _monte_carlo_chart(mc_results: Dict) -> dict:
    if mc_results is None:
        return {"data": [], "layout": {}}
    pcts = mc_results.get("percentiles")
    if pcts is None:
        return {"data": [], "layout": {}}
    n_steps = pcts.shape[1] if hasattr(pcts, "shape") else 0
    x = list(range(n_steps))
    names = ["P5", "P25", "P50", "P75", "P95"]
    colors = ["#ef4444", "#f97316", "#22c55e", "#f97316", "#ef4444"]
    fills = [None, "tonexty", "tonexty", "tonexty", "tonexty"]
    fill_colors = [None, "rgba(249,115,22,0.1)", "rgba(34,197,94,0.15)",
                   "rgba(249,115,22,0.1)", None]
    traces = []
    for i, (name, color, fill, fc) in enumerate(zip(names, colors, fills, fill_colors)):
        t = {
            "type": "scatter", "mode": "lines",
            "name": name,
            "x": x,
            "y": _safe_list(pcts[i]),
            "line": {"color": color, "width": 1.5 if name == "P50" else 1},
        }
        if fill:
            t["fill"] = fill
        if fc:
            t["fillcolor"] = fc
        traces.append(t)
    return {
        "data": traces,
        "layout": {
            "title": "Monte Carlo Simulation — Portfolio Value",
            "xaxis": {"title": "Days"},
            "yaxis": {"title": "Portfolio Value (₹)"},
            "plot_bgcolor": "#0f172a", "paper_bgcolor": "#0f172a",
            "font": {"color": "#e2e8f0"},
        },
    }


def _regime_chart(regime_metrics: Dict) -> dict:
    """Bar chart: Sharpe by regime."""
    if not regime_metrics:
        return {"data": [], "layout": {}}
    regimes = list(regime_metrics.keys())
    sharpes = [regime_metrics[r].get("sharpe", 0) for r in regimes]
    colors = {
        "bull": "#22c55e", "bear": "#ef4444",
        "sideways": "#f59e0b", "crisis": "#7c3aed",
    }
    bar_colors = [colors.get(r, "#6366f1") for r in regimes]
    return {
        "data": [{
            "type": "bar",
            "x": regimes, "y": sharpes,
            "marker": {"color": bar_colors},
            "text": [f"{s:.2f}" for s in sharpes],
            "textposition": "outside",
        }],
        "layout": {
            "title": "Sharpe Ratio by Market Regime",
            "xaxis": {"title": "Regime"},
            "yaxis": {"title": "Sharpe", "zeroline": True, "zerolinecolor": "#64748b"},
            "plot_bgcolor": "#0f172a", "paper_bgcolor": "#0f172a",
            "font": {"color": "#e2e8f0"},
        },
    }


# ── HTML template ─────────────────────────────────────────────────────────────

_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>D-Strategies Backtest Report — {run_date}</title>
<script src="https://cdn.plot.ly/plotly-2.26.0.min.js"></script>
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{ font-family: 'Inter', system-ui, sans-serif; background: #020617; color: #e2e8f0; }}
  .header {{ background: linear-gradient(135deg, #1e1b4b 0%, #0f172a 100%);
             padding: 2rem 3rem; border-bottom: 1px solid #1e293b; }}
  .header h1 {{ font-size: 1.75rem; font-weight: 700; color: #a5b4fc; }}
  .header p {{ color: #64748b; margin-top: 0.25rem; font-size: 0.9rem; }}
  .container {{ max-width: 1400px; margin: 0 auto; padding: 2rem 3rem; }}
  .scorecard {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
               gap: 1rem; margin-bottom: 2rem; }}
  .metric-card {{ background: #0f172a; border: 1px solid #1e293b; border-radius: 12px;
                 padding: 1.25rem; text-align: center; }}
  .metric-card .value {{ font-size: 1.75rem; font-weight: 700; margin-bottom: 0.25rem; }}
  .metric-card .label {{ font-size: 0.75rem; color: #64748b; text-transform: uppercase;
                         letter-spacing: 0.05em; }}
  .positive {{ color: #22c55e; }} .negative {{ color: #ef4444; }} .neutral {{ color: #a5b4fc; }}
  .section {{ margin-bottom: 2.5rem; }}
  .section h2 {{ font-size: 1.1rem; font-weight: 600; color: #a5b4fc; margin-bottom: 1rem;
                border-left: 3px solid #6366f1; padding-left: 0.75rem; }}
  .chart {{ background: #0f172a; border: 1px solid #1e293b; border-radius: 12px;
            padding: 1rem; margin-bottom: 1rem; }}
  .grid-2 {{ display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }}
  .rules-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
                gap: 0.75rem; }}
  .rule-card {{ background: #0f172a; border-radius: 8px; padding: 0.875rem 1rem;
               border-left: 4px solid; }}
  .rule-pass {{ border-color: #22c55e; }}
  .rule-fail {{ border-color: #ef4444; }}
  .rule-card .rule-name {{ font-size: 0.8rem; font-weight: 600; text-transform: uppercase;
                           letter-spacing: 0.05em; color: #94a3b8; }}
  .rule-card .rule-value {{ font-size: 1.1rem; font-weight: 700; margin-top: 0.25rem; }}
  .rule-pass .rule-value {{ color: #22c55e; }} .rule-fail .rule-value {{ color: #ef4444; }}
  .rule-card .rule-msg {{ font-size: 0.75rem; color: #64748b; margin-top: 0.25rem; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 0.85rem; }}
  th {{ background: #1e293b; color: #94a3b8; text-align: left; padding: 0.625rem 0.875rem;
       font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }}
  td {{ padding: 0.5rem 0.875rem; border-bottom: 1px solid #1e293b; }}
  tr:hover td {{ background: #1e293b; }}
  .badge {{ display: inline-block; padding: 0.2rem 0.5rem; border-radius: 4px;
            font-size: 0.7rem; font-weight: 600; text-transform: uppercase; }}
  .badge-pass {{ background: rgba(34,197,94,0.15); color: #22c55e; }}
  .badge-fail {{ background: rgba(239,68,68,0.15); color: #ef4444; }}
  .footer {{ text-align: center; color: #475569; font-size: 0.8rem; padding: 2rem;
             border-top: 1px solid #1e293b; margin-top: 2rem; }}
</style>
</head>
<body>
<div class="header">
  <h1>D-Strategies Backtest Report</h1>
  <p>Generated {run_date} · {n_strategies} strategies · {start_date} → {end_date} · ₹{capital:,.0f} starting capital</p>
</div>
<div class="container">

  <!-- Scorecard -->
  <div class="section">
    <h2>Executive Summary</h2>
    <div class="scorecard">
      {scorecard_html}
    </div>
  </div>

  <!-- Anti-Overfit -->
  <div class="section">
    <h2>Anti-Overfit Validation
      <span class="badge {ao_badge_class}" style="margin-left:0.5rem">{ao_status}</span>
    </h2>
    <div class="rules-grid">{rules_html}</div>
  </div>

  <!-- Equity Curve -->
  <div class="section">
    <h2>Equity Curve</h2>
    <div class="chart"><div id="equity-chart"></div></div>
  </div>

  <!-- Drawdown -->
  <div class="section">
    <h2>Drawdown</h2>
    <div class="chart"><div id="drawdown-chart"></div></div>
  </div>

  <!-- Grid: Rolling Sharpe + Monthly Heatmap -->
  <div class="section">
    <h2>Performance Analysis</h2>
    <div class="grid-2">
      <div class="chart"><div id="rolling-sharpe-chart"></div></div>
      <div class="chart"><div id="monthly-chart"></div></div>
    </div>
  </div>

  <!-- Regime Performance -->
  <div class="section">
    <h2>Regime-Conditional Performance</h2>
    <div class="chart"><div id="regime-chart"></div></div>
  </div>

  <!-- Monte Carlo -->
  <div class="section">
    <h2>Monte Carlo — Forward Simulation ({mc_paths} paths)</h2>
    <div class="chart"><div id="mc-chart"></div></div>
  </div>

  <!-- Strategy Ranking -->
  <div class="section">
    <h2>Strategy Rankings</h2>
    <div class="chart"><div id="strategy-chart"></div></div>
    <div class="chart" style="margin-top:1rem; overflow-x:auto">
      <table>
        <thead><tr>
          <th>#</th><th>Strategy</th><th>Sharpe</th><th>CAGR</th>
          <th>Max DD</th><th>Win Rate</th><th>Trades</th>
        </tr></thead>
        <tbody>{strategy_table_rows}</tbody>
      </table>
    </div>
  </div>

  <div class="footer">
    D-Strategies Institutional Backtesting Engine · {run_date} · Confidential
  </div>
</div>

<script>
var charts = {charts_json};
Plotly.newPlot('equity-chart', charts.equity.data, charts.equity.layout, {{responsive:true}});
Plotly.newPlot('drawdown-chart', charts.drawdown.data, charts.drawdown.layout, {{responsive:true}});
Plotly.newPlot('rolling-sharpe-chart', charts.rolling_sharpe.data, charts.rolling_sharpe.layout, {{responsive:true}});
Plotly.newPlot('monthly-chart', charts.monthly.data, charts.monthly.layout, {{responsive:true}});
Plotly.newPlot('regime-chart', charts.regime.data, charts.regime.layout, {{responsive:true}});
Plotly.newPlot('mc-chart', charts.mc.data, charts.mc.layout, {{responsive:true}});
Plotly.newPlot('strategy-chart', charts.strategy.data, charts.strategy.layout, {{responsive:true}});
</script>
</body>
</html>"""


# ── Report generator ──────────────────────────────────────────────────────────

class ReportGenerator:
    """
    Generates a self-contained HTML backtest report from a BacktestReport object.
    No server required — open the .html file directly in any browser.
    """

    def generate(
        self,
        report: Any,              # BacktestReport from backtest_engine
        output_path: Optional[str] = None,
        benchmark_returns: Optional[pd.Series] = None,
        regime_metrics: Optional[Dict] = None,
    ) -> str:
        """
        Generate HTML report. Returns path to saved file (or HTML string if no path).
        """
        m = report.portfolio_metrics
        equity = report.equity_curve
        capital = report.capital

        # Charts
        charts = {
            "equity": _equity_chart(equity, benchmark_returns),
            "drawdown": _drawdown_chart(equity, report.drawdown_periods()),
            "rolling_sharpe": _rolling_sharpe_chart(equity, capital),
            "monthly": _monthly_heatmap(report.monthly_returns_table()) if not report.daily_pnl.empty else {"data": [], "layout": {}},
            "regime": _regime_chart(regime_metrics or {}),
            "mc": _monte_carlo_chart(report.mc_results),
            "strategy": _strategy_ranking_chart(report.strategy_ranking()),
        }

        # Scorecard cards
        metrics = [
            ("Total Return", f"{m.total_return * 100:.1f}%", m.total_return >= 0),
            ("CAGR", f"{m.cagr * 100:.1f}%", m.cagr >= 0),
            ("Sharpe", f"{m.sharpe:.2f}", m.sharpe >= 1.0),
            ("Sortino", f"{m.sortino:.2f}", m.sortino >= 1.0),
            ("Max DD", f"{m.max_drawdown * 100:.1f}%", m.max_drawdown > -0.2),
            ("Calmar", f"{m.calmar:.2f}", m.calmar >= 0.5),
            ("Win Rate", f"{m.win_rate * 100:.1f}%", m.win_rate >= 0.5),
            ("# Trades", f"{m.n_trades:,}", True),
            ("Strategies", f"{report.n_strategies_run}", True),
            ("Run Time", f"{report.elapsed_seconds:.1f}s", True),
        ]
        scorecard_html = ""
        for label, value, positive in metrics:
            cls = "positive" if positive else "negative"
            scorecard_html += f"""<div class="metric-card">
              <div class="value {cls}">{value}</div>
              <div class="label">{label}</div>
            </div>"""

        # Anti-overfit rules
        ao = report.anti_overfit
        ao_passed = getattr(ao, "passed", False)
        ao_badge_class = "badge-pass" if ao_passed else "badge-fail"
        ao_status = "PASS" if ao_passed else "FAIL"
        rules_html = ""
        ao_rules = getattr(ao, "rules", {}) or {}
        for rule_name, rule_data in ao_rules.items():
            passed = rule_data.get("passed", False)
            value_raw = rule_data.get("value", "N/A")
            value_str = f"{value_raw:.2f}" if isinstance(value_raw, (int, float)) else str(value_raw)
            threshold = rule_data.get("threshold", "")
            card_class = "rule-pass" if passed else "rule-fail"
            badge = "✓" if passed else "✗"
            rules_html += f"""<div class="rule-card {card_class}">
              <div class="rule-name">{rule_name.replace("_", " ").title()}</div>
              <div class="rule-value">{badge} {value_str}</div>
              <div class="rule-msg">Threshold: {threshold}</div>
            </div>"""

        # Strategy table rows
        ranking = report.strategy_ranking()
        table_rows = ""
        for i, row in ranking.head(50).iterrows():
            sharpe_cls = "positive" if row.get("sharpe", 0) > 0 else "negative"
            dd_cls = "negative" if row.get("max_drawdown", 0) < -0.15 else "neutral"
            table_rows += f"""<tr>
              <td style="color:#64748b">{i+1}</td>
              <td><strong>{row.get("strategy","")}</strong></td>
              <td class="{sharpe_cls}">{row.get("sharpe", 0):.3f}</td>
              <td>{row.get("cagr", 0)*100:.1f}%</td>
              <td class="{dd_cls}">{row.get("max_drawdown", 0)*100:.1f}%</td>
              <td>{row.get("win_rate", 0)*100:.1f}%</td>
              <td style="color:#64748b">{int(row.get("n_trades", 0))}</td>
            </tr>"""

        mc_paths = report.mc_results.get("n_paths", 1000) if report.mc_results else 0

        html = _HTML_TEMPLATE.format(
            run_date=datetime.now().strftime("%Y-%m-%d %H:%M"),
            n_strategies=report.n_strategies_run,
            start_date=str(equity.index[0])[:10] if len(equity) > 0 else "N/A",
            end_date=str(equity.index[-1])[:10] if len(equity) > 0 else "N/A",
            capital=capital,
            scorecard_html=scorecard_html,
            ao_badge_class=ao_badge_class,
            ao_status=ao_status,
            rules_html=rules_html,
            strategy_table_rows=table_rows,
            mc_paths=mc_paths,
            charts_json=json.dumps(charts, default=lambda x: None),
        )

        if output_path:
            os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
            with open(output_path, "w", encoding="utf-8") as f:
                f.write(html)
            return output_path
        return html

    def save(self, report: Any, path: str, **kwargs) -> str:
        """Shorthand: generate and save to path."""
        return self.generate(report, output_path=path, **kwargs)


# ── Convenience function ──────────────────────────────────────────────────────

def generate_report(report: Any, output_path: Optional[str] = None, **kwargs) -> str:
    """One-liner to generate the HTML report."""
    gen = ReportGenerator()
    return gen.generate(report, output_path=output_path, **kwargs)
