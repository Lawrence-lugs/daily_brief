"""Simulation framework for comparing selection engines."""
from simulate.core.engine import Engine, SelectionResult
from simulate.core.pool import PoolProvider
from simulate.core.metrics import MetricsCollector
from simulate.core.reporter import Reporter
from simulate.core.config import load_config, merge_config, freshness_config_summary
from simulate.engines.keyword_engine import KeywordEngine
from simulate.engines.lr_engine import LREngine
from simulate.experiments.runner import (
    compare_engines,
    monte_carlo,
    parameter_sweep,
    ablation_study,
    DEFAULT_OUTPUT_DIR,
)

__all__ = [
    "Engine",
    "SelectionResult",
    "PoolProvider",
    "MetricsCollector",
    "Reporter",
    "load_config",
    "merge_config",
    "freshness_config_summary",
    "KeywordEngine",
    "LREngine",
    "compare_engines",
    "monte_carlo",
    "parameter_sweep",
    "ablation_study",
    "DEFAULT_OUTPUT_DIR",
]

__version__ = "0.1.0"