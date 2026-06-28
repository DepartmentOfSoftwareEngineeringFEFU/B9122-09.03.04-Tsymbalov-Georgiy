import os
from celery import Celery
from sqlalchemy.orm import Session
import database
import weather
import models
from gnn_model import GNNPredictor
import asyncio

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

celery_app = Celery(
    "tasks",
    broker=REDIS_URL,
    backend=REDIS_URL
)

# Celery beat schedule configuration
celery_app.conf.beat_schedule = {
    "sync-weather-every-hour": {
        "task": "tasks.sync_weather_and_predict",
        "schedule": 3600.0, # Every hour
    }
}
celery_app.conf.timezone = "Asia/Vladivostok"

@celery_app.task(name="tasks.sync_weather_and_predict")
def sync_weather_and_predict(scenario_type: str = "normal"):
    """
    Background worker task to sync weather and calculate predictions.
    """
    db: Session = database.SessionLocal()
    try:
        # Run weather sync asynchronously
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
        
        loop.run_until_complete(weather.sync_weather_for_nodes(db, scenario_type))
        
        # Calculate GNN prediction
        nodes = db.query(models.Node).all()
        edges = db.query(models.Edge).all()
        
        latest_meteo = {}
        for node in nodes:
            m = db.query(models.MeteoData)\
                  .filter(models.MeteoData.node_id == node.id)\
                  .order_by(models.MeteoData.timestamp.desc())\
                  .first()
            if m:
                latest_meteo[node.id] = m

        predictor = GNNPredictor()
        (probabilities, threat_levels, _, reasons,
         edge_cascade_probabilities, edge_threat_levels, edge_reasons) = predictor.predict(nodes, edges, latest_meteo)

        import datetime
        timestamp = datetime.datetime.utcnow()
        for node_id, cascade_p in probabilities.items():
            level = threat_levels[node_id]
            node_reasons_str = "; ".join(reasons.get(node_id, []))
            db_pred = models.Prediction(
                node_id=node_id,
                timestamp=timestamp,
                probability=probabilities[node_id],
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
        print(f"[Celery] Periodic sync and risk prediction finished successfully at {timestamp}")
        return "Success"
    except Exception as e:
        db.rollback()
        print(f"[Celery] Error in background task: {e}")
        return f"Error: {e}"
    finally:
        db.close()
