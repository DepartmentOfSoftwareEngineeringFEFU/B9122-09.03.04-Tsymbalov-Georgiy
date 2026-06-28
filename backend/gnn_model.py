"""
Power Grid Accident Prediction Engine
======================================
Architecture (3 layers):

Layer 1 – Expert Rules (deterministic, physical):
    - Node base risk:  driven by wear, seismicity, temperature deviation
    - Edge base risk:  driven by wind vs critical_wind, ice+wind synergy,
                       storm, forestry, bird/animal hazard, endpoint wear
    - NO random neural-network output ever contributes to base risk

Layer 2 – GNN Message-Passing Cascade (graph-topology-aware):
    - Uses the real grid graph topology (edges as graph connections)
    - Cascade only propagates FROM edges that ALREADY have real physical risk (> 0.7)
    - Contribution to adjacent nodes is bounded (max +0.35 from cascade)
    - Node-to-node cascade does NOT exist — only line→node via physical line failure

Layer 3 – Trained RGCN blend (optional):
    - If a trained model file exists on disk, its output is blended lightly (25%)
      into the expert probability
    - If no trained model exists, expert rules are used exclusively (no random weights)

Result: under normal weather with no physical hazards the risk is exactly 0.
        Risks only appear when real, measurable physical thresholds are crossed.
"""

import os
import math
from datetime import datetime

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    TORCH_AVAILABLE = True
except ImportError:
    TORCH_AVAILABLE = False

try:
    import numpy as np
    NUMPY_AVAILABLE = True
except ImportError:
    NUMPY_AVAILABLE = False


# ══════════════════════════════════════════════════════════════════════════════
# PHYSICAL FORMULA HELPERS
# ══════════════════════════════════════════════════════════════════════════════

def calculate_ice_index(precipitation: float, temperature: float, humidity: float) -> float:
    """
    Ice accumulation index (thesis formula, section 2.5):
      I = (1 − e^(−prec/0.5)) · max(0, 1−(T+3)/3) · max(0, min(1, (RH−60)/40))
    Returns value in [0, 1].
    Conditions for icing: negative temperatures, high humidity, precipitation present.
    """
    if precipitation <= 0:
        return 0.0
    precip_factor   = 1.0 - math.exp(-precipitation / 0.5)
    temp_factor     = max(0.0, 1.0 - (temperature + 3.0) / 3.0)
    humidity_factor = max(0.0, min(1.0, (humidity - 60.0) / 40.0))
    return min(1.0, precip_factor * temp_factor * humidity_factor)


def calculate_indices(wear, nominal_power, reserve_power, critical_wind,
                      temp_min, temp_max, seismic_limit,
                      temperature, wind_speed, precipitation,
                      storm_probability, actual_seismicity, humidity):
    """
    Legacy helper kept for API compatibility with /api/grid/nodes response.
    Computes ice, effective_wind, and complex_danger indices.
    """
    norm_ice    = calculate_ice_index(precipitation, temperature, humidity)
    wind_ratio  = wind_speed / max(1.0, critical_wind)
    eff_wind    = wind_ratio * (1.0 + 0.5 * norm_ice)
    beta        = 0.3
    max_hazard  = max(min(1.0, wind_ratio), storm_probability, norm_ice)
    complex_d   = min(1.0, max_hazard + beta * (min(1.0, wind_ratio) * norm_ice))
    return {
        "ice_index":      round(norm_ice, 3),
        "effective_wind": round(eff_wind, 3),
        "complex_danger": round(complex_d, 3),
    }


# ══════════════════════════════════════════════════════════════════════════════
# LAYER 1 – EXPERT RISK FUNCTIONS
# ══════════════════════════════════════════════════════════════════════════════

