import os
from fastapi import FastAPI, Depends, HTTPException, status, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from datetime import datetime
from typing import List, Optional

import models
import schemas
import auth
import database
import weather
from gnn_model import GNNPredictor, calculate_indices
from pdf_generator import generate_pdf_report

# Initialize database tables
models.Base.metadata.create_all(bind=database.engine)

app = FastAPI(
    title="Power Grid Accident Prediction API",
    description="Backend API for monitoring and predicting emergencies in power grid using GNN and Expert Rules",
    version="1.0.0"
)

# Enable CORS for frontend integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # In production, restrict this
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize predictor
predictor = GNNPredictor()

@app.on_event("startup")
def startup_populate_db():
    """
    Populates the database with a realistic demo power grid and users if empty.
    """
    db = database.SessionLocal()
    try:
        # 0. Safe schema migrations: add new columns if not present
        try:
            from sqlalchemy import text
            with database.engine.connect() as conn:
                conn.execute(text("ALTER TABLE edges ADD COLUMN IF NOT EXISTS forestry FLOAT DEFAULT 0.0"))
                conn.execute(text("ALTER TABLE edges ADD COLUMN IF NOT EXISTS critical_wind FLOAT DEFAULT 25.0"))
                conn.commit()
        except Exception as e:
            print(f"Migration error: {e}")

        # 1. Create a default admin user if not exists
        if not db.query(models.User).filter(models.User.username == "admin").first():
            hashed_pwd = auth.get_password_hash("admin123")
            admin_user = models.User(
                username="admin",
                email="admin@powergrid.ru",
                password_hash=hashed_pwd,
                role="admin"
            )
            db.add(admin_user)
            print("Demo admin user created (login: admin, password: admin123).")

        # 2. Check if nodes already exist; if not, create demo grid
        if db.query(models.Node).count() == 0:
            demo_nodes = [
                models.Node(
                    id=1, name="Владивостокская ТЭЦ-2", type="generation",
                    latitude=43.1198, longitude=131.9577, wear=45.0,
                    nominal_power=497.0, reserve_power=80.0,
                    temp_min=-35.0, temp_max=40.0, seismic_limit=8,
                    critical_wind=28.0, forestry=0.2, soil_stability=0.9,
                    animal_hazard=0.1
                ),
                models.Node(
                    id=2, name="ПС Зеленый Угол", type="substation",
                    latitude=43.1290, longitude=131.9480, wear=32.0,
                    nominal_power=120.0, temp_min=-40.0, temp_max=40.0,
                    seismic_limit=7, critical_wind=25.0, forestry=0.1, soil_stability=0.85,
                    animal_hazard=0.2
                ),
                models.Node(
                    id=3, name="ПС Весенняя", type="substation",
                    latitude=43.2505, longitude=132.0305, wear=78.0, # High wear!
                    nominal_power=150.0, temp_min=-40.0, temp_max=40.0,
                    seismic_limit=7, critical_wind=22.0, forestry=0.6, soil_stability=0.75,
                    animal_hazard=0.4
                ),
                models.Node(
                    id=4, name="Артемовская ТЭЦ", type="generation",
                    latitude=43.3440, longitude=132.1760, wear=85.0, # High wear!
                    nominal_power=400.0, reserve_power=30.0,
                    temp_min=-35.0, temp_max=40.0, seismic_limit=8,
                    critical_wind=25.0, forestry=0.4, soil_stability=0.9,
                    animal_hazard=0.15
                ),
                models.Node(
                    id=5, name="ПС Угловая", type="substation",
                    latitude=43.3280, longitude=132.0830, wear=15.0,
                    nominal_power=200.0, temp_min=-40.0, temp_max=40.0,
                    seismic_limit=7, critical_wind=25.0, forestry=0.3, soil_stability=0.8,
                    animal_hazard=0.3
                ),
                models.Node(
                    id=6, name="ПС Заря", type="substation",
                    latitude=43.1670, longitude=131.9210, wear=62.0,
                    nominal_power=180.0, temp_min=-40.0, temp_max=40.0,
                    seismic_limit=7, critical_wind=24.0, forestry=0.35, soil_stability=0.8,
                    animal_hazard=0.25
                )
            ]
            for node in demo_nodes:
                db.add(node)
            db.commit()

            demo_edges = [
                models.Edge(source_id=1, target_id=2, type="LEP_220", length=5.2, capacity=300.0, animal_hazard=0.5),
                models.Edge(source_id=1, target_id=6, type="LEP_110", length=7.8, capacity=150.0, animal_hazard=0.3),
                models.Edge(source_id=4, target_id=5, type="LEP_220", length=8.5, capacity=400.0, animal_hazard=0.2),
                models.Edge(source_id=5, target_id=3, type="LEP_110", length=12.1, capacity=180.0, animal_hazard=0.6),
                models.Edge(source_id=3, target_id=6, type="LEP_110", length=15.4, capacity=150.0, animal_hazard=0.7),
                models.Edge(source_id=2, target_id=6, type="reserve", length=4.8, capacity=100.0, animal_hazard=0.1)
            ]
            for edge in demo_edges:
                db.add(edge)
            db.commit()
            print("Demo grid topology populated successfully.")
            
            # Initial weather and predictions sync
            import asyncio
            asyncio.run(weather.sync_weather_for_nodes(db, "normal"))
            print("Initial weather synchronization complete.")

            # Calculate initial predictions for nodes and edges
            nodes = db.query(models.Node).all()
            edges = db.query(models.Edge).all()
            if nodes:
                latest_meteo = {}
                for node in nodes:
                    m = db.query(models.MeteoData)\
                          .filter(models.MeteoData.node_id == node.id)\
                          .order_by(models.MeteoData.timestamp.desc())\
                          .first()
                    if m:
                        latest_meteo[node.id] = m
                
                (probabilities, threat_levels, _, reasons,
                 edge_cascade_probabilities, edge_threat_levels, edge_reasons) = predictor.predict(nodes, edges, latest_meteo)
                timestamp = datetime.utcnow()
                for node_id, cascade_p in probabilities.items():
                    base_p = probabilities[node_id]
                    level = threat_levels[node_id]
                    node_reasons_str = "; ".join(reasons.get(node_id, []))
                    
                    db_pred = models.Prediction(
                        node_id=node_id,
                        timestamp=timestamp,
                        probability=base_p,
                        threat_level=level,
                        cascade_probability=cascade_p,
                        reasons=node_reasons_str
                    )
                    db.add(db_pred)

                for edge_id, edge_cascade_p in edge_cascade_probabilities.items():
                    e_level = edge_threat_levels[edge_id]
                    edge_reasons_str = "; ".join(edge_reasons.get(edge_id, []))
                    
                    db_edge_pred = models.EdgePrediction(
                        edge_id=edge_id,
                        timestamp=timestamp,
                        probability=edge_cascade_probabilities[edge_id],
                        threat_level=e_level,
                        cascade_probability=edge_cascade_p,
                        reasons=edge_reasons_str
                    )
                    db.add(db_edge_pred)
                db.commit()
                print("Initial GNN predictions populated successfully.")
    finally:
        db.close()

