import React from 'react';
import { MapContainer, TileLayer, Marker, Polyline, Popup, useMapEvents } from 'react-leaflet';
import L from 'leaflet';

// Types matching backend schemas
interface NodeData {
  id: number;
  name: string;
  type: string;
  latitude: number;
  longitude: number;
  wear: number;
  nominal_power: number;
  reserve_power: number;
  temp_min: number;
  temp_max: number;
  seismic_limit: number;
  critical_wind: number;
  forestry: number;
  soil_stability: number;
  animal_hazard: number;
}

interface MeteoData {
  id: number;
  node_id: number;
  timestamp: string;
  temperature: number;
  wind_speed: number;
  precipitation: number;
  storm_probability: number;
  actual_seismicity: number;
  humidity: number;
}

interface PredictionData {
  id?: number;
  node_id?: number;
  timestamp?: string;
  probability: number;
  threat_level: string;
  cascade_probability: number;
  reasons?: string;
}

interface PredictionNodeState {
  node: NodeData;
  latest_meteo: MeteoData | null;
  latest_prediction: PredictionData | null;
  calculated_indices: {
    ice_index?: number;
    effective_wind?: number;
    complex_danger?: number;
  };
}

interface EdgePredictionData {
  id?: number;
  edge_id?: number;
  timestamp?: string;
  probability: number;
  threat_level: string;
  cascade_probability: number;
  reasons?: string;
}

interface EdgeData {
  id: number;
  source_id: number;
  target_id: number;
  type: string;
  length: number;
  capacity: number;
  animal_hazard: number;
  latest_prediction?: EdgePredictionData | null;
}

interface MapProps {
  nodes: PredictionNodeState[];
  edges: EdgeData[];
  selectedNodeId: number | null;
  onSelectNode: (id: number | null) => void;
  selectedEdgeId?: number | null;
  onSelectEdge?: (id: number | null) => void;
  onMapClick?: (lat: number, lng: number) => void;
  clickedCoords?: [number, number] | null;
}

// Listen for clicks on the map to select coordinates
const MapEventsHandler: React.FC<{ onClick?: (lat: number, lng: number) => void }> = ({ onClick }) => {
  useMapEvents({
    click(e) {
      if (onClick) {
        onClick(e.latlng.lat, e.latlng.lng);
      }
    }
  });
  return null;
};

