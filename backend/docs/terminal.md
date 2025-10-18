# 🖥 Hedge Fund Terminal — User Guide

The Hedge Fund Terminal is a unified interface for **strategy research, backtesting, execution, and reporting**.  
This document explains how the **terminal** is organized and how to use it effectively.

---

## 🔹 Overview

The terminal consists of:

- **CLI** (`cli.mjs` + `backtester/commands/*`)  
  Interactive command-line interface for running strategies, health checks, generating reports.
- **UI Templates** (`templates/index.html`, `templates/run.html`)  
  Web-based interface for visualizing runs, performance curves, and reports.
- **Data + Storage**  
  Structured folders (`runs/`, `curves/`, `summaries/`, `plots/`) hold results, curves, and summaries.

---

## 🔹 CLI Commands

The CLI is the entry point for most workflows.

### Core Commands

- `hf-terminal run <strategy>`  
  Run a single strategy backtest, save results under `runs/`.
- `hf-terminal run-all`  
  Execute all strategies in `strategies/manifest.json`.
- `hf-terminal health`  
  Check system health (config, storage, broker connectivity).
- `hf-terminal config`  
  Inspect or override configuration values.
- `hf-terminal reports`  
  Generate reports in CSV, HTML, or Markdown formats.
- `hf-terminal strategies`  
  List available strategies and metadata.

### Example

```bash
# Run Momentum strategy
node cli.mjs run Momentum

# Run all registered strategies
node cli.mjs run-all

# Check platform health
node cli.mjs health
