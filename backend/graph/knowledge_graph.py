# backend/graph/knowledge_graph.py
"""
In-memory directed knowledge graph with typed nodes and edges.

Features
--------
- add_node / add_edge with upsert semantics (key-based dedup for nodes)
- get_node / get_edge with property round-trip
- neighbors() with type filters and direction (in / out / both)
- shortest_path() (BFS over directed edges)
- centrality() degree-based
- subgraph_by_time() edge timestamp filtering
- delete_node() with cascade
- export_json() / import_json()
- find() / query_nodes() index lookup
- clear()
"""
from __future__ import annotations

import json
import uuid
from collections import defaultdict, deque
from copy import deepcopy
from typing import Any, Dict, List, Optional, Set, Tuple


class KnowledgeGraph:

    def __init__(self):
        self._nodes: Dict[str, Dict] = {}          # node_id → {id, label, key, props}
        self._edges: Dict[str, Dict] = {}          # edge_id → {id, src, dst, etype, props}
        self._node_key_index: Dict[Tuple, str] = {}  # (label, key) → node_id
        self._adj_out: Dict[str, List[str]] = defaultdict(list)   # src → [edge_id]
        self._adj_in: Dict[str, List[str]] = defaultdict(list)    # dst → [edge_id]

    # ------------------------------------------------------------------
    # Nodes
    # ------------------------------------------------------------------

    def add_node(self, label: str, key: str = "", props: Optional[Dict] = None) -> str:
        idx = (label, key)
        if key and idx in self._node_key_index:
            nid = self._node_key_index[idx]
            if props:
                self._nodes[nid]["props"].update(props)
            return nid

        nid = str(uuid.uuid4())
        node = {"id": nid, "label": label, "key": key, "props": dict(props or {})}
        self._nodes[nid] = node
        if key:
            self._node_key_index[idx] = nid
        return nid

    def get_node(self, node_id: str) -> Optional[Dict]:
        return deepcopy(self._nodes.get(node_id))

    def delete_node(self, node_id: str) -> None:
        if node_id not in self._nodes:
            return
        node = self._nodes.pop(node_id)
        idx = (node["label"], node.get("key", ""))
        self._node_key_index.pop(idx, None)

        # Cascade: remove all incident edges
        edges_to_remove = list(self._adj_out.get(node_id, [])) + list(self._adj_in.get(node_id, []))
        for eid in edges_to_remove:
            self._remove_edge(eid)

        self._adj_out.pop(node_id, None)
        self._adj_in.pop(node_id, None)

    # ------------------------------------------------------------------
    # Edges
    # ------------------------------------------------------------------

    def add_edge(self, src: str, dst: str, etype: str, props: Optional[Dict] = None) -> str:
        props = dict(props or {})
        eid = str(uuid.uuid4())
        edge = {"id": eid, "src": src, "dst": dst, "etype": etype, "props": props}
        self._edges[eid] = edge
        self._adj_out[src].append(eid)
        self._adj_in[dst].append(eid)
        return eid

    def get_edge(self, edge_id: str) -> Optional[Dict]:
        return deepcopy(self._edges.get(edge_id))

    def _remove_edge(self, eid: str) -> None:
        edge = self._edges.pop(eid, None)
        if not edge:
            return
        self._adj_out.get(edge["src"], [])
        try:
            self._adj_out[edge["src"]].remove(eid)
        except ValueError:
            pass
        try:
            self._adj_in[edge["dst"]].remove(eid)
        except ValueError:
            pass

    # ------------------------------------------------------------------
    # Traversal
    # ------------------------------------------------------------------

    def neighbors(
        self,
        node: str,
        direction: str = "out",
        etypes: Optional[List[str]] = None,
    ) -> List[Dict]:
        etypes_set: Optional[Set[str]] = set(etypes) if etypes else None
        result = []

        if direction in ("out", "both"):
            for eid in list(self._adj_out.get(node, [])):
                edge = self._edges.get(eid)
                if not edge:
                    continue
                if etypes_set and edge["etype"] not in etypes_set:
                    continue
                nbr = self._nodes.get(edge["dst"])
                if nbr:
                    result.append(deepcopy(nbr))

        if direction in ("in", "both"):
            for eid in list(self._adj_in.get(node, [])):
                edge = self._edges.get(eid)
                if not edge:
                    continue
                if etypes_set and edge["etype"] not in etypes_set:
                    continue
                nbr = self._nodes.get(edge["src"])
                if nbr:
                    result.append(deepcopy(nbr))

        return result

    def shortest_path(
        self,
        src: str,
        dst: str,
        weighted: bool = False,
    ) -> List[str]:
        """BFS shortest path — returns list of node IDs from src to dst."""
        if src == dst:
            return [src]

        visited: Set[str] = {src}
        queue: deque = deque([[src]])

        while queue:
            path = queue.popleft()
            node = path[-1]
            for eid in list(self._adj_out.get(node, [])):
                edge = self._edges.get(eid)
                if not edge:
                    continue
                nxt = edge["dst"]
                if nxt == dst:
                    return path + [nxt]
                if nxt not in visited:
                    visited.add(nxt)
                    queue.append(path + [nxt])

        return []  # no path

    def centrality(self, kind: str = "degree") -> Dict[str, float]:
        """Degree centrality (in + out degree)."""
        result: Dict[str, float] = {}
        for nid in self._nodes:
            out_deg = len(self._adj_out.get(nid, []))
            in_deg = len(self._adj_in.get(nid, []))
            result[nid] = float(out_deg + in_deg)
        return result

    # ------------------------------------------------------------------
    # Time filtering
    # ------------------------------------------------------------------

    def subgraph_by_time(self, start: int, end: int) -> Dict:
        """Return nodes and edges whose props.ts falls in [start, end]."""
        edges_in = []
        node_ids: Set[str] = set()

        for eid, edge in self._edges.items():
            ts = edge["props"].get("ts", 0)
            if start <= ts <= end:
                edges_in.append(deepcopy(edge))
                node_ids.add(edge["src"])
                node_ids.add(edge["dst"])

        nodes_in = [deepcopy(self._nodes[nid]) for nid in node_ids if nid in self._nodes]
        return {"nodes": nodes_in, "edges": edges_in}

    def window(self, start: int, end: int) -> Dict:
        return self.subgraph_by_time(start=start, end=end)

    # ------------------------------------------------------------------
    # Query / index
    # ------------------------------------------------------------------

    def find(self, label: str, key: str) -> Optional[str]:
        return self._node_key_index.get((label, key))

    def query_nodes(self, label: Optional[str] = None, where: Optional[Dict] = None) -> List[Dict]:
        results = []
        for node in self._nodes.values():
            if label and node["label"] != label:
                continue
            if where:
                match = all(
                    (node.get(k) == v or node["props"].get(k) == v)
                    for k, v in where.items()
                )
                if not match:
                    continue
            results.append(deepcopy(node))
        return results

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def export_json(self) -> Dict:
        return {
            "nodes": list(self._nodes.values()),
            "edges": list(self._edges.values()),
        }

    def import_json(self, json_blob: Any = None, **kw) -> None:
        blob = json_blob or kw.get("blob")
        if isinstance(blob, str):
            blob = json.loads(blob)
        self.clear()
        for node in blob.get("nodes", []):
            nid = node["id"]
            self._nodes[nid] = dict(node)
            key = node.get("key", "")
            label = node.get("label", "")
            if key:
                self._node_key_index[(label, key)] = nid
        for edge in blob.get("edges", []):
            eid = edge["id"]
            self._edges[eid] = dict(edge)
            self._adj_out[edge["src"]].append(eid)
            self._adj_in[edge["dst"]].append(eid)

    def clear(self) -> None:
        self._nodes.clear()
        self._edges.clear()
        self._node_key_index.clear()
        self._adj_out.clear()
        self._adj_in.clear()