export const Map: React.FC<MapProps> = ({ nodes, edges, selectedNodeId, onSelectNode, selectedEdgeId, onSelectEdge, onMapClick, clickedCoords }) => {
  // Center of Vladivostok by default if no nodes
  const defaultCenter: [number, number] = [43.1939, 131.9056];
  
  // Calculate center of all nodes to make it look great
  const center: [number, number] = nodes.length > 0
    ? [
        nodes.reduce((sum, n) => sum + n.node.latitude, 0) / nodes.length,
        nodes.reduce((sum, n) => sum + n.node.longitude, 0) / nodes.length,
      ]
    : defaultCenter;

  // Render a custom glowing marker using Leaflet divIcon
  const createCustomIcon = (state: PredictionNodeState, isSelected: boolean) => {
    const level = state.latest_prediction?.threat_level || 'green';
    const isRed = level === 'red';
    
    // Choose color
    let color = '#10b981'; // green
    if (level === 'yellow') color = '#f59e0b';
    if (level === 'red') color = '#ef4444';

    const selectedStyle = isSelected ? 'border: 2px solid #fff; box-shadow: 0 0 15px #fff, 0 0 10px ' + color : '';

    const html = `
      <div style="
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: rgba(10, 14, 23, 0.7);
        border: 1.5px solid ${color};
        position: relative;
        ${selectedStyle}
      ">
        <div class="${isRed ? 'pulse-red' : ''}" style="
          width: 12px;
          height: 12px;
          border-radius: 50%;
          background: ${color};
          box-shadow: 0 0 8px ${color};
        "></div>
      </div>
    `;

    return L.divIcon({
      html: html,
      className: 'custom-node-icon',
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
  };

  const createTempIcon = () => {
    return L.divIcon({
      html: `
        <div style="
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background: rgba(56, 189, 248, 0.15);
          border: 2.5px dashed #38bdf8;
          box-shadow: 0 0 10px rgba(56, 189, 248, 0.4);
        ">
          <div style="width: 8px; height: 8px; border-radius: 50%; background: #38bdf8; box-shadow: 0 0 5px #38bdf8;"></div>
        </div>
      `,
      className: 'temp-click-icon',
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });
  };

  // Build edge line style
  const getEdgeStyle = (edge: EdgeData) => {
    const prob = edge.latest_prediction?.cascade_probability || 0;
    const isSelected = edge.id === selectedEdgeId;

    let color = 'rgba(56, 189, 248, 0.65)'; // default cyan (green/blue)
    if (prob > 0.4 && prob <= 0.7) {
      color = 'rgba(245, 158, 11, 0.85)'; // yellow
    } else if (prob > 0.7) {
      color = 'rgba(239, 68, 68, 0.95)'; // red
    } else if (edge.latest_prediction?.threat_level === 'green') {
      color = 'rgba(16, 185, 129, 0.8)'; // green
    }

    if (isSelected) {
      color = '#ffffff'; // White color for selected edge to stand out
    }

    const isReserve = edge.type === 'reserve';

    return {
      color: color,
      weight: isSelected ? 7.0 : (prob > 0.7 ? 5.0 : isReserve ? 2 : 3.5),
      dashArray: isReserve ? '5, 8' : undefined,
      opacity: isSelected ? 1.0 : 0.85
    };
  };

  return (
    <div className="map-container">
      <MapContainer
        center={center}
        zoom={12}
        style={{ height: '100%', width: '100%' }}
        zoomControl={true}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {/* Render Lines (LEPs) */}
        {edges.map((edge) => {
          const sourceNode = nodes.find(n => n.node.id === edge.source_id);
          const targetNode = nodes.find(n => n.node.id === edge.target_id);

          if (!sourceNode || !targetNode) return null;

          const positions: [number, number][] = [
            [sourceNode.node.latitude, sourceNode.node.longitude],
            [targetNode.node.latitude, targetNode.node.longitude]
          ];

          const lineStyle = getEdgeStyle(edge);

          return (
            <Polyline
              key={`edge-${edge.id}`}
              positions={positions}
              pathOptions={lineStyle}
              eventHandlers={{
                click: () => {
                  onSelectEdge?.(edge.id);
                  onSelectNode(null);
                }
              }}
            >
              <Popup>
                <div style={{ fontSize: '0.85rem', minWidth: '180px' }}>
                  <h4 style={{ fontWeight: 600, marginBottom: '5px' }}>Линия ЛЭП ({edge.type})</h4>
                  <p><b>Длина:</b> {edge.length} км</p>
                  <p><b>Пропускная способность:</b> {edge.capacity} МВт</p>
                  <p><b>Опасность птиц/животных:</b> {edge.animal_hazard}</p>
                  <hr style={{ margin: '8px 0', borderTop: '1px solid rgba(255,255,255,0.1)' }} />
                  {edge.latest_prediction ? (
                    <>
                      <p>
                        <b>Уровень угрозы:</b>{' '}
                        <span className={`badge badge-${edge.latest_prediction.threat_level}`}>
                          {edge.latest_prediction.threat_level === 'red' ? 'Критический' :
                           edge.latest_prediction.threat_level === 'yellow' ? 'Внимание' : 'Норма'}
                        </span>
                      </p>
                      <p><b>Вероятность аварии:</b> {Math.round(edge.latest_prediction.cascade_probability * 100)}%</p>
                      {edge.latest_prediction.reasons && (
                        <div style={{ marginTop: '5px', fontSize: '0.75rem', color: '#fca5a5' }}>
                          <b>Причины:</b>
                          <ul style={{ margin: '3px 0 0 12px', padding: 0 }}>
                            {edge.latest_prediction.reasons.split('; ').filter(Boolean).map((r, i) => (
                              <li key={i}>{r}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </>
                  ) : (
                    <p style={{ color: '#9ca3af', fontStyle: 'italic' }}>Прогноз не рассчитан</p>
                  )}
                </div>
              </Popup>
            </Polyline>
          );
        })}

        {/* Render Node Markers */}
        {nodes.map((state) => {
          const lat = state.node.latitude;
          const lon = state.node.longitude;

          if (lat === 0 || lon === 0) return null;

          const icon = createCustomIcon(state, state.node.id === selectedNodeId);

          return (
            <Marker
              key={`node-${state.node.id}`}
              position={[lat, lon]}
              icon={icon}
              eventHandlers={{
                click: () => {
                  onSelectNode(state.node.id);
                  onSelectEdge?.(null);
                }
              }}
            >
              <Popup>
                <div style={{ fontSize: '0.85rem' }}>
                  <h4 style={{ fontWeight: 600, marginBottom: '5px' }}>{state.node.name}</h4>
                  <p>Тип: {state.node.type === 'generation' ? 'Генерация' : state.node.type === 'substation' ? 'Подстанция' : 'Узел ЛЭП'}</p>
                  <p>Риск: {state.latest_prediction ? `${roundValue(state.latest_prediction.cascade_probability * 100, 1)}%` : 'Нет прогноза'}</p>
                  <p style={{ fontStyle: 'italic', marginTop: '5px', fontSize: '0.75rem', color: '#9ca3af' }}>Кликните для деталей на панели</p>
                </div>
              </Popup>
            </Marker>
          );
        })}

        {/* Temporary Click coordinates marker */}
        {clickedCoords && clickedCoords[0] !== 0 && clickedCoords[1] !== 0 && (
          <Marker position={clickedCoords} icon={createTempIcon()}>
            <Popup>
              <div style={{ fontSize: '0.8rem', textAlign: 'center' }}>
                <span style={{ fontWeight: 600 }}>Выбранные координаты</span><br/>
                {clickedCoords[0].toFixed(4)}, {clickedCoords[1].toFixed(4)}
              </div>
            </Popup>
          </Marker>
        )}

        <MapEventsHandler onClick={onMapClick} />
      </MapContainer>
    </div>
  );
};

// Simple helper
function roundValue(val: number, decimals: number) {
  return Number(val.toFixed(decimals));
}
