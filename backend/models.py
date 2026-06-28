from sqlalchemy import Column, Integer, String, Float, ForeignKey, DateTime, UniqueConstraint
from sqlalchemy.orm import relationship
from datetime import datetime
from database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    role = Column(String, default="dispatcher") # admin, dispatcher

class Node(Base):
    __tablename__ = "nodes"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, index=True, nullable=False)
    type = Column(String, nullable=False) # generation, substation, line_node
    latitude = Column(Float, nullable=False)
    longitude = Column(Float, nullable=False)
    
    # Passport & diagnostic data
    wear = Column(Float, default=0.0) # Wear percentage 0-100
    nominal_power = Column(Float, default=0.0) # MW
    reserve_power = Column(Float, default=0.0) # MW
    temp_min = Column(Float, default=-40.0) # °C
    temp_max = Column(Float, default=40.0) # °C
    seismic_limit = Column(Integer, default=7) # MSK-64 limit (0-12)
    critical_wind = Column(Float, default=25.0) # m/s
    forestry = Column(Float, default=0.0) # 0-1 density
    soil_stability = Column(Float, default=1.0) # 0-1 stability
    animal_hazard = Column(Float, default=0.0) # 0-1 bird/animal danger

    # Relationships
    meteo_records = relationship("MeteoData", back_populates="node", cascade="all, delete-orphan")
    predictions = relationship("Prediction", back_populates="node", cascade="all, delete-orphan")

class Edge(Base):
    __tablename__ = "edges"

    id = Column(Integer, primary_key=True, index=True)
    source_id = Column(Integer, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False)
    target_id = Column(Integer, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False)
    type = Column(String, nullable=False) # LEP_110, LEP_220, reserve
    length = Column(Float, default=1.0) # km
    capacity = Column(Float, default=100.0) # MW
    animal_hazard = Column(Float, default=0.0) # 0-1 bird/animal danger
    forestry = Column(Float, default=0.0) # 0-1 forestry density along the line
    critical_wind = Column(Float, default=25.0) # critical wind speed in m/s

    # Relationships to source and target nodes
    source = relationship("Node", foreign_keys=[source_id])
    target = relationship("Node", foreign_keys=[target_id])
    predictions = relationship("EdgePrediction", back_populates="edge", cascade="all, delete-orphan")

class MeteoData(Base):
    __tablename__ = "meteo_data"

    id = Column(Integer, primary_key=True, index=True)
    node_id = Column(Integer, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False)
    timestamp = Column(DateTime, default=datetime.utcnow, index=True, nullable=False)
    
    temperature = Column(Float, nullable=False) # °C
    wind_speed = Column(Float, nullable=False) # m/s
    precipitation = Column(Float, nullable=False) # mm/hour
    storm_probability = Column(Float, default=0.0) # 0-1
    actual_seismicity = Column(Integer, default=0) # MSK-64 scale 0-12
    humidity = Column(Float, default=80.0) # % (required for ice index calculation)

    node = relationship("Node", back_populates="meteo_records")

class Prediction(Base):
    __tablename__ = "predictions"

    id = Column(Integer, primary_key=True, index=True)
    node_id = Column(Integer, ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False)
    timestamp = Column(DateTime, default=datetime.utcnow, index=True, nullable=False)
    
    probability = Column(Float, nullable=False) # 0-1
    threat_level = Column(String, nullable=False) # green, yellow, red
    cascade_probability = Column(Float, nullable=False) # 0-1 probability after cascade effect
    reasons = Column(String, default="")

    node = relationship("Node", back_populates="predictions")

class EdgePrediction(Base):
    __tablename__ = "edge_predictions"

    id = Column(Integer, primary_key=True, index=True)
    edge_id = Column(Integer, ForeignKey("edges.id", ondelete="CASCADE"), nullable=False)
    timestamp = Column(DateTime, default=datetime.utcnow, index=True, nullable=False)
    
    probability = Column(Float, nullable=False) # 0-1
    threat_level = Column(String, nullable=False) # green, yellow, red
    cascade_probability = Column(Float, nullable=False) # 0-1 probability after cascade effect
    reasons = Column(String, default="")

    edge = relationship("Edge", back_populates="predictions")
