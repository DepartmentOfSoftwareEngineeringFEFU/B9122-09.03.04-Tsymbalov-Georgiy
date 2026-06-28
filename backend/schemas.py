from pydantic import BaseModel, EmailStr, Field
from typing import List, Optional
from datetime import datetime

# Auth Schemas
class UserCreate(BaseModel):
    username: str
    email: EmailStr
    password: str
    role: Optional[str] = "dispatcher"

class UserLogin(BaseModel):
    username: str
    password: str

class UserOut(BaseModel):
    id: int
    username: str
    email: EmailStr
    role: str

    class Config:
        from_attributes = True

class Token(BaseModel):
    access_token: str
    token_type: str
    user: UserOut

class TokenData(BaseModel):
    username: Optional[str] = None

# Node Schemas
class NodeCreate(BaseModel):
    name: str
    type: str # generation, substation, line_node
    latitude: float
    longitude: float
    wear: float = 0.0
    nominal_power: float = 0.0
    reserve_power: float = 0.0
    temp_min: float = -40.0
    temp_max: float = 40.0
    seismic_limit: int = 7
    critical_wind: float = 25.0
    forestry: float = 0.0
    soil_stability: float = 1.0
    animal_hazard: float = 0.0

class NodeUpdate(BaseModel):
    name: Optional[str] = None
    type: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    wear: Optional[float] = None
    nominal_power: Optional[float] = None
    reserve_power: Optional[float] = None
    temp_min: Optional[float] = None
    temp_max: Optional[float] = None
    seismic_limit: Optional[int] = None
    critical_wind: Optional[float] = None
    forestry: Optional[float] = None
    soil_stability: Optional[float] = None
    animal_hazard: Optional[float] = None

class NodeOut(BaseModel):
    id: int
    name: str
    type: str
    latitude: float
    longitude: float
    wear: float
    nominal_power: float
    reserve_power: float
    temp_min: float
    temp_max: float
    seismic_limit: int
    critical_wind: float
    forestry: float
    soil_stability: float
    animal_hazard: float

    class Config:
        from_attributes = True

# Edge Schemas
class EdgeCreate(BaseModel):
    source_id: int
    target_id: int
    type: str # LEP_110, LEP_220, reserve
    length: float = 1.0
    capacity: float = 100.0
    animal_hazard: float = 0.0
    forestry: float = 0.0
    critical_wind: float = 25.0

class EdgeUpdate(BaseModel):
    type: Optional[str] = None
    length: Optional[float] = None
    capacity: Optional[float] = None
    animal_hazard: Optional[float] = None
    forestry: Optional[float] = None
    critical_wind: Optional[float] = None

class EdgeOut(BaseModel):
    id: int
    source_id: int
    target_id: int
    type: str
    length: float
    capacity: float
    animal_hazard: float
    forestry: float
    critical_wind: float

    class Config:
        from_attributes = True

# Meteo Schemas
class MeteoDataCreate(BaseModel):
    node_id: int
    temperature: float
    wind_speed: float
    precipitation: float
    storm_probability: float = 0.0
    actual_seismicity: int = 0
    humidity: float = 80.0

class MeteoDataOut(BaseModel):
    id: int
    node_id: int
    timestamp: datetime
    temperature: float
    wind_speed: float
    precipitation: float
    storm_probability: float
    actual_seismicity: int
    humidity: float

    class Config:
        from_attributes = True

# Prediction Schemas
class PredictionOut(BaseModel):
    id: int
    node_id: int
    timestamp: datetime
    probability: float
    threat_level: str
    cascade_probability: float
    reasons: Optional[str] = ""

    class Config:
        from_attributes = True

class EdgePredictionOut(BaseModel):
    id: int
    edge_id: int
    timestamp: datetime
    probability: float
    threat_level: str
    cascade_probability: float
    reasons: Optional[str] = ""

    class Config:
        from_attributes = True

# Aggregated Grid State Schema for frontend Map and Dashboard
class PredictionNodeState(BaseModel):
    node: NodeOut
    latest_meteo: Optional[MeteoDataOut] = None
    latest_prediction: Optional[PredictionOut] = None
    calculated_indices: dict = {} # ice_index, effective_wind, complex_danger

class PredictionEdgeState(BaseModel):
    edge: EdgeOut
    latest_prediction: Optional[EdgePredictionOut] = None

class GridState(BaseModel):
    timestamp: datetime
    nodes: List[PredictionNodeState]
    edges: List[PredictionEdgeState]