def compute_node_expert_risk(node, meteo) -> tuple:
    """
    Deterministic expert risk for a grid NODE (substation / generation source).
    Nodes are NOT directly affected by wind, ice, birds or forestry — those
    factors only apply to overhead transmission lines (edges).

    Returns: (probability: float, reasons: list[str])
    """
    p = 0.0
    reasons = []

    # ── Seismicity exceeded (highest priority, immediate Red) ───────────────
    if meteo and meteo.actual_seismicity > node.seismic_limit:
        p = 0.99
        reasons.append(
            f"Превышение сейсмического предела: {meteo.actual_seismicity} б "
            f"(предел: {node.seismic_limit} б)"
        )
        return min(1.0, p), reasons  # no need to evaluate further

    # ── Equipment wear ──────────────────────────────────────────────────────
    if node.wear >= 98.0:
        p = max(p, 0.98)
        reasons.append(f"Критический физический износ оборудования ({node.wear:.0f}%)")
    elif node.wear >= 85.0:
        # Linear: 0.25 at 85% → 0.60 at 97%
        ratio = (node.wear - 85.0) / 12.0
        p = max(p, 0.25 + ratio * 0.35)
        reasons.append(f"Повышенный износ оборудования ({node.wear:.0f}%)")
    elif node.wear >= 70.0:
        # Linear: 0.05 at 70% → 0.25 at 85%
        ratio = (node.wear - 70.0) / 15.0
        p = max(p, 0.05 + ratio * 0.20)
        # Below yellow threshold — no reason text needed

    # ── Temperature out of safe operating range ─────────────────────────────
    if meteo:
        temp_range = node.temp_max - node.temp_min
        if temp_range > 0:
            if meteo.temperature < node.temp_min - 5:
                excess = (node.temp_min - meteo.temperature) / 10.0
                contrib = min(0.35, excess * 0.15)
                if contrib > p:
                    p = contrib
                    reasons.append(
                        f"Температура ниже допустимого минимума "
                        f"({meteo.temperature:.0f}°C, предел: {node.temp_min}°C)"
                    )
            elif meteo.temperature > node.temp_max + 5:
                excess = (meteo.temperature - node.temp_max) / 10.0
                contrib = min(0.35, excess * 0.15)
                if contrib > p:
                    p = contrib
                    reasons.append(
                        f"Температура выше допустимого максимума "
                        f"({meteo.temperature:.0f}°C, предел: {node.temp_max}°C)"
                    )

    return min(1.0, p), reasons


