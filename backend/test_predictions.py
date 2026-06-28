import sys
import os

# Adjust path to import backend modules
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from gnn_model import calculate_indices, GNNPredictor

def test_formulas():
    print("Testing math formulas...")
    # Normal case: Temp=15C, Wind=5m/s, Precip=0, Hum=60%
    ind1 = calculate_indices(
        wear=10, nominal_power=100, reserve_power=10, critical_wind=25,
        temp_min=-40, temp_max=40, seismic_limit=7,
        temperature=15.0, wind_speed=5.0, precipitation=0.0,
        storm_probability=0.1, actual_seismicity=0, humidity=60.0
    )
    assert ind1["ice_index"] == 0.0, "Ice index must be 0 at 15C"
    assert ind1["effective_wind"] == round(5.0 / 25.0, 3)
    assert ind1["complex_danger"] == round(5.0 / 25.0, 3)

    # Icing conditions: Temp=-2C, Wind=10m/s, Precip=4mm/h, Hum=95%
    ind2 = calculate_indices(
        wear=50, nominal_power=200, reserve_power=20, critical_wind=25,
        temp_min=-40, temp_max=40, seismic_limit=7,
        temperature=-2.0, wind_speed=10.0, precipitation=4.0,
        storm_probability=0.0, actual_seismicity=0, humidity=95.0
    )
    # New icing index formula value: 0.583
    assert ind2["ice_index"] == 0.583
    # effective_wind = (10 / 25) * (1 + 0.5 * 0.583) = 0.4 * 1.2915 = 0.517
    assert ind2["effective_wind"] == 0.517
    
    print("Formulas test passed!")

def test_expert_rules_and_cascade():
    print("Testing expert rules and cascade propagation...")
    
    # Mock Node structures
    class MockNode:
        def __init__(self, id, name, type, wear, critical_wind, seismic_limit, animal_hazard=0.0):
            self.id = id
            self.name = name
            self.type = type
            self.wear = wear
            self.critical_wind = critical_wind
            self.seismic_limit = seismic_limit
            self.nominal_power = 100
            self.reserve_power = 10
            self.temp_min = -40
            self.temp_max = 40
            self.forestry = 0.1
            self.soil_stability = 0.9
            self.animal_hazard = animal_hazard

    class MockMeteo:
        def __init__(self, temperature, wind_speed, precipitation, storm_probability, actual_seismicity):
            self.temperature = temperature
            self.wind_speed = wind_speed
            self.precipitation = precipitation
            self.storm_probability = storm_probability
            self.actual_seismicity = actual_seismicity
            self.humidity = 70.0

    # Node 1: Normal conditions, Node 2: High wear (>= 98%) to trigger expert override
    n1 = MockNode(1, "Node 1", "substation", wear=10, critical_wind=25, seismic_limit=7, animal_hazard=0.2)
    n2 = MockNode(2, "Node 2", "substation", wear=99, critical_wind=20, seismic_limit=7, animal_hazard=0.5)
    
    m1 = MockMeteo(temperature=15, wind_speed=5, precipitation=0, storm_probability=0.1, actual_seismicity=0)
    m2 = MockMeteo(temperature=15, wind_speed=5, precipitation=0, storm_probability=0.1, actual_seismicity=0)
    
    # Connection Node 1 <-> Node 2
    class MockEdge:
        def __init__(self, source_id, target_id, animal_hazard=0.8):
            self.id = 1
            self.source_id = source_id
            self.target_id = target_id
            self.type = "LEP_110"
            self.animal_hazard = animal_hazard

    edge = MockEdge(1, 2)
    
    predictor = GNNPredictor()
    (probs, threat_levels, indices, reasons,
     edge_probs, edge_threat_levels, edge_reasons) = predictor.predict([n1, n2], [edge], {1: m1, 2: m2})
    
    # Node 2 must be RED threat level because wear >= 98%
    assert probs[2] >= 0.95, "Node 2 should trigger wear expert override (P >= 0.98)"
    assert threat_levels[2] == "red", "Node 2 threat level must be RED"
    
    # Node 1 should receive cascade risk boost because Node 2 has high risk (> 0.9)
    print(f"Node 1 standard prob: {probs[1]}, Threat level: {threat_levels[1]}")
    # Let's verify cascade was applied
    assert probs[1] >= 0.2, "Node 1 should have received cascade boost (+0.2)"
    
    # Verify edge (line) predictions
    assert 1 in edge_probs, "Edge prediction must be calculated for edge ID 1"
    assert edge_probs[1] >= 0.65, "Edge should have elevated risk due to high endpoint risks and animal hazard"
    assert any("птицы" in r.lower() or "орнито" in r.lower() for r in edge_reasons[1]), "Edge should have animal/bird hazard reason"
    
    print("Expert rules and cascade test passed!")

if __name__ == "__main__":
    test_formulas()
    test_expert_rules_and_cascade()
    print("All tests successfully completed!")
