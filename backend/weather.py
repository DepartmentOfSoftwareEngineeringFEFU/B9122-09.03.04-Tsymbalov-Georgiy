"""
Weather data module for the Power Grid Monitoring System.

Supports:
  - Real-time weather via OpenWeatherMap /data/2.5/weather
  - 5-day forecast via OpenWeatherMap /data/2.5/forecast (picks closest slot to target_dt)
  - Deterministic scenario simulation as fallback
"""

import os
import random
import aiohttp
from datetime import datetime, timezone
from sqlalchemy.orm import Session
import models

OPENWEATHER_API_KEY = os.getenv("OPENWEATHER_API_KEY", "")

# ─────────────────────────────────────────────────────────────────────────────
# REAL API FETCHERS
# ─────────────────────────────────────────────────────────────────────────────

def _parse_owm_entry(entry: dict) -> dict:
    """Parse a single OWM weather or forecast entry into our internal format."""
    main      = entry.get("main", {})
    wind      = entry.get("wind", {})
    rain      = entry.get("rain", {})
    snow      = entry.get("snow", {})
    weather   = entry.get("weather", [{}])

    precip    = rain.get("1h", rain.get("3h", 0.0)) + snow.get("1h", snow.get("3h", 0.0))
    cond_main = weather[0].get("main", "") if weather else ""
    is_storm  = cond_main == "Thunderstorm"

    return {
        "temperature":       float(main.get("temp", 15.0)),
        "wind_speed":        float(wind.get("speed", 3.0)),
        "precipitation":     float(precip),
        "storm_probability": 1.0 if is_storm else 0.0,
        "humidity":          float(main.get("humidity", 70.0)),
        "actual_seismicity": 0,   # OWM does not provide seismic data
    }


async def fetch_real_weather(lat: float, lon: float, target_dt: datetime | None = None) -> dict:
    """
    Fetch weather for (lat, lon) from OpenWeatherMap.

    If target_dt is provided and is in the future (> now + 1h), uses the
    /forecast endpoint and picks the slot closest to target_dt.
    Otherwise uses the /weather (current) endpoint.

    Returns populated dict on success, empty dict on failure/no key.
    """
    if not OPENWEATHER_API_KEY:
        return {}

    now = datetime.now(tz=timezone.utc)
    use_forecast = (
        target_dt is not None
        and target_dt.tzinfo is not None
        and target_dt > now
    )

    try:
        async with aiohttp.ClientSession() as session:
            if use_forecast:
                # 5-day / 3-hour forecast (free tier)
                url = (
                    f"https://api.openweathermap.org/data/2.5/forecast"
                    f"?lat={lat}&lon={lon}&appid={OPENWEATHER_API_KEY}&units=metric"
                )
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=8)) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        print(f"[OWM Forecast] HTTP {resp.status}: {body[:200]}")
                        return {}
                    data = await resp.json()
                    slots = data.get("list", [])
                    if not slots:
                        return {}
                    # Find slot whose dt is closest to target_dt
                    target_ts = target_dt.timestamp()
                    best = min(slots, key=lambda s: abs(s.get("dt", 0) - target_ts))
                    return _parse_owm_entry(best)
            else:
                # Current weather
                url = (
                    f"https://api.openweathermap.org/data/2.5/weather"
                    f"?lat={lat}&lon={lon}&appid={OPENWEATHER_API_KEY}&units=metric"
                )
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=8)) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        print(f"[OWM Current] HTTP {resp.status}: {body[:200]}")
                        return {}
                    data = await resp.json()
                    return _parse_owm_entry(data)

    except Exception as e:
        print(f"[OWM] Request failed for ({lat}, {lon}): {e}")
        return {}


# ─────────────────────────────────────────────────────────────────────────────
# SIMULATION FALLBACK
# ─────────────────────────────────────────────────────────────────────────────