# --- AUTH ENDPOINTS ---

@app.post("/api/auth/register", response_model=schemas.UserOut)
def register(user_in: schemas.UserCreate, db: Session = Depends(database.get_db)):
    db_user = db.query(models.User).filter(models.User.username == user_in.username).first()
    if db_user:
        raise HTTPException(status_code=400, detail="Username already registered")
    db_email = db.query(models.User).filter(models.User.email == user_in.email).first()
    if db_email:
        raise HTTPException(status_code=400, detail="Email already registered")
        
    hashed_pwd = auth.get_password_hash(user_in.password)
    user = models.User(
        username=user_in.username,
        email=user_in.email,
        password_hash=hashed_pwd,
        role=user_in.role
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user

@app.post("/api/auth/login", response_model=schemas.Token)
def login(username: str = Query(...), password: str = Query(...), db: Session = Depends(database.get_db)):
    user = db.query(models.User).filter(models.User.username == username).first()
    if not user or not auth.verify_password(password, user.password_hash):
        raise HTTPException(status_code=400, detail="Incorrect username or password")
    
    access_token = auth.create_access_token(subject=user.username)
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": user
    }

@app.get("/api/auth/me", response_model=schemas.UserOut)
def read_users_me(current_user: models.User = Depends(auth.get_current_user)):
    return current_user

