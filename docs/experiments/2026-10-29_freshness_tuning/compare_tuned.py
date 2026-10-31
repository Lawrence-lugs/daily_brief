"""Compare keyword vs tuned LR engine."""
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from simulate.core.pool import PoolProvider
from simulate.engines.keyword_engine import KeywordEngine
from simulate.engines.lr_engine import LREngine
from simulate.experiments.runner import compare_engines
from simulate.core.reporter import Reporter

# Best tuned parameters from sweep
TUNED_SAMPLING = {
    'epsilon': 0.8,
    'halfLifeDays': 30,
    'explore': {'gamma': 0.5},
}

def main():
    pool_provider = PoolProvider("daily_brief.db")
    
    # Base config
    with open("config.json") as f:
        base_config = json.load(f)
    
    config = {
        **base_config.get('ranker', {}),
        **base_config.get('selection', {}),
        **base_config.get('ranker', {}).get('sampling', {}),
        'date': '2026-10-29',
        'sampling': {**base_config.get('ranker', {}).get('sampling', {}), **TUNED_SAMPLING}
    }
    
    # Create engines
    keyword_engine = KeywordEngine(config)
    lr_engine = LREngine(project_root=Path.cwd())
    
    # Run comparison
    results = compare_engines(
        date="2026-10-29",
        seeds=list(range(1, 11)),
        engines=[keyword_engine, lr_engine],
        pool_provider=pool_provider,
        config=config,
        output_dir="../../../simulate/output/freshness",
    )
    
    # Generate custom HTML with tuned params in filename
    reporter = Reporter("../../../simulate/output/freshness")
    html = reporter.generate_comparison_html(results, "Engine Comparison - Tuned LR (epsilon=0.8, halfLife=30)")
    html_path = reporter.write_html(html, "comparison_tuned_lr_2026-10-29_10seeds.html")
    print(f"HTML report saved to {html_path}")
    
    # Print summary
    print("\n=== FRESHNESS SUMMARY ===")
    for desk in ['primary', 'science']:
        print(f"\n{desk.upper()} DESK:")
        for engine_name in ['keyword', 'lr']:
            fresh = results['aggregate'][desk][engine_name].get('freshness', {})
            if fresh:
                print(f"  {engine_name}: mean={fresh['mean']:.2f}, median={fresh['median']:.2f}")

if __name__ == "__main__":
    main()