def compute_edge_expert_risk(edge, source_node, target_node,
                              src_meteo, tgt_meteo, season_mult=1.0) -> tuple:
    """
    Deterministic expert risk for a transmission LINE (edge).
    All physical hazards unique to overhead lines are computed here.

    Returns: (probability: float, reasons: list[str])
    """
    p = 0.0
    reasons = []

    max_wind = max(
        src_meteo.wind_speed if src_meteo else 0.0,
        tgt_meteo.wind_speed if tgt_meteo else 0.0
    )
    max_storm = max(
        src_meteo.storm_probability if src_meteo else 0.0,
        tgt_meteo.storm_probability if tgt_meteo else 0.0
    )
    edge_critical_wind = getattr(edge, 'critical_wind', 25.0)

    # ── 1. Wind vs critical wind ────────────────────────────────────────────
    if max_wind >= edge_critical_wind:
        # Beyond critical → high risk, grows with excess
        excess_ratio = (max_wind - edge_critical_wind) / max(1.0, edge_critical_wind)
        wind_p = min(0.99, 0.85 + excess_ratio * 0.10)
        p = max(p, wind_p)
        reasons.append(
            f"Критическая скорость ветра ({max_wind:.1f} м/с, "
            f"предел: {edge_critical_wind:.0f} м/с)"
        )
    elif max_wind >= edge_critical_wind * 0.75:
        # Approaching critical (75%–99%) → moderate risk
        wind_ratio = (max_wind - edge_critical_wind * 0.75) / (edge_critical_wind * 0.25)
        wind_p = 0.35 + wind_ratio * 0.30  # 0.35 → 0.65
        p = max(p, wind_p)
        reasons.append(
            f"Ветер близок к критическому ({max_wind:.1f} м/с, "
            f"предел: {edge_critical_wind:.0f} м/с)"
        )

    # ── 2. Ice accumulation + wind synergy ─────────────────────────────────
    ice_vals = []
    for m in [src_meteo, tgt_meteo]:
        if m:
            ice_vals.append(calculate_ice_index(m.precipitation, m.temperature, m.humidity))
    max_ice = max(ice_vals) if ice_vals else 0.0

    if max_ice >= 0.5:
        if max_wind > 12.0:
            ice_p = min(0.95, 0.75 + max_ice * 0.10 + (max_wind - 12.0) / 40.0 * 0.10)
            p = max(p, ice_p)
            reasons.append(
                f"Критическое обледенение проводов при сильном ветре "
                f"(индекс: {max_ice:.2f}, ветер: {max_wind:.1f} м/с)"
            )
        else:
            ice_p = 0.45 + max_ice * 0.15
            p = max(p, ice_p)
            reasons.append(f"Обледенение проводов (индекс: {max_ice:.2f})")
    elif max_ice >= 0.25:
        # Minor ice: sub-threshold contribution, no reason text
        p = max(p, 0.15 + max_ice * 0.20)

    # ── 3. Storm / lightning ────────────────────────────────────────────────
    if max_storm > 0.0:
        p = max(p, 0.50)
        reasons.append("Грозовая активность")

    # ── 4. Forestry hazard (falling trees) ─────────────────────────────────
    edge_forestry = getattr(edge, 'forestry', 0.0)
    if edge_forestry > 0.6 and max_wind > 18.0:
        forestry_p = min(0.90,
                         0.60 + edge_forestry * 0.15 + (max_wind - 18.0) / 20.0 * 0.15)
        p = max(p, forestry_p)
        reasons.append(
            f"Угроза падения деревьев (лесистость: {edge_forestry:.2f}, "
            f"ветер: {max_wind:.1f} м/с)"
        )

    # ── 5. Bird / animal hazard ─────────────────────────────────────────────
    edge_animal_hazard = getattr(edge, 'animal_hazard', 0.0)
    effective_bird = edge_animal_hazard * season_mult
    if effective_bird > 0.5 and max_wind > 12.0:
        bird_p = min(0.55, 0.35 + effective_bird * 0.15)
        p = max(p, bird_p)
        reasons.append(
            f"Орнитологическая угроза при сильном ветре "
            f"(коэф: {effective_bird:.2f}, ветер: {max_wind:.1f} м/с)"
        )

    # ── 6. Endpoint structural wear ─────────────────────────────────────────
    avg_wear = 0.5 * (
        getattr(source_node, 'wear', 0.0) + getattr(target_node, 'wear', 0.0)
    )
    if avg_wear >= 85.0:
        ratio = (avg_wear - 85.0) / 15.0
        wear_p = 0.60 + ratio * 0.25
        p = max(p, wear_p)
        reasons.append(f"Критический износ опор линии (средний: {avg_wear:.1f}%)")
    elif avg_wear >= 70.0:
        ratio = (avg_wear - 70.0) / 15.0
        wear_p = 0.20 + ratio * 0.40
        p = max(p, wear_p)

    return min(1.0, p), reasons


# ══════════════════════════════════════════════════════════════════════════════
# GNN PYTORCH CLASSES (kept for optional trained-model blending)
# ══════════════════════════════════════════════════════════════════════════════

if TORCH_AVAILABLE:
    class RelationalGraphConv(nn.Module):
        """Custom RGCN layer."""
        def __init__(self, in_features, out_features, num_relations):
            super().__init__()
            self.num_relations = num_relations
            self.out_features = out_features
            self.weights = nn.Parameter(
                torch.Tensor(num_relations, in_features, out_features))
            self.self_weight = nn.Parameter(
                torch.Tensor(in_features, out_features))
            self.bias = nn.Parameter(torch.Tensor(out_features))
            self.reset_parameters()

        def reset_parameters(self):
            nn.init.kaiming_uniform_(self.weights, a=math.sqrt(5))
            nn.init.kaiming_uniform_(self.self_weight, a=math.sqrt(5))
            fan_in, _ = nn.init._calculate_fan_in_and_fan_out(self.self_weight)
            bound = 1 / math.sqrt(fan_in)
            nn.init.uniform_(self.bias, -bound, bound)

        def forward(self, x, edge_index, edge_type):
            num_nodes = x.size(0)
            out = torch.matmul(x, self.self_weight)
            for r in range(self.num_relations):
                mask = (edge_type == r)
                if not mask.any():
                    continue
                r_edges = edge_index[:, mask]
                sources, targets = r_edges[0], r_edges[1]
                mapped = torch.matmul(x[sources], self.weights[r])
                rel_out = torch.zeros(num_nodes, self.out_features, device=x.device)
                rel_out.index_add_(0, targets, mapped)
                deg = torch.zeros(num_nodes, 1, device=x.device)
                deg.index_add_(0, targets,
                               torch.ones(targets.size(0), 1, device=x.device))
                deg = torch.clamp(deg, min=1.0)
                out += rel_out / deg
            return out + self.bias

    class RGCNNet(nn.Module):
        """RGCN network: 2 relational conv layers + sigmoid classifier."""
        def __init__(self, in_features=12, hidden_features=16, num_relations=3):
            super().__init__()
            self.conv1 = RelationalGraphConv(in_features, hidden_features, num_relations)
            self.conv2 = RelationalGraphConv(hidden_features, hidden_features, num_relations)
            self.classifier = nn.Linear(hidden_features, 1)

        def forward(self, x, edge_index, edge_type):
            h = F.relu(self.conv1(x, edge_index, edge_type))
            h = F.relu(self.conv2(h, edge_index, edge_type))
            return torch.sigmoid(self.classifier(h)).squeeze(-1)