# --- USER MANAGEMENT ENDPOINTS ---

@app.get("/api/users", response_model=List[schemas.UserOut])
def get_users(db: Session = Depends(database.get_db), current_user: models.User = Depends(auth.get_current_user)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Недостаточно прав. Только администратор может просматривать список пользователей.")
    return db.query(models.User).all()

@app.post("/api/users", response_model=schemas.UserOut)
def create_user_by_admin(user_in: schemas.UserCreate, db: Session = Depends(database.get_db), current_user: models.User = Depends(auth.get_current_user)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Недостаточно прав. Только администратор может создавать пользователей.")
    db_user = db.query(models.User).filter(models.User.username == user_in.username).first()
    if db_user:
        raise HTTPException(status_code=400, detail="Имя пользователя уже зарегистрировано")
    db_email = db.query(models.User).filter(models.User.email == user_in.email).first()
    if db_email:
        raise HTTPException(status_code=400, detail="Email уже зарегистрирован")
        
    hashed_pwd = auth.get_password_hash(user_in.password)
    user = models.User(
        username=user_in.username,
        email=user_in.email,
        password_hash=hashed_pwd,
        role=user_in.role
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user

@app.delete("/api/users/{user_id}")
def delete_user(user_id: int, db: Session = Depends(database.get_db), current_user: models.User = Depends(auth.get_current_user)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Недостаточно прав. Только администратор может удалять пользователей.")
    if current_user.id == user_id:
        raise HTTPException(status_code=400, detail="Вы не можете удалить самого себя")
    
    user = db.query(models.User).filter(models.User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="Пользователь не найден")
    
    if user.username == "admin":
        raise HTTPException(status_code=400, detail="Нельзя удалить главного администратора")

    db.delete(user)
    db.commit()
    return {"detail": "Пользователь удален"}

# --- GRID TOPOLOGY IMPORT/EXPORT ENDPOINTS ---

@app.get("/api/grid/export")
def export_grid(db: Session = Depends(database.get_db)):
    nodes = db.query(models.Node).all()
    edges = db.query(models.Edge).all()
    
    nodes_out = []
    for n in nodes:
        nodes_out.append({
            "id": n.id,
            "name": n.name,
            "type": n.type,
            "latitude": n.latitude,
            "longitude": n.longitude,
            "wear": n.wear,
            "nominal_power": n.nominal_power,
            "reserve_power": n.reserve_power,
            "temp_min": n.temp_min,
            "temp_max": n.temp_max,
            "seismic_limit": n.seismic_limit,
            "critical_wind": n.critical_wind,
            "forestry": n.forestry,
            "soil_stability": n.soil_stability,
            "animal_hazard": n.animal_hazard
        })
        
    edges_out = []
    for e in edges:
        edges_out.append({
            "source_id": e.source_id,
            "target_id": e.target_id,
            "type": e.type,
            "length": e.length,
            "capacity": e.capacity,
            "animal_hazard": e.animal_hazard
        })
        
    return {"nodes": nodes_out, "edges": edges_out}

@app.post("/api/grid/import")
async def import_grid(grid_data: dict, db: Session = Depends(database.get_db), current_user: models.User = Depends(auth.get_current_user)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Недостаточно прав. Только администратор может импортировать данные.")
    
    # 1. Clear existing nodes, edges, predictions and weather
    db.query(models.Edge).delete()
    db.query(models.MeteoData).delete()
    db.query(models.Prediction).delete()
    db.query(models.EdgePrediction).delete()
    db.query(models.Node).delete()
    db.commit()
    
    nodes_list = grid_data.get("nodes", [])
    edges_list = grid_data.get("edges", [])
    
    id_map = {}
    
    # 2. Insert nodes
    for n in nodes_list:
        old_id = n.get("id")
        node_attrs = {
            "name": n.get("name"),
            "type": n.get("type"),
            "latitude": n.get("latitude"),
            "longitude": n.get("longitude"),
            "wear": n.get("wear", 0.0),
            "nominal_power": n.get("nominal_power", 0.0),
            "reserve_power": n.get("reserve_power", 0.0),
            "temp_min": n.get("temp_min", -40.0),
            "temp_max": n.get("temp_max", 40.0),
            "seismic_limit": n.get("seismic_limit", 7),
            "critical_wind": n.get("critical_wind", 25.0),
            "forestry": n.get("forestry", 0.0),
            "soil_stability": n.get("soil_stability", 1.0),
            "animal_hazard": n.get("animal_hazard", 0.0)
        }
        db_node = models.Node(**node_attrs)
        db.add(db_node)
        db.flush()
        if old_id is not None:
            id_map[old_id] = db_node.id
            
    # 3. Insert edges
    for e in edges_list:
        old_source = e.get("source_id")
        old_target = e.get("target_id")
        
        new_source = id_map.get(old_source)
        new_target = id_map.get(old_target)
        
        if new_source is not None and new_target is not None:
            edge_attrs = {
                "source_id": new_source,
                "target_id": new_target,
                "type": e.get("type"),
                "length": e.get("length", 1.0),
                "capacity": e.get("capacity", 100.0),
                "animal_hazard": e.get("animal_hazard", 0.0)
            }
            db_edge = models.Edge(**edge_attrs)
            db.add(db_edge)
            
    db.commit()
    
    # 4. Sync weather and perform predictions
    await weather.sync_weather_for_nodes(db, "normal")
    
    nodes = db.query(models.Node).all()
    edges = db.query(models.Edge).all()
    
    if nodes:
        latest_meteo = {}
        for node in nodes:
            m = db.query(models.MeteoData)\
                  .filter(models.MeteoData.node_id == node.id)\
                  .order_by(models.MeteoData.timestamp.desc())\
                  .first()
            if m:
                latest_meteo[node.id] = m
                
        (probabilities, threat_levels, _, reasons,
         edge_cascade_probabilities, edge_threat_levels, edge_reasons) = predictor.predict(nodes, edges, latest_meteo)
        timestamp = datetime.utcnow()
        for node_id, cascade_p in probabilities.items():
            base_p = probabilities[node_id]
            level = threat_levels[node_id]
            node_reasons_str = "; ".join(reasons.get(node_id, []))
            
            db_pred = models.Prediction(
                node_id=node_id,
                timestamp=timestamp,
                probability=base_p,
                threat_level=level,
                cascade_probability=cascade_p,
                reasons=node_reasons_str
            )
            db.add(db_pred)

        for edge_id, edge_cascade_p in edge_cascade_probabilities.items():
            e_level = edge_threat_levels[edge_id]
            edge_reasons_str = "; ".join(edge_reasons.get(edge_id, []))
            
            db_edge_pred = models.EdgePrediction(
                edge_id=edge_id,
                timestamp=timestamp,
                probability=edge_cascade_probabilities[edge_id],
                threat_level=e_level,
                cascade_probability=edge_cascade_p,
                reasons=edge_reasons_str
            )
            db.add(db_edge_pred)
        db.commit()
        
    return {"status": "success", "nodes_imported": len(nodes_list), "edges_imported": len(edges_list)}

# --- GRID MANAGEMENT ENDPOINTS (CRUD) ---

@app.get("/api/grid/nodes", response_model=List[schemas.NodeOut])
def get_nodes(db: Session = Depends(database.get_db)):
    return db.query(models.Node).all()

@app.post("/api/grid/nodes", response_model=schemas.NodeOut)
def create_node(node: schemas.NodeCreate, db: Session = Depends(database.get_db), current_user: models.User = Depends(auth.get_current_user)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Недостаточно прав. Только администратор может добавлять объекты.")
    db_node = models.Node(**node.dict())
    db.add(db_node)
    db.commit()
    db.refresh(db_node)
    return db_node

@app.put("/api/grid/nodes/{node_id}", response_model=schemas.NodeOut)
def update_node(node_id: int, node_in: schemas.NodeUpdate, db: Session = Depends(database.get_db), current_user: models.User = Depends(auth.get_current_user)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Недостаточно прав. Только администратор может редактировать объекты.")
    node = db.query(models.Node).filter(models.Node.id == node_id).first()
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    
    update_data = node_in.dict(exclude_unset=True)
    for key, val in update_data.items():
        setattr(node, key, val)
        
    db.commit()
    db.refresh(node)
    return node

@app.delete("/api/grid/nodes/{node_id}")
def delete_node(node_id: int, db: Session = Depends(database.get_db), current_user: models.User = Depends(auth.get_current_user)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Недостаточно прав. Только администратор может удалять объекты.")
    node = db.query(models.Node).filter(models.Node.id == node_id).first()
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    db.delete(node)
    db.commit()
    return {"detail": "Node deleted"}

@app.get("/api/grid/edges", response_model=List[schemas.EdgeOut])
def get_edges(db: Session = Depends(database.get_db)):
    return db.query(models.Edge).all()

@app.post("/api/grid/edges", response_model=schemas.EdgeOut)
def create_edge(edge: schemas.EdgeCreate, db: Session = Depends(database.get_db), current_user: models.User = Depends(auth.get_current_user)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Недостаточно прав. Только администратор может добавлять линии связи.")
    # Verify node existences
    s = db.query(models.Node).filter(models.Node.id == edge.source_id).first()
    t = db.query(models.Node).filter(models.Node.id == edge.target_id).first()
    if not s or not t:
        raise HTTPException(status_code=400, detail="Source or Target node not found")
        
    db_edge = models.Edge(**edge.dict())
    db.add(db_edge)
    db.commit()
    db.refresh(db_edge)
    return db_edge

@app.put("/api/grid/edges/{edge_id}", response_model=schemas.EdgeOut)
def update_edge(edge_id: int, edge: schemas.EdgeUpdate, db: Session = Depends(database.get_db), current_user: models.User = Depends(auth.get_current_user)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Недостаточно прав. Только администратор может изменять линии связи.")
    db_edge = db.query(models.Edge).filter(models.Edge.id == edge_id).first()
    if not db_edge:
        raise HTTPException(status_code=404, detail="Edge not found")
        
    for key, value in edge.dict(exclude_unset=True).items():
        setattr(db_edge, key, value)
        
    db.commit()
    db.refresh(db_edge)
    return db_edge

@app.delete("/api/grid/edges/{edge_id}")
def delete_edge(edge_id: int, db: Session = Depends(database.get_db), current_user: models.User = Depends(auth.get_current_user)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Недостаточно прав. Только администратор может удалять линии связи.")
    edge = db.query(models.Edge).filter(models.Edge.id == edge_id).first()
    if not edge:
        raise HTTPException(status_code=404, detail="Edge not found")
    db.delete(edge)
    db.commit()
    return {"detail": "Edge deleted"}

# --- WEATHER ENDPOINTS ---

@app.post("/api/weather/sync")
async def sync_weather(
    scenario: str = "normal",
    use_real_weather: bool = False,
    forecast_date: str = "",   # ISO-8601 date string, e.g. "2024-06-29T12:00:00Z"
    db: Session = Depends(database.get_db)
):
    """
    Triggers meteorology and seismology synchronization across all grid nodes.
    Supports scenario: normal, storm, hurricane, ice, seismic.
    When use_real_weather=True and forecast_date is provided, fetches forecast data.
    """
    from datetime import timezone as tz
    import dateutil.parser

    if scenario not in ["normal", "storm", "hurricane", "ice", "seismic"]:
        raise HTTPException(status_code=400, detail="Invalid scenario type")

    forecast_dt = None
    if use_real_weather and forecast_date:
        try:
            parsed = dateutil.parser.isoparse(forecast_date)
            # Ensure timezone-aware
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=tz.utc)
            forecast_dt = parsed
        except Exception:
            pass  # Ignore malformed dates, use current weather

    timestamp = await weather.sync_weather_for_nodes(
        db, scenario,
        use_real_weather=use_real_weather,
        forecast_dt=forecast_dt
    )
    return {
        "status": "success",
        "timestamp": timestamp,
        "scenario": scenario,
        "use_real_weather": use_real_weather,
        "forecast_date": forecast_date or "current"
    }

@app.get("/api/weather/test")
async def test_weather_api(forecast_date: str = "", db: Session = Depends(database.get_db)):
    """
    Tests connectivity to the OpenWeatherMap API using the first available node's coordinates.
    Optionally accepts forecast_date (ISO-8601) to test forecast endpoint.
    """
    from datetime import timezone as tz
    import dateutil.parser

    api_key = os.getenv("OPENWEATHER_API_KEY", "")

    if not api_key:
        return {
            "status": "no_key",
            "message": "API ключ OpenWeatherMap не настроен (переменная OPENWEATHER_API_KEY не задана)",
            "api_data": None
        }

    node = db.query(models.Node).first()
    if not node:
        return {
            "status": "no_nodes",
            "message": "Нет узлов в базе данных для тестирования",
            "api_data": None
        }

    forecast_dt = None
    if forecast_date:
        try:
            parsed = dateutil.parser.isoparse(forecast_date)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=tz.utc)
            forecast_dt = parsed
        except Exception:
            pass

    result = await weather.fetch_real_weather(node.latitude, node.longitude, forecast_dt)
    mode_label = f"прогноз на {forecast_date}" if forecast_dt else "текущая погода"

    if result:
        return {
            "status": "ok",
            "message": (
                f"API работает ({mode_label}). "
                f"Данные для координат ({node.latitude:.4f}, {node.longitude:.4f}) — «{node.name}»"
            ),
            "api_data": result,
            "key_prefix": api_key[:6] + "..." if len(api_key) > 6 else "***",
            "mode": mode_label
        }
    else:
        return {
            "status": "error",
            "message": "API ключ задан, но запрос завершился ошибкой (неверный ключ, лимит, или проблема с сетью)",
            "api_data": None,
            "key_prefix": api_key[:6] + "..." if len(api_key) > 6 else "***"
        }

# --- GNN PREDICTION ENDPOINTS ---

@app.post("/api/predict/train")
def train_gnn():
    """
    Trains the GNN model using synthetic data.
    """
    success = predictor.train_synthetic()
    if not success:
         raise HTTPException(status_code=400, detail="Training failed (requires PyTorch)")
    return {"status": "success", "detail": "GNN model successfully trained and saved."}

@app.post("/api/predict")
def run_prediction(db: Session = Depends(database.get_db)):
    """
    Performs GNN accident prediction calculations based on the latest weather and database nodes/edges state.
    Saves predictions to DB and raises alarms if red danger zone (P > 0.7) is detected.
    """
    nodes = db.query(models.Node).all()
    edges = db.query(models.Edge).all()
    
    if not nodes:
        raise HTTPException(status_code=400, detail="No nodes in database to predict")

    # Get latest weather for each node
    latest_meteo = {}
    for node in nodes:
        m = db.query(models.MeteoData)\
              .filter(models.MeteoData.node_id == node.id)\
              .order_by(models.MeteoData.timestamp.desc())\
              .first()
        if m:
            latest_meteo[node.id] = m

    # Calculate GNN probabilities
    (probabilities, threat_levels, _, reasons,
     edge_cascade_probabilities, edge_threat_levels, edge_reasons) = predictor.predict(nodes, edges, latest_meteo)

    timestamp = datetime.utcnow()
    
    # Save node predictions
    for node_id, cascade_p in probabilities.items():
        base_p = probabilities[node_id]
        level = threat_levels[node_id]
        node_reasons_str = "; ".join(reasons.get(node_id, []))
        
        db_pred = models.Prediction(
            node_id=node_id,
            timestamp=timestamp,
            probability=base_p, # raw probability
            threat_level=level,
            cascade_probability=cascade_p, # cascade probability
            reasons=node_reasons_str
        )
        db.add(db_pred)
        
        # Trigger alarm logic mock
        if level == "red":
            print(f"[ALARM] Node ID {node_id} ({next(n.name for n in nodes if n.id == node_id)}) at RED DANGER LEVEL (P={round(cascade_p, 2)})!")

    # Save edge predictions
    for edge_id, edge_cascade_p in edge_cascade_probabilities.items():
        e_level = edge_threat_levels[edge_id]
        edge_reasons_str = "; ".join(edge_reasons.get(edge_id, []))
        
        db_edge_pred = models.EdgePrediction(
            edge_id=edge_id,
            timestamp=timestamp,
            probability=edge_cascade_probabilities[edge_id],
            threat_level=e_level,
            cascade_probability=edge_cascade_p,
            reasons=edge_reasons_str
        )
        db.add(db_edge_pred)

    db.commit()
    return {"status": "success", "timestamp": timestamp, "total_calculated": len(nodes)}

@app.get("/api/predict/latest", response_model=schemas.GridState)
def get_latest_grid_state(db: Session = Depends(database.get_db)):
    """
    Returns the complete aggregated state of the grid (nodes, edges, weather, risks)
    for the most recent time slice.
    """
    nodes = db.query(models.Node).all()
    edges = db.query(models.Edge).all()
    
    # Find the latest prediction timestamp
    latest_pred_record = db.query(models.Prediction).order_by(models.Prediction.timestamp.desc()).first()
    
    timestamp = latest_pred_record.timestamp if latest_pred_record else datetime.utcnow()
    node_states = []

    for node in nodes:
        # Get meteo matching prediction time, or fallback to latest
        meteo = db.query(models.MeteoData)\
                  .filter(models.MeteoData.node_id == node.id)\
                  .order_by(models.MeteoData.timestamp.desc())\
                  .first()
        
        # Get latest prediction matching time
        pred = db.query(models.Prediction)\
                 .filter(models.Prediction.node_id == node.id)\
                 .order_by(models.Prediction.timestamp.desc())\
                 .first()

        # Re-calculate indices
        indices = {}
        if meteo:
            indices = calculate_indices(
                node.wear, node.nominal_power, node.reserve_power, node.critical_wind,
                node.temp_min, node.temp_max, node.seismic_limit,
                meteo.temperature, meteo.wind_speed, meteo.precipitation,
                meteo.storm_probability, meteo.actual_seismicity, meteo.humidity
            )

        node_states.append(schemas.PredictionNodeState(
            node=schemas.NodeOut.from_orm(node),
            latest_meteo=schemas.MeteoDataOut.from_orm(meteo) if meteo else None,
            latest_prediction=schemas.PredictionOut.from_orm(pred) if pred else None,
            calculated_indices=indices
        ))

    edge_states = []
    for edge in edges:
        pred = db.query(models.EdgePrediction)\
                 .filter(models.EdgePrediction.edge_id == edge.id)\
                 .order_by(models.EdgePrediction.timestamp.desc())\
                 .first()
                 
        edge_states.append(schemas.PredictionEdgeState(
            edge=schemas.EdgeOut.from_orm(edge),
            latest_prediction=schemas.EdgePredictionOut.from_orm(pred) if pred else None
        ))

    return schemas.GridState(
        timestamp=timestamp,
        nodes=node_states,
        edges=edge_states
    )

@app.get("/api/predict/history")
def get_prediction_history(db: Session = Depends(database.get_db)):
    """
    Returns unique timestamps of all previous predictions.
    """
    timestamps = db.query(models.Prediction.timestamp)\
                   .distinct()\
                   .order_by(models.Prediction.timestamp.desc())\
                   .all()
    return [t[0] for t in timestamps]

@app.get("/api/predict/node-history/{node_id}", response_model=List[schemas.PredictionOut])
def get_node_prediction_history(node_id: int, db: Session = Depends(database.get_db)):
    """
    Returns historical predictions for a single node (to plot line charts).
    """
    return db.query(models.Prediction)\
             .filter(models.Prediction.node_id == node_id)\
             .order_by(models.Prediction.timestamp.asc())\
             .limit(50)\
             .all()

@app.get("/api/predict/export-pdf")
def export_pdf_report(db: Session = Depends(database.get_db)):
    """
    Generates and returns the PDF document of the current grid state.
    """
    latest_state = get_latest_grid_state(db)
    
    # Format objects to match pdf_generator expected inputs
    grid_state_data = []
    for node_state in latest_state.nodes:
        grid_state_data.append({
            "node": node_state.node,
            "latest_meteo": node_state.latest_meteo,
            "latest_prediction": node_state.latest_prediction,
            "calculated_indices": node_state.calculated_indices
        })

    pdf_filename = "grid_state_report.pdf"
    generate_pdf_report(pdf_filename, grid_state_data, latest_state.edges)
    
    if os.path.exists(pdf_filename):
        return FileResponse(pdf_filename, media_type="application/pdf", filename=pdf_filename)
    else:
        raise HTTPException(status_code=500, detail="Could not generate PDF report")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
