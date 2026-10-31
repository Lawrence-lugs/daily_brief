# Experiment Archives

This directory contains one-off analysis scripts and their results, organized by date and topic.

## Structure

```
docs/experiments/
├── YYYY-MM-DD_topic/
│   ├── analyze_*.py          # Analysis scripts
│   ├── compare_*.py          # Comparison scripts
│   ├── sweep_*.py            # Parameter sweep scripts
│   ├── *.json                # Raw results
│   ├── *.html                # Generated reports
│   └── README.md             # Experiment notes
```

## Experiments

| Date | Topic | Description |
|------|-------|-------------|
| 2026-10-29 | freshness_tuning | LR engine freshness parameter sweeps to match keyword age distribution |
| 2026-10-30 | exploration_analysis | (placeholder for future experiments) |

## Usage

These scripts are **archived** and not maintained. They reference the simulation framework at `../../../simulate/` and output to `../../../simulate/output/`.

To run an archived experiment:
```bash
cd docs/experiments/2026-10-29_freshness_tuning
python sweep_freshness.py
```

## Results Location

All experiment outputs are written to `simulate/output/` (or subdirectories like `simulate/output/freshness/`), which is the single canonical output directory for the simulation framework.