# ══════════════════════════════════════════════════════════════════════════════
# MAIN PREDICTOR
# ══════════════════════════════════════════════════════════════════════════════

class GNNPredictor:
    """
    Three-layer accident probability predictor.

    Usage:
        predictor = GNNPredictor()
        (node_probs, threat_levels, node_indices, reasons,
         edge_probs, edge_threat_levels, edge_reasons) = predictor.predict(nodes, edges, meteo)
    """

    # Cascade parameters (GNN message-passing layer)
    CASCADE_RISK_THRESHOLD = 0.70   # Line must be in RED zone to propagate
    CASCADE_MAX_LIFT       = 0.35   # Max cascade addition to a node (keeps nodes out of red)
    CASCADE_FACTOR         = 0.40   # Cascade = line_risk × factor

    def __init__(self, model_path: str = "rgcn_model.pt"):
        self.model_path = model_path
        self.edge_type_map = {"LEP_110": 0, "LEP_220": 1, "reserve": 2}
        self.in_features   = 12
        self.hidden_f      = 16
        self.num_relations = 3
        self.use_torch     = TORCH_AVAILABLE
        self.model_loaded  = False

        if self.use_torch:
            self.model = RGCNNet(self.in_features, self.hidden_f, self.num_relations)
            if os.path.exists(self.model_path):
                try:
                    self.model.load_state_dict(
                        torch.load(self.model_path, map_location='cpu'))
                    self.model.eval()
                    self.model_loaded = True
                    print(f"[GNN] Trained model loaded from '{self.model_path}'")
                except Exception as e:
                    print(f"[GNN] Cannot load model ({e}). Expert rules only.")
            else:
                self.model.eval()
                print("[GNN] No trained model found — expert rules are the sole source of risk.")

    # ──────────────────────────────────────────────────────────────────────────
    def train_synthetic(self) -> bool:
        """Train the RGCN on synthetic data to demonstrate learning capability."""
        if not self.use_torch:
            print("Training requires PyTorch.")
            return False

        print("Generating synthetic training dataset…")
        self.model.train()
        optimizer = torch.optim.Adam(self.model.parameters(), lr=0.01)
        criterion = nn.BCELoss()

        num_nodes = 10
        x = torch.rand(num_nodes, self.in_features)
        s = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] + [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]
        t = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0] + [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]
        edge_index = torch.tensor([s, t], dtype=torch.long)
        edge_type  = torch.randint(0, self.num_relations, (edge_index.size(1),))
        # Label: high risk if wear + wind score > 1.1
        labels = ((x[:, 0] + x[:, 6]) > 1.1).float()

        for epoch in range(100):
            optimizer.zero_grad()
            loss = criterion(self.model(x, edge_index, edge_type), labels)
            loss.backward()
            optimizer.step()
            if (epoch + 1) % 20 == 0:
                print(f"  Epoch {epoch+1}/100  loss={loss.item():.4f}")

        torch.save(self.model.state_dict(), self.model_path)
        self.model.eval()
        self.model_loaded = True
        print(f"[GNN] Model saved to '{self.model_path}'")
        return True

    # ──────────────────────────────────────────────────────────────────────────
    def predict(self, db_nodes, db_edges, db_meteo):
        """
        Full prediction pipeline.

        Parameters
        ----------
        db_nodes  : list of Node ORM objects
        db_edges  : list of Edge ORM objects
        db_meteo  : dict  {node_id: MeteoData ORM object}

        Returns
        -------
        Tuple of 7:
          node_final_risks       dict {node_id: float}
          threat_levels          dict {node_id: "green"|"yellow"|"red"}
          node_indices           dict {node_id: dict}  (legacy compatibility)
          reasons                dict {node_id: list[str]}
          edge_final_risks       dict {edge_id: float}
          edge_threat_levels     dict {edge_id: "green"|"yellow"|"red"}
          edge_reasons           dict {edge_id: list[str]}
        """
        if not db_nodes:
            return {}, {}, {}, {}, {}, {}, {}

        current_month = datetime.utcnow().month
        # Seasonal multiplier for bird/animal hazard (spring & autumn migration)
        season_mult = 1.5 if current_month in [4, 5, 6, 9, 10] else 1.0

        # ══ LAYER 1a: Expert node risks ══════════════════════════════════════
        node_expert_risks   = {}
        node_expert_reasons = {}
        node_indices        = {}

        for node in db_nodes:
            meteo = db_meteo.get(node.id)
            p, r = compute_node_expert_risk(node, meteo)
            node_expert_risks[node.id]   = p
            node_expert_reasons[node.id] = r

            # Legacy index dict for API response (used in node detail panel)
            if meteo:
                node_indices[node.id] = calculate_indices(
                    node.wear, node.nominal_power, node.reserve_power,
                    999.0,  # nodes: wind disabled
                    node.temp_min, node.temp_max, node.seismic_limit,
                    meteo.temperature, 0.0, meteo.precipitation,
                    meteo.storm_probability, meteo.actual_seismicity,
                    meteo.humidity
                )
            else:
                node_indices[node.id] = {"ice_index": 0.0,
                                         "effective_wind": 0.0,
                                         "complex_danger": 0.0}

        # ══ LAYER 1b: Expert edge risks ═══════════════════════════════════════
        edge_expert_risks   = {}
        edge_expert_reasons = {}

        node_map = {n.id: n for n in db_nodes}

        for edge in db_edges:
            src = node_map.get(edge.source_id)
            tgt = node_map.get(edge.target_id)
            if not src or not tgt:
                edge_expert_risks[edge.id]   = 0.0
                edge_expert_reasons[edge.id] = []
                continue

            src_meteo = db_meteo.get(edge.source_id)
            tgt_meteo = db_meteo.get(edge.target_id)

            p, r = compute_edge_expert_risk(
                edge, src, tgt, src_meteo, tgt_meteo, season_mult
            )
            edge_expert_risks[edge.id]   = p
            edge_expert_reasons[edge.id] = r

        # ══ LAYER 2: GNN message-passing cascade ══════════════════════════════
        # Build node → adjacent edges index
        node_adj_edges = {node.id: [] for node in db_nodes}
        for edge in db_edges:
            if edge.source_id in node_adj_edges:
                node_adj_edges[edge.source_id].append(edge)
            if edge.target_id in node_adj_edges:
                node_adj_edges[edge.target_id].append(edge)

        # Propagate: only RED-zone lines can lift adjacent nodes
        node_final_risks    = dict(node_expert_risks)
        cascade_reasons     = {node.id: [] for node in db_nodes}

        for node in db_nodes:
            best_lift     = 0.0
            best_edge_obj = None

            for edge in node_adj_edges.get(node.id, []):
                line_risk = edge_expert_risks.get(edge.id, 0.0)
                if line_risk <= self.CASCADE_RISK_THRESHOLD:
                    continue  # Line is not in red zone — no cascade

                lift = min(self.CASCADE_MAX_LIFT, line_risk * self.CASCADE_FACTOR)
                if lift > best_lift:
                    best_lift     = lift
                    best_edge_obj = edge

            if best_lift > 0.0 and best_lift > node_final_risks[node.id]:
                node_final_risks[node.id] = best_lift
                if best_edge_obj:
                    src_name = node_map.get(best_edge_obj.source_id, None)
                    tgt_name = node_map.get(best_edge_obj.target_id, None)
                    src_label = src_name.name if src_name else f"ID {best_edge_obj.source_id}"
                    tgt_label = tgt_name.name if tgt_name else f"ID {best_edge_obj.target_id}"
                    line_risk_val = edge_expert_risks[best_edge_obj.id]
                    cascade_reasons[node.id].append(
                        f"Влияние аварийной линии ЛЭП: {src_label} → {tgt_label} "
                        f"(риск линии: {line_risk_val:.0%})"
                    )

        # ══ LAYER 3: Blend with trained RGCN (only if model file exists) ═════
        # Random/untrained model weights NEVER contribute — we skip blending
        # if the model was not loaded from a saved checkpoint.
        if self.model_loaded and self.use_torch and NUMPY_AVAILABLE:
            node_id_to_idx = {node.id: idx for idx, node in enumerate(db_nodes)}
            x_features = []
            for node in db_nodes:
                meteo = db_meteo.get(node.id)
                if not meteo:
                    class _M:
                        temperature = 15.0; wind_speed = 0.0; precipitation = 0.0
                        storm_probability = 0.0; actual_seismicity = 0; humidity = 60.0
                    meteo = _M()
                # Feed EXPERT risk + physical scalars as features (not raw sensor noise)
                wear_norm     = min(1.0, node.wear / 100.0)
                seismic_ratio = min(1.0, meteo.actual_seismicity / max(1, node.seismic_limit))
                ice_idx       = calculate_ice_index(
                    meteo.precipitation, meteo.temperature, meteo.humidity)
                expert_p      = node_expert_risks[node.id]
                feat = [
                    wear_norm, expert_p, seismic_ratio, ice_idx,
                    node.soil_stability, 0.0, 0.0,
                    meteo.storm_probability,
                    0.0, 0.0, 0.0, 0.0
                ]
                x_features.append(feat)

            srcs, tgts, etypes = [], [], []
            for edge in db_edges:
                if (edge.source_id in node_id_to_idx
                        and edge.target_id in node_id_to_idx):
                    s = node_id_to_idx[edge.source_id]
                    t = node_id_to_idx[edge.target_id]
                    srcs.extend([s, t]); tgts.extend([t, s])
                    et = self.edge_type_map.get(edge.type, 2)
                    etypes.extend([et, et])

            x_t = torch.tensor(x_features, dtype=torch.float)
            if srcs:
                ei = torch.tensor([srcs, tgts], dtype=torch.long)
                et = torch.tensor(etypes, dtype=torch.long)
            else:
                ei = torch.empty((2, 0), dtype=torch.long)
                et = torch.empty((0,), dtype=torch.long)

            with torch.no_grad():
                gnn_out = self.model(x_t, ei, et).numpy()
            if len(db_nodes) == 1:
                gnn_out = np.array([float(gnn_out)])

            GNN_WEIGHT = 0.25  # Trained GNN contributes 25%; expert rules 75%
            for node in db_nodes:
                gnn_p    = float(gnn_out[node_id_to_idx[node.id]])
                expert_p = node_final_risks[node.id]
                blended  = expert_p * (1 - GNN_WEIGHT) + gnn_p * GNN_WEIGHT
                # Clamp: GNN cannot add more than 0.15 above expert baseline
                node_final_risks[node.id] = min(blended, expert_p + 0.15)

        # ══ Classify threat levels ════════════════════════════════════════════
        threat_levels = {}
        for node_id, p in node_final_risks.items():
            if p < 0.4:
                threat_levels[node_id] = "green"
            elif p <= 0.7:
                threat_levels[node_id] = "yellow"
            else:
                threat_levels[node_id] = "red"

        edge_threat_levels = {}
        for edge_id, p in edge_expert_risks.items():
            if p < 0.4:
                edge_threat_levels[edge_id] = "green"
            elif p <= 0.7:
                edge_threat_levels[edge_id] = "yellow"
            else:
                edge_threat_levels[edge_id] = "red"

        # ══ Collect final node reasons ════════════════════════════════════════
        reasons = {}
        for node in db_nodes:
            r = list(node_expert_reasons.get(node.id, []))
            r += cascade_reasons.get(node.id, [])
            reasons[node.id] = r

        return (
            node_final_risks,
            threat_levels,
            node_indices,
            reasons,
            edge_expert_risks,
            edge_threat_levels,
            edge_expert_reasons,
        )
