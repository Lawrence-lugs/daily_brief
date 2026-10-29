"""Abstract Engine interface for simulation framework."""
from __future__ import annotations
from abc import ABC, abstractmethod
from typing import List, Dict, Any


class Engine(ABC):
    """Abstract base class for selection engines.
    
    All engines must implement select() which takes a pool of candidates,
    configuration, and a seed, and returns selections for each desk.
    """
    
    @abstractmethod
    def select(self, pool: List[Dict], config: Dict, seed: int) -> Dict[str, List[Dict]]:
        """Select items for each desk.
        
        Args:
            pool: List of candidate items (dicts with id, rel, age_days, subtopic, 
                  source_type, times_shown, rejected, etc.)
            config: Configuration dictionary
            seed: Random seed for reproducibility
            
        Returns:
            Dict mapping desk name to list of selected items.
            Each item should have at least: id, mode (greedy/explore/reserve)
        """
        pass
    
    @property
    @abstractmethod
    def name(self) -> str:
        """Short name for this engine (e.g., 'keyword', 'lr')."""
        pass
    
    @property
    def description(self) -> str:
        """Human-readable description."""
        return self.__class__.__doc__ or self.name


class SelectionResult:
    """Container for a single engine run result."""
    
    def __init__(self, engine_name: str, seed: int, selections: Dict[str, List[Dict]], 
                 pool_size: int, config: Dict):
        self.engine_name = engine_name
        self.seed = seed
        self.selections = selections  # desk -> [items]
        self.pool_size = pool_size
        self.config = config
    
    def all_picked_ids(self) -> set:
        """Get all picked item IDs across all desks."""
        picked = set()
        for desk_items in self.selections.values():
            for item in desk_items:
                picked.add(item.get("id"))
        return picked
    
    def desk_picked_ids(self, desk: str) -> set:
        """Get picked item IDs for a specific desk."""
        return {item.get("id") for item in self.selections.get(desk, [])}
    
    def to_dict(self) -> Dict:
        return {
            "engine": self.engine_name,
            "seed": self.seed,
            "selections": {
                desk: [{"id": i.get("id"), "mode": i.get("mode")} for i in items]
                for desk, items in self.selections.items()
            },
            "pool_size": self.pool_size,
        }