def generate_simulated_weather(lat: float, lon: float, scenario_type: str = "normal") -> dict:
    """
    Generates realistic weather parameters for a given scenario.
    Scenarios: "normal", "storm", "hurricane", "ice", "seismic".
    """
    if scenario_type == "normal":
        temp     = random.uniform(5.0, 32.0)
        wind     = random.uniform(0.5, 12.0)
        precip   = random.uniform(0.0, 3.0) if random.random() > 0.6 else 0.0
        storm    = 0.0
        seismic  = 0
        humidity = random.uniform(40.0, 90.0)

    elif scenario_type == "storm":
        temp     = random.uniform(8.0, 28.0)
        wind     = random.uniform(10.0, 25.0)
        precip   = random.uniform(3.0, 20.0)
        storm    = 1.0
        seismic  = 0
        humidity = random.uniform(75.0, 100.0)

    elif scenario_type == "hurricane":
        temp     = random.uniform(5.0, 24.0)
        wind     = random.uniform(24.0, 45.0)
        precip   = random.uniform(10.0, 50.0)
        storm    = 0.0
        seismic  = 0
        humidity = random.uniform(80.0, 100.0)

    elif scenario_type == "ice":
        temp     = random.uniform(-10.0, 3.0)
        wind     = random.uniform(2.0, 16.0)
        precip   = random.uniform(1.0, 10.0)
        storm    = 0.0
        seismic  = 0
        humidity = random.uniform(80.0, 100.0)

    elif scenario_type == "seismic":
        temp     = random.uniform(5.0, 28.0)
        wind     = random.uniform(0.5, 10.0)
        precip   = 0.0
        storm    = 0.0
        seismic  = random.randint(3, 11)
        humidity = random.uniform(30.0, 70.0)

    else:
        temp     = 15.0
        wind     = 3.0
        precip   = 0.0
        storm    = 0.0
        seismic  = 0
        humidity = 65.0

    return {
        "temperature":       round(temp, 1),
        "wind_speed":        round(wind, 1),
        "precipitation":     round(precip, 2),
        "storm_probability": round(storm, 2),
        "actual_seismicity": seismic,
        "humidity":          round(humidity, 1),
    }


# ─────────────────────────────────────────────────────────────────────────────
# MAIN SYNC FUNCTION
# ─────────────────────────────────────────────────────────────────────────────

async def sync_weather_for_nodes(
    db: Session,
    scenario_type: str = "normal",
    use_real_weather: bool = False,
    forecast_dt: datetime | None = None,
) -> datetime:
    """
    Syncs weather records for all active nodes.

    Parameters
    ----------
    scenario_type    : fallback simulation scenario if real API is off or fails
    use_real_weather : fetch from OpenWeatherMap if True
    forecast_dt      : target forecast datetime (UTC, tz-aware).
                       If provided and in the future → uses /forecast endpoint.
                       If None or in the past → uses current weather.

    Returns the timestamp used for all records in this sync batch.
    """
    nodes     = db.query(models.Node).all()
    timestamp = datetime.utcnow()

    ok_count   = 0
    fail_count = 0

    for node in nodes:
        meteo_data: dict = {}

        if use_real_weather:
            meteo_data = await fetch_real_weather(node.latitude, node.longitude, forecast_dt)
            if meteo_data:
                ok_count += 1
            else:
                fail_count += 1

        # Fallback to simulation if real data not requested or failed
        if not meteo_data:
            meteo_data = generate_simulated_weather(node.latitude, node.longitude, scenario_type)

        db_meteo = models.MeteoData(
            node_id           = node.id,
            timestamp         = timestamp,
            temperature       = meteo_data["temperature"],
            wind_speed        = meteo_data["wind_speed"],
            precipitation     = meteo_data["precipitation"],
            storm_probability = meteo_data["storm_probability"],
            actual_seismicity = meteo_data["actual_seismicity"],
            humidity          = meteo_data["humidity"],
        )
        db.add(db_meteo)

    db.commit()

    if use_real_weather:
        total = len(nodes)
        print(
            f"[Weather Sync] Real API: {ok_count}/{total} nodes OK, "
            f"{fail_count} fell back to simulation. "
            f"forecast_dt={forecast_dt}"
        )

    return timestamp
