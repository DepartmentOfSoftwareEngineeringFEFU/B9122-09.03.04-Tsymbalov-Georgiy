import React, { useState, useEffect } from 'react';
import { 
  Zap, Activity, Wind, Thermometer, 
  CloudRain, ShieldAlert, FileText, Plus, Trash2, RefreshCw, 
  LogOut, Info, Eye, Radio, Edit, Users, Download, Upload, Cpu, Wifi
} from 'lucide-react';
import { Map } from './Map';

// Interfaces matching types
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
  id: number;
  node_id: number;
  timestamp: string;
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
  probability: number;
  threat_level: string;
  cascade_probability: number;
  reasons: string;
}

interface EdgeData {
  id: number;
  source_id: number;
  target_id: number;
  type: string;
  length: number;
  capacity: number;
  animal_hazard: number;
  forestry: number;
  critical_wind: number;
  latest_prediction?: EdgePredictionData | null;
}

interface DashboardProps {
  onLogout: () => void;
  username: string;
  role: string;
}

export const Dashboard: React.FC<DashboardProps> = ({ onLogout, username, role }) => {
  const isAdmin = role === 'admin';
  
  const [nodes, setNodes] = useState<PredictionNodeState[]>([]);
  const [edges, setEdges] = useState<EdgeData[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<number | null>(null);
  const [editEdge, setEditEdge] = useState<EdgeData | null>(null);
  
  // Scenarios and actions state
  const [weatherScenario, setWeatherScenario] = useState<string>('normal');
  const [weatherSourceMode, setWeatherSourceMode] = useState<'simulated' | 'real'>('simulated');
  const [weatherApiTestResult, setWeatherApiTestResult] = useState<{status: string; message: string; api_data: Record<string,unknown> | null} | null>(null);
  // Default forecast date: tomorrow at noon UTC
  const [forecastDate, setForecastDate] = useState<string>(() => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(12, 0, 0, 0);
    return d.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM" for datetime-local input
  });
  const [loading, setLoading] = useState<boolean>(true);
  const [actionLoading, setActionLoading] = useState<boolean>(false);


  // Time States
  const [currentTime, setCurrentTime] = useState<string>('');
  const [predictionTime, setPredictionTime] = useState<string>('');

  // Helper to parse naive UTC dates from backend into local browser timezone
  const parseBackendDate = (ts: string) => {
    if (!ts) return new Date();
    const normalized = (ts.endsWith('Z') || ts.includes('+')) ? ts : ts + 'Z';
    return new Date(normalized);
  };

  // Coords Catcher State
  const [clickedCoords, setClickedCoords] = useState<[number, number] | null>(null);

  // User list state for Admins
  const [users, setUsers] = useState<any[]>([]);
  const [newUserForm, setNewUserForm] = useState({
    username: '',
    email: '',
    password: '',
    role: 'dispatcher'
  });

  // Forms states
  const [leftTab, setLeftTab] = useState<'list' | 'add_node' | 'edit_node' | 'add_edge' | 'edit_edge' | 'users' | 'debug'>('list');
  
  const [newNode, setNewNode] = useState({
    name: '',
    type: 'substation',
    latitude: 43.12,
    longitude: 131.92,
    wear: 10,
    nominal_power: 100,
    reserve_power: 10,
    temp_min: -40,
    temp_max: 40,
    seismic_limit: 7,
    critical_wind: 25.0,
    forestry: 0.0,
    soil_stability: 0.9,
    animal_hazard: 0.0
  });

  const [editNode, setEditNode] = useState<NodeData | null>(null);

  const [newEdge, setNewEdge] = useState<{
    source_id: number | '';
    target_id: number | '';
    type: string;
    length: number;
    capacity: number;
    animal_hazard: number;
    forestry: number;
    critical_wind: number;
  }>({
    source_id: '',
    target_id: '',
    type: 'LEP_110',
    length: 5,
    capacity: 150,
    animal_hazard: 0.1,
    forestry: 0.0,
    critical_wind: 25.0
  });

  // Filter states
  const [filterType, setFilterType] = useState<string>('all');
  const [filterThreat, setFilterThreat] = useState<string>('all');

  // Helper for Authorization Headers
  const getAuthHeaders = (): Record<string, string> => {
    const token = localStorage.getItem('access_token');
    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  };

  // Clock Timer
  useEffect(() => {
    const timer = setInterval(() => {
      const date = new Date();
      setCurrentTime(date.toLocaleDateString() + ' ' + date.toLocaleTimeString());
    }, 1000);
    
    const date = new Date();
    setCurrentTime(date.toLocaleDateString() + ' ' + date.toLocaleTimeString());
    return () => clearInterval(timer);
  }, []);

  // Distance calculator (Haversine Formula)
  const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371; // Radius of Earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distance = R * c;
    return Number(distance.toFixed(2));
  };

  // Auto calculate length when source/target changes in newEdge
  useEffect(() => {
    if (newEdge.source_id && newEdge.target_id) {
      const sourceNode = nodes.find(n => n.node.id === newEdge.source_id)?.node;
      const targetNode = nodes.find(n => n.node.id === newEdge.target_id)?.node;
      if (sourceNode && targetNode) {
        const length = calculateDistance(
          sourceNode.latitude, sourceNode.longitude,
          targetNode.latitude, targetNode.longitude
        );
        setNewEdge(prev => ({ ...prev, length }));
      }
    }
  }, [newEdge.source_id, newEdge.target_id, nodes]);

  // Fetch users list when leftTab switches to 'users'
  useEffect(() => {
    if (leftTab === 'users' && isAdmin) {
      fetchUsers();
    }
  }, [leftTab]);

  const fetchGridState = async () => {
    try {
      const response = await fetch('/api/predict/latest');
      if (response.ok) {
        const data = await response.json();
        setNodes(data.nodes);
        
        // Map PredictionEdgeState[] to EdgeData[]
        const mappedEdges = (data.edges || []).map((es: any) => ({
          ...es.edge,
          latest_prediction: es.latest_prediction
        }));
        setEdges(mappedEdges);
        
        if (data.timestamp) {
          setPredictionTime(parseBackendDate(data.timestamp).toLocaleString());
        }
        
        // Auto select first node if nothing is selected
        if (data.nodes.length > 0 && !selectedNodeId && !selectedEdgeId) {
          setSelectedNodeId(data.nodes[0].node.id);
        }
      }
    } catch (e) {
      console.error('Failed to fetch grid state', e);
    } finally {
      setLoading(false);
    }
  };



  const fetchUsers = async () => {
    try {
      const response = await fetch('/api/users', {
        headers: getAuthHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        setUsers(data);
      }
    } catch (e) {
      console.error('Failed to fetch users list', e);
    }
  };

  useEffect(() => {
    fetchGridState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);



  const handleSyncWeather = async () => {
    setActionLoading(true);
    try {
      const isReal = weatherSourceMode === 'real';
      // Build forecast_date param: use ISO string with Z suffix for UTC
      const forecastParam = (isReal && forecastDate)
        ? `&forecast_date=${encodeURIComponent(forecastDate + ':00Z')}`
        : '';
      const res = await fetch(
        `/api/weather/sync?scenario=${weatherScenario}&use_real_weather=${isReal}${forecastParam}`,
        { method: 'POST', headers: getAuthHeaders() }
      );
      if (res.ok) {
        await fetch('/api/predict', { method: 'POST', headers: getAuthHeaders() });
        await fetchGridState();
      }
    } catch (e) {
      console.error(e);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSyncRealWeather = async () => {
    setActionLoading(true);
    try {
      const forecastParam = forecastDate
        ? `&forecast_date=${encodeURIComponent(forecastDate + ':00Z')}`
        : '';
      const res = await fetch(
        `/api/weather/sync?scenario=normal&use_real_weather=true${forecastParam}`,
        { method: 'POST', headers: getAuthHeaders() }
      );
      if (res.ok) {
        await fetch('/api/predict', { method: 'POST', headers: getAuthHeaders() });
        await fetchGridState();
      }
    } catch (e) {
      console.error(e);
    } finally {
      setActionLoading(false);
    }
  };

  const handleTestWeatherApi = async () => {
    setActionLoading(true);
    setWeatherApiTestResult(null);
    try {
      const forecastParam = forecastDate
        ? `?forecast_date=${encodeURIComponent(forecastDate + ':00Z')}`
        : '';
      const res = await fetch(`/api/weather/test${forecastParam}`, { headers: getAuthHeaders() });
      const data = await res.json();
      setWeatherApiTestResult(data);
    } catch (e) {
      setWeatherApiTestResult({ status: 'error', message: 'Ошибка сети: не удалось подключиться к серверу', api_data: null });
    } finally {
      setActionLoading(false);
    }
  };

  const handleRunPrediction = async () => {
    setActionLoading(true);
    try {
      const res = await fetch('/api/predict', { 
        method: 'POST',
        headers: getAuthHeaders()
      });
      if (res.ok) {
        await fetchGridState();
      }
    } catch (e) {
      console.error(e);
    } finally {
      setActionLoading(false);
    }
  };

  const handleTrainModel = async () => {
    setActionLoading(true);
    try {
      const res = await fetch('/api/predict/train', { 
        method: 'POST',
        headers: getAuthHeaders()
      });
      if (res.ok) {
        alert('GNN модель успешно обучена на 40,000 синтетических сценариев и сохранена!');
        await handleRunPrediction();
      }
    } catch (e) {
      console.error(e);
      alert('Ошибка при обучении модели (необходим запущенный бэкенд на Python с PyTorch)');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCreateNode = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionLoading(true);
    try {
      const res = await fetch('/api/grid/nodes', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify(newNode)
      });
      if (res.ok) {
        // Run initial weather & predictions for this node
        await fetch('/api/weather/sync', { 
          method: 'POST',
          headers: getAuthHeaders()
        });
        await fetch('/api/predict', { 
          method: 'POST',
          headers: getAuthHeaders()
        });
        await fetchGridState();
        setLeftTab('list');
        setClickedCoords(null);
        setNewNode({
          name: '',
          type: 'substation',
          latitude: 43.12,
          longitude: 131.92,
          wear: 10,
          nominal_power: 100,
          reserve_power: 10,
          temp_min: -40,
          temp_max: 40,
          seismic_limit: 7,
          critical_wind: 25.0,
          forestry: 0.0,
          soil_stability: 0.9,
          animal_hazard: 0.0
        });
      } else {
        const errData = await res.json();
        alert(`Ошибка при создании объекта: ${errData.detail}`);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleUpdateNode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editNode) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/grid/nodes/${editNode.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify(editNode)
      });
      if (res.ok) {
        await fetch('/api/predict', { 
          method: 'POST',
          headers: getAuthHeaders()
        });
        await fetchGridState();
        setLeftTab('list');
        setEditNode(null);
        setClickedCoords(null);
      } else {
        const errData = await res.json();
        alert(`Ошибка при сохранении объекта: ${errData.detail}`);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleCreateEdge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newEdge.source_id || !newEdge.target_id) {
      alert('Пожалуйста, выберите оба энергообъекта (Источник и Назначение).');
      return;
    }
    setActionLoading(true);
    try {
      const res = await fetch('/api/grid/edges', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify(newEdge)
      });
      if (res.ok) {
        await fetch('/api/predict', { 
          method: 'POST',
          headers: getAuthHeaders()
        });
        await fetchGridState();
        setLeftTab('list');
        setNewEdge({
          source_id: '',
          target_id: '',
          type: 'LEP_110',
          length: 5,
          capacity: 150,
          animal_hazard: 0.1,
          forestry: 0.0,
          critical_wind: 25.0
        });
      } else {
        const errData = await res.json();
        alert(`Ошибка при создании линии: ${errData.detail}`);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteNode = async (id: number) => {
    if (!window.confirm('Вы действительно хотите удалить этот энергообъект?')) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/grid/nodes/${id}`, { 
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      if (res.ok) {
        setSelectedNodeId(null);
        await fetch('/api/predict', { 
          method: 'POST',
          headers: getAuthHeaders()
        });
        await fetchGridState();
      } else {
        const errData = await res.json();
        alert(`Ошибка при удалении: ${errData.detail}`);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteEdge = async (id: number) => {
    if (!window.confirm('Вы действительно хотите удалить эту линию связи?')) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/grid/edges/${id}`, { 
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      if (res.ok) {
        setSelectedEdgeId(null);
        await fetch('/api/predict', { 
          method: 'POST',
          headers: getAuthHeaders()
        });
        await fetchGridState();
      } else {
        const errData = await res.json();
        alert(`Ошибка при удалении: ${errData.detail}`);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleUpdateEdge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editEdge) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/grid/edges/${editEdge.id}`, { 
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify(editEdge)
      });
      if (res.ok) {
        await fetch('/api/predict', { 
          method: 'POST',
          headers: getAuthHeaders()
        });
        await fetchGridState();
        setLeftTab('list');
        setEditEdge(null);
      } else {
        const errData = await res.json();
        alert(`Ошибка при изменении линии: ${errData.detail}`);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleEditEdgeClick = (edge: EdgeData) => {
    setEditEdge({ ...edge });
    setLeftTab('edit_edge');
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionLoading(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders()
        },
        body: JSON.stringify(newUserForm)
      });
      if (res.ok) {
        alert('Пользователь успешно добавлен!');
        setNewUserForm({
          username: '',
          email: '',
          password: '',
          role: 'dispatcher'
        });
        fetchUsers();
      } else {
        const errData = await res.json();
        alert(`Ошибка при создании пользователя: ${errData.detail}`);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleDeleteUser = async (id: number) => {
    if (!window.confirm('Вы действительно хотите удалить этого пользователя?')) return;
    setActionLoading(true);
    try {
      const res = await fetch(`/api/users/${id}`, {
        method: 'DELETE',
        headers: getAuthHeaders()
      });
      if (res.ok) {
        fetchUsers();
      } else {
        const errData = await res.json();
        alert(`Ошибка при удалении пользователя: ${errData.detail}`);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setActionLoading(false);
    }
  };

  const handleExportPDF = () => {
    window.open('/api/predict/export-pdf', '_blank');
  };

  const handleExportGridJSON = async () => {
    try {
      const res = await fetch('/api/grid/export');
      if (res.ok) {
        const data = await res.json();
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data, null, 2));
        const downloadAnchor = document.createElement('a');
        downloadAnchor.setAttribute("href", dataStr);
        downloadAnchor.setAttribute("download", "grid_topology.json");
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();
      }
    } catch (err) {
      console.error('Failed to export grid JSON', err);
    }
  };

  const handleImportGridJSON = (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileReader = new FileReader();
    const file = e.target.files?.[0];
    if (!file) return;

    fileReader.onload = async (event) => {
      try {
        const parsedData = JSON.parse(event.target?.result as string);
        setActionLoading(true);
        const token = localStorage.getItem('access_token');
        const res = await fetch('/api/grid/import', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(parsedData)
        });

        if (res.ok) {
          alert('Топология сети успешно импортирована!');
          await fetchGridState();
          setSelectedNodeId(null);
          setClickedCoords(null);
        } else {
          const errData = await res.json();
          alert(`Ошибка импорта: ${errData.detail}`);
        }
      } catch (err: any) {
        alert(`Неверный формат файла JSON: ${err.message}`);
      } finally {
        setActionLoading(false);
        e.target.value = '';
      }
    };
    fileReader.readAsText(file);
  };

  // Map Click Coordinator
  const handleMapClick = (lat: number, lng: number) => {
    setClickedCoords([lat, lng]);
    if (leftTab === 'add_node') {
      setNewNode(prev => ({
        ...prev,
        latitude: Number(lat.toFixed(4)),
        longitude: Number(lng.toFixed(4))
      }));
    } else if (leftTab === 'edit_node' && editNode) {
      setEditNode(prev => prev ? ({
        ...prev,
        latitude: Number(lat.toFixed(4)),
        longitude: Number(lng.toFixed(4))
      }) : null);
    }
  };

  const handleEditClick = (node: NodeData) => {
    setEditNode({ ...node });
    setClickedCoords([node.latitude, node.longitude]);
    setLeftTab('edit_node');
  };

  // Reasons stats aggregator
  const getReasonsStats = () => {
    const stats = { gnn: 0, wind: 0, wear: 0, seismic: 0, storm: 0, cascade: 0 };
    const total = nodes.length;
    if (total === 0) {
      return {
        gnn: { count: 0, pct: 0 },
        wind: { count: 0, pct: 0 },
        wear: { count: 0, pct: 0 },
        seismic: { count: 0, pct: 0 },
        storm: { count: 0, pct: 0 },
        cascade: { count: 0, pct: 0 }
      };
    }

    nodes.forEach(n => {
      const reasonsStr = n.latest_prediction?.reasons || '';
      if (reasonsStr.includes('GNN:')) stats.gnn++;
      if (reasonsStr.includes('ветра') || reasonsStr.includes('ветровая')) stats.wind++;
      if (reasonsStr.includes('износ')) stats.wear++;
      if (reasonsStr.includes('сейсмического')) stats.seismic++;
      if (reasonsStr.includes('Грозовая')) stats.storm++;
      if (reasonsStr.includes('каскад') || reasonsStr.includes('Каскад')) stats.cascade++;
    });

    return {
      gnn: { count: stats.gnn, pct: Math.round((stats.gnn / total) * 100) },
      wind: { count: stats.wind, pct: Math.round((stats.wind / total) * 100) },
      wear: { count: stats.wear, pct: Math.round((stats.wear / total) * 100) },
      seismic: { count: stats.seismic, pct: Math.round((stats.seismic / total) * 100) },
      storm: { count: stats.storm, pct: Math.round((stats.storm / total) * 100) },
      cascade: { count: stats.cascade, pct: Math.round((stats.cascade / total) * 100) }
    };
  };

  // Filter logic
  const filteredNodes = nodes.filter(n => {
    const matchesType = filterType === 'all' || n.node.type === filterType;
    const matchesThreat = filterThreat === 'all' || (n.latest_prediction?.threat_level || 'green') === filterThreat;
    return matchesType && matchesThreat;
  });

  const selectedNodeState = nodes.find(n => n.node.id === selectedNodeId);
  const selectedEdgeState = edges.find(e => e.id === selectedEdgeId);
  const stats = getReasonsStats();

  if (loading) {
    return (
      <div className="loading-container">
        <div className="spinner"></div>
        <h2 style={{ border: 'none', padding: 0 }}>Загрузка энергосети...</h2>
      </div>
    );
  }

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="app-title">
          <span>Система мониторинга и прогнозирования аварий электросети</span>
        </div>
        
        {/* Time plaque badge */}
        <div className="time-plaque" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div className="time-plaque-item">
            <span className="time-plaque-label">Текущее время</span>
            <span className="time-plaque-value">{currentTime}</span>
          </div>
          <div className="time-plaque-item" style={{ borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: '12px' }}>
            <span className="time-plaque-label">Срез расчета GNN</span>
            <span className="time-plaque-value" style={{ color: '#ef4444' }}>{predictionTime || 'Нет прогноза'}</span>
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', borderLeft: '1px solid rgba(255,255,255,0.1)', paddingLeft: '12px' }}>
            <span className="time-plaque-label" style={{ display: 'block', marginRight: '4px' }}>Прогноз (UTC)</span>
            <input
              type="datetime-local"
              value={forecastDate}
              onChange={(e) => setForecastDate(e.target.value)}
              disabled={actionLoading}
              min={new Date().toISOString().slice(0, 16)}
              max={new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString().slice(0, 16)}
              style={{
                background: 'rgba(0, 0, 0, 0.3)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '4px',
                color: 'var(--text-main)',
                padding: '2px 6px',
                fontSize: '0.75rem',
                fontFamily: 'monospace',
                height: '24px',
                outline: 'none',
                width: '180px'
              }}
            />
          </div>

          <button 
            className="btn" 
            style={{ 
              padding: '4px 10px', 
              fontSize: '0.75rem', 
              height: '26px', 
              display: 'flex', 
              alignItems: 'center', 
              gap: '4px',
              borderRadius: '4px',
              border: '1px solid rgba(56, 189, 248, 0.3)',
              background: 'rgba(56, 189, 248, 0.1)',
              color: '#38bdf8',
              width: 'auto'
            }} 
            onClick={handleSyncRealWeather}
            disabled={actionLoading}
            title="Запросить погодные данные по API на выбранное время и пересчитать риски"
          >
            <RefreshCw size={12} className={actionLoading ? 'logo-spin' : ''} />
            <span>Обновить погоду</span>
          </button>

          <button 
            className="btn btn-primary" 
            style={{ 
              padding: '4px 10px', 
              fontSize: '0.75rem', 
              height: '26px', 
              display: 'flex', 
              alignItems: 'center', 
              gap: '4px',
              borderRadius: '4px',
              border: 'none',
              background: 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)',
              width: 'auto'
            }} 
            onClick={handleRunPrediction}
            disabled={actionLoading}
            title="Рассчитать вероятности аварии по всей сети"
          >
            <Activity size={12} className={actionLoading ? 'logo-spin' : ''} />
            <span>Рассчитать риски</span>
          </button>
        </div>

        <div className="flex-row">
          <div className="user-badge">
            <Radio size={14} style={{ color: role === 'admin' ? '#ef4444' : '#10b981' }} />
            <span>
              {role === 'admin' ? 'Администратор' : 'Диспетчер'}: <b style={{ color: '#38bdf8' }}>{username}</b>
            </span>
          </div>
          <button className="btn btn-icon" onClick={onLogout} title="Выход">
            <LogOut size={16} />
          </button>
        </div>
      </header>

      {/* Main Workspace */}
      <main className="workspace-grid">
        {/* Left Panel: Navigation & Actions */}
        <aside className="sidebar-left glass-panel">
          {/* Operations Menu */}
          <section className="glass-card" style={{ marginBottom: '20px' }}>
            <h2>Отчеты и экспорт</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <button 
                className="btn btn-primary" 
                onClick={handleExportPDF} 
                disabled={actionLoading}
                style={{ width: '100%' }}
              >
                <FileText size={14} style={{ marginRight: '6px' }} />
                Экспорт отчета PDF
              </button>
              
              <div style={{ display: 'flex', gap: '8px' }}>
                <button 
                  className="btn" 
                  onClick={handleExportGridJSON} 
                  style={{ flex: 1, fontSize: '0.75rem', borderColor: 'rgba(56, 189, 248, 0.2)' }}
                  disabled={actionLoading}
                  type="button"
                >
                  <Download size={12} style={{ marginRight: '4px' }} /> Сохранить
                </button>
                {isAdmin && (
                  <button 
                    className="btn" 
                    onClick={() => document.getElementById('import-grid-file-input')?.click()} 
                    style={{ flex: 1, fontSize: '0.75rem', borderColor: 'rgba(56, 189, 248, 0.2)' }}
                    disabled={actionLoading}
                    type="button"
                  >
                    <Upload size={12} style={{ marginRight: '4px' }} /> Загрузить
                  </button>
                )}
              </div>
            </div>
            
            <input 
              type="file" 
              accept=".json" 
              onChange={handleImportGridJSON} 
              id="import-grid-file-input" 
              style={{ display: 'none' }} 
            />
          </section>

          {/* Grid Tabs */}
          <div className="tab-container">
            <button 
              className={`tab-btn ${leftTab === 'list' ? 'active' : ''}`}
              onClick={() => { setLeftTab('list'); setClickedCoords(null); }}
            >
              Схема сети
            </button>
            {isAdmin && (
              <>
                <button 
                  className={`tab-btn ${leftTab === 'add_node' ? 'active' : ''}`}
                  onClick={() => { setLeftTab('add_node'); setClickedCoords(null); }}
                >
                  + Объект
                </button>
                <button 
                  className={`tab-btn ${leftTab === 'add_edge' ? 'active' : ''}`}
                  onClick={() => { setLeftTab('add_edge'); setClickedCoords(null); }}
                >
                  + Линия
                </button>
                <button 
                  className={`tab-btn ${leftTab === 'users' ? 'active' : ''}`}
                  onClick={() => { setLeftTab('users'); setClickedCoords(null); }}
                >
                  <Users size={12} style={{ display: 'inline', marginRight: '4px', verticalAlign: 'middle' }} />
                  Пользователи
                </button>
                <button 
                  className={`tab-btn ${leftTab === 'debug' ? 'active' : ''}`}
                  onClick={() => { setLeftTab('debug'); setClickedCoords(null); }}
                >
                  Отладка
                </button>
              </>
            )}
            {(leftTab === 'edit_node' || leftTab === 'edit_edge') && (
              <button className="tab-btn active">
                <Edit size={12} style={{ display: 'inline', marginRight: '4px', verticalAlign: 'middle' }} />
                Редактирование
              </button>
            )}
          </div>

          {leftTab === 'list' && (
            <section style={{ display: 'flex', flexDirection: 'column', flexGrow: 1 }}>
              {/* Filters */}
              <div className="grid-columns-2" style={{ marginBottom: '10px' }}>
                <div className="input-group">
                  <label>Фильтр типа</label>
                  <select value={filterType} onChange={(e) => setFilterType(e.target.value)}>
                    <option value="all">Все типы</option>
                    <option value="generation">Генерация</option>
                    <option value="substation">Подстанции</option>
                  </select>
                </div>
                <div className="input-group">
                  <label>Фильтр угрозы</label>
                  <select value={filterThreat} onChange={(e) => setFilterThreat(e.target.value)}>
                    <option value="all">Все риски</option>
                    <option value="green">Норма</option>
                    <option value="yellow">Внимание</option>
                    <option value="red">Критический</option>
                  </select>
                </div>
              </div>

              {/* Node List */}
              <h3 style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '8px' }}>
                ОБЪЕКТЫ ({filteredNodes.length})
              </h3>
              <div className="grid-list" style={{ flexGrow: 1, maxHeight: '200px' }}>
                {filteredNodes.map((n) => {
                  const level = n.latest_prediction?.threat_level || 'green';
                  const p = n.latest_prediction?.cascade_probability || 0;
                  
                  return (
                    <div 
                      key={n.node.id} 
                      className={`grid-list-item ${n.node.id === selectedNodeId ? 'selected' : ''}`}
                      onClick={() => setSelectedNodeId(n.node.id)}
                    >
                      <div className="grid-list-item-title">{n.node.name}</div>
                      <span className={`badge badge-${level}`}>
                        {level === 'red' ? 'Крит' : level === 'yellow' ? 'Вним' : 'Норм'} ({Math.round(p * 100)}%)
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Edge List */}
              <h3 style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '8px', marginTop: '10px' }}>
                ЛИНИИ СВЯЗИ ({edges.length})
              </h3>
              <div className="grid-list" style={{ maxHeight: '130px' }}>
                {edges.map((e) => {
                  const sName = nodes.find(n => n.node.id === e.source_id)?.node.name || `Node ${e.source_id}`;
                  const tName = nodes.find(n => n.node.id === e.target_id)?.node.name || `Node ${e.target_id}`;
                  const level = e.latest_prediction?.threat_level || 'green';
                  const prob = e.latest_prediction?.cascade_probability || 0;
                  return (
                    <div 
                      key={e.id} 
                      className={`grid-list-item ${e.id === selectedEdgeId ? 'selected' : ''}`}
                      onClick={() => {
                        setSelectedEdgeId(e.id);
                        setSelectedNodeId(null);
                      }}
                    >
                      <div style={{ fontSize: '0.75rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {sName} → {tName}
                      </div>
                      <span className={`badge badge-${level}`}>
                        {level === 'red' ? 'Крит' : level === 'yellow' ? 'Вним' : 'Норм'} ({Math.round(prob * 100)}%)
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Aggregated Reasons Statistics Section */}
              <section className="glass-card" style={{ marginTop: '15px', marginBottom: 0 }}>
                <h3 style={{ fontSize: '0.8rem', color: 'var(--text-main)', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '6px' }}>
                  Статистика причин риска по сети
                </h3>
                <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  
                  {/* Physical Wear */}
                  <div className="stat-item">
                    <div className="stat-header">
                      <span className="text-subtle">Физический износ оборудования</span>
                      <span className="bold">{stats.wear.count} узл. ({stats.wear.pct}%)</span>
                    </div>
                    <div className="stat-bar-bg">
                      <div className="stat-bar-fill" style={{ width: `${stats.wear.pct}%`, background: '#ef4444' }}></div>
                    </div>
                  </div>

                  {/* Wind Exceedance */}
                  <div className="stat-item">
                    <div className="stat-header">
                      <span className="text-subtle">Ветровая нагрузка / Ураган</span>
                      <span className="bold">{stats.wind.count} узл. ({stats.wind.pct}%)</span>
                    </div>
                    <div className="stat-bar-bg">
                      <div className="stat-bar-fill" style={{ width: `${stats.wind.pct}%`, background: '#38bdf8' }}></div>
                    </div>
                  </div>

                  {/* Storm lightning */}
                  <div className="stat-item">
                    <div className="stat-header">
                      <span className="text-subtle">Грозовая активность</span>
                      <span className="bold">{stats.storm.count} узл. ({stats.storm.pct}%)</span>
                    </div>
                    <div className="stat-bar-bg">
                      <div className="stat-bar-fill" style={{ width: `${stats.storm.pct}%`, background: '#f59e0b' }}></div>
                    </div>
                  </div>

                  {/* Seismic risks */}
                  <div className="stat-item">
                    <div className="stat-header">
                      <span className="text-subtle">Сейсмические толчки</span>
                      <span className="bold">{stats.seismic.count} узл. ({stats.seismic.pct}%)</span>
                    </div>
                    <div className="stat-bar-bg">
                      <div className="stat-bar-fill" style={{ width: `${stats.seismic.pct}%`, background: '#a855f7' }}></div>
                    </div>
                  </div>

                  {/* Cascade contagion */}
                  <div className="stat-item">
                    <div className="stat-header">
                      <span className="text-subtle">Каскадные отключения (цепные)</span>
                      <span className="bold">{stats.cascade.count} узл. ({stats.cascade.pct}%)</span>
                    </div>
                    <div className="stat-bar-bg">
                      <div className="stat-bar-fill" style={{ width: `${stats.cascade.pct}%`, background: '#ec4899' }}></div>
                    </div>
                  </div>

                  {/* GNN prediction failure */}
                  <div className="stat-item">
                    <div className="stat-header">
                      <span className="text-subtle">Высокий структурный риск (GNN)</span>
                      <span className="bold">{stats.gnn.count} узл. ({stats.gnn.pct}%)</span>
                    </div>
                    <div className="stat-bar-bg">
                      <div className="stat-bar-fill" style={{ width: `${stats.gnn.pct}%`, background: '#10b981' }}></div>
                    </div>
                  </div>

                </div>
              </section>
            </section>
          )}

          {leftTab === 'add_node' && (
            <form onSubmit={handleCreateNode} className="details-list">
              <div className="input-group">
                <label>Название энергообъекта</label>
                <input 
                  type="text" 
                  value={newNode.name} 
                  onChange={(e) => setNewNode({...newNode, name: e.target.value})} 
                  placeholder="ПС Южная-220"
                  required
                />
              </div>
              <div className="input-group">
                <label>Тип объекта</label>
                <select 
                  value={newNode.type} 
                  onChange={(e) => setNewNode({...newNode, type: e.target.value})}
                >
                  <option value="substation">Подстанция</option>
                  <option value="generation">Генерация (ТЭЦ/ГЭС)</option>
                </select>
              </div>

              <div style={{ background: 'rgba(56, 189, 248, 0.08)', border: '1px dashed rgba(56, 189, 248, 0.3)', padding: '10px', borderRadius: '6px', fontSize: '0.75rem', color: '#38bdf8', display: 'flex', gap: '8px', alignItems: 'center' }}>
                <Info size={16} style={{ flexShrink: 0 }} />
                <span>Вы можете кликнуть по карте, чтобы автоматически подставить координаты!</span>
              </div>
              
              <div className="grid-columns-2">
                <div className="input-group">
                  <label>Широта (Lat)</label>
                  <input 
                    type="number" 
                    step="0.0001" 
                    value={newNode.latitude} 
                    onChange={(e) => setNewNode({...newNode, latitude: parseFloat(e.target.value)})} 
                    required
                  />
                </div>
                <div className="input-group">
                  <label>Долгота (Lon)</label>
                  <input 
                    type="number" 
                    step="0.0001" 
                    value={newNode.longitude} 
                    onChange={(e) => setNewNode({...newNode, longitude: parseFloat(e.target.value)})} 
                    required
                  />
                </div>
              </div>

              <div className="grid-columns-2">
                <div className="input-group">
                  <label>Износ (%)</label>
                  <input 
                    type="number" 
                    min="0" max="100"
                    value={newNode.wear} 
                    onChange={(e) => setNewNode({...newNode, wear: parseFloat(e.target.value)})} 
                  />
                </div>
              </div>

              <div className="grid-columns-2">
                <div className="input-group">
                  <label>Мощность (МВт)</label>
                  <input 
                    type="number" 
                    value={newNode.nominal_power} 
                    onChange={(e) => setNewNode({...newNode, nominal_power: parseFloat(e.target.value)})} 
                  />
                </div>
                <div className="input-group">
                  <label>Резерв (МВт)</label>
                  <input 
                    type="number" 
                    value={newNode.reserve_power} 
                    onChange={(e) => setNewNode({...newNode, reserve_power: parseFloat(e.target.value)})} 
                  />
                </div>
              </div>

              <div className="grid-columns-2">
                <div className="input-group">
                  <label>Сейсмо-предел (баллы)</label>
                  <input 
                    type="number" min="1" max="12"
                    value={newNode.seismic_limit} 
                    onChange={(e) => setNewNode({...newNode, seismic_limit: parseInt(e.target.value)})} 
                  />
                </div>
              </div>

              <button type="submit" className="btn btn-primary" style={{ marginTop: '10px' }} disabled={actionLoading}>
                <Plus size={16} /> Добавить объект
              </button>
            </form>
          )}

          {leftTab === 'edit_node' && editNode && (
            <form onSubmit={handleUpdateNode} className="details-list">
              <div className="input-group">
                <label>Название энергообъекта</label>
                <input 
                  type="text" 
                  value={editNode.name} 
                  onChange={(e) => setEditNode({...editNode, name: e.target.value})} 
                  required
                />
              </div>
              <div className="input-group">
                <label>Тип объекта</label>
                <select 
                  value={editNode.type} 
                  onChange={(e) => setEditNode({...editNode, type: e.target.value})}
                >
                  <option value="substation">Подстанция</option>
                  <option value="generation">Генерация (ТЭЦ/ГЭС)</option>
                </select>
              </div>

              <div style={{ background: 'rgba(56, 189, 248, 0.08)', border: '1px dashed rgba(56, 189, 248, 0.3)', padding: '10px', borderRadius: '6px', fontSize: '0.75rem', color: '#38bdf8', display: 'flex', gap: '8px', alignItems: 'center' }}>
                <Info size={16} style={{ flexShrink: 0 }} />
                <span>Вы можете кликнуть по карте для изменения координат этого объекта!</span>
              </div>
              
              <div className="grid-columns-2">
                <div className="input-group">
                  <label>Широта (Lat)</label>
                  <input 
                    type="number" 
                    step="0.0001" 
                    value={editNode.latitude} 
                    onChange={(e) => setEditNode({...editNode, latitude: parseFloat(e.target.value)})} 
                    required
                  />
                </div>
                <div className="input-group">
                  <label>Долгота (Lon)</label>
                  <input 
                    type="number" 
                    step="0.0001" 
                    value={editNode.longitude} 
                    onChange={(e) => setEditNode({...editNode, longitude: parseFloat(e.target.value)})} 
                    required
                  />
                </div>
              </div>

              <div className="grid-columns-2">
                <div className="input-group">
                  <label>Износ (%)</label>
                  <input 
                    type="number" 
                    min="0" max="100"
                    value={editNode.wear} 
                    onChange={(e) => setEditNode({...editNode, wear: parseFloat(e.target.value)})} 
                  />
                </div>
              </div>

              <div className="grid-columns-2">
                <div className="input-group">
                  <label>Мощность (МВт)</label>
                  <input 
                    type="number" 
                    value={editNode.nominal_power} 
                    onChange={(e) => setEditNode({...editNode, nominal_power: parseFloat(e.target.value)})} 
                  />
                </div>
                <div className="input-group">
                  <label>Резерв (МВт)</label>
                  <input 
                    type="number" 
                    value={editNode.reserve_power} 
                    onChange={(e) => setEditNode({...editNode, reserve_power: parseFloat(e.target.value)})} 
                  />
                </div>
              </div>

              <div className="grid-columns-2">
                <div className="input-group">
                  <label>Сейсмо-предел (баллы)</label>
                  <input 
                    type="number" min="1" max="12"
                    value={editNode.seismic_limit} 
                    onChange={(e) => setEditNode({...editNode, seismic_limit: parseInt(e.target.value)})} 
                  />
                </div>
              </div>

              <div className="grid-columns-2" style={{ marginTop: '10px' }}>
                <button type="submit" className="btn btn-primary" disabled={actionLoading}>
                  Сохранить
                </button>
                <button 
                  type="button" 
                  className="btn" 
                  onClick={() => { setLeftTab('list'); setEditNode(null); setClickedCoords(null); }}
                  disabled={actionLoading}
                >
                  Отмена
                </button>
              </div>
            </form>
          )}

          {leftTab === 'edit_edge' && editEdge && (
            <form onSubmit={handleUpdateEdge} className="details-list">
              <div className="input-group">
                <label>Тип линии</label>
                <select 
                  value={editEdge.type} 
                  onChange={(e) => setEditEdge({...editEdge, type: e.target.value})}
                >
                  <option value="LEP_110">ЛЭП 110 кВ</option>
                  <option value="LEP_220">ЛЭП 220 кВ</option>
                  <option value="reserve">Резервный кабель</option>
                </select>
              </div>

              <div className="input-group">
                <label>Длина (км)</label>
                <input 
                  type="number" 
                  step="0.01" 
                  value={editEdge.length} 
                  onChange={(e) => setEditEdge({...editEdge, length: parseFloat(e.target.value)})} 
                  required
                />
              </div>

              <div className="input-group">
                <label>Пропускная способность (МВт)</label>
                <input 
                  type="number" 
                  value={editEdge.capacity} 
                  onChange={(e) => setEditEdge({...editEdge, capacity: parseFloat(e.target.value)})} 
                  required
                />
              </div>

              <div className="input-group">
                <label>Опасность птиц/животных (0-1)</label>
                <input 
                  type="number" 
                  step="0.05" min="0" max="1"
                  value={editEdge.animal_hazard} 
                  onChange={(e) => setEditEdge({...editEdge, animal_hazard: parseFloat(e.target.value)})} 
                  required
                />
              </div>

              <div className="input-group">
                <label>Лесистость вдоль линии (0-1)</label>
                <input 
                  type="number" 
                  step="0.05" min="0" max="1"
                  value={editEdge.forestry} 
                  onChange={(e) => setEditEdge({...editEdge, forestry: parseFloat(e.target.value)})} 
                  required
                />
              </div>

              <div className="input-group">
                <label>Критический ветер (м/с)</label>
                <input 
                  type="number" 
                  step="0.5" min="0"
                  value={editEdge.critical_wind} 
                  onChange={(e) => setEditEdge({...editEdge, critical_wind: parseFloat(e.target.value)})} 
                  required
                />
              </div>

              <div className="grid-columns-2" style={{ marginTop: '10px' }}>
                <button type="submit" className="btn btn-primary" disabled={actionLoading}>
                  Сохранить
                </button>
                <button 
                  type="button" 
                  className="btn" 
                  onClick={() => { setLeftTab('list'); setEditEdge(null); }}
                  disabled={actionLoading}
                >
                  Отмена
                </button>
              </div>
            </form>
          )}

          {leftTab === 'add_edge' && (
            <form onSubmit={handleCreateEdge} className="details-list">
              <div className="input-group">
                <label>Объект Источник (Откуда)</label>
                <select 
                  value={newEdge.source_id} 
                  onChange={(e) => setNewEdge({...newEdge, source_id: parseInt(e.target.value)})}
                  required
                >
                  <option value="">Выберите объект...</option>
                  {nodes.map(n => <option key={n.node.id} value={n.node.id}>{n.node.name}</option>)}
                </select>
              </div>
              
              <div className="input-group">
                <label>Объект Назначение (Куда)</label>
                <select 
                  value={newEdge.target_id} 
                  onChange={(e) => setNewEdge({...newEdge, target_id: parseInt(e.target.value)})}
                  required
                >
                  <option value="">Выберите объект...</option>
                  {nodes.map(n => <option key={n.node.id} value={n.node.id}>{n.node.name}</option>)}
                </select>
              </div>

              <div className="input-group">
                <label>Тип линии связи</label>
                <select 
                  value={newEdge.type} 
                  onChange={(e) => setNewEdge({...newEdge, type: e.target.value})}
                >
                  <option value="LEP_110">ЛЭП 110 кВ</option>
                  <option value="LEP_220">ЛЭП 220 кВ</option>
                  <option value="reserve">Резервная кабельная линия</option>
                </select>
              </div>

              <div className="grid-columns-2">
                <div className="input-group">
                  <label>Длина (км) (авто-расчет)</label>
                  <input 
                    type="number" step="0.01"
                    value={newEdge.length} 
                    onChange={(e) => setNewEdge({...newEdge, length: parseFloat(e.target.value)})} 
                  />
                </div>
                <div className="input-group">
                  <label>Пропускная способность (МВт)</label>
                  <input 
                    type="number" 
                    value={newEdge.capacity} 
                    onChange={(e) => setNewEdge({...newEdge, capacity: parseFloat(e.target.value)})} 
                  />
                </div>
              </div>

              <div className="grid-columns-2">
                <div className="input-group">
                  <label>Опасность птиц/животных (0-1)</label>
                  <input 
                    type="number" step="0.05" min="0" max="1"
                    value={newEdge.animal_hazard} 
                    onChange={(e) => setNewEdge({...newEdge, animal_hazard: parseFloat(e.target.value)})} 
                  />
                </div>
                <div className="input-group">
                  <label>Лесистость вдоль линии (0-1)</label>
                  <input 
                    type="number" step="0.05" min="0" max="1"
                    value={newEdge.forestry} 
                    onChange={(e) => setNewEdge({...newEdge, forestry: parseFloat(e.target.value)})} 
                  />
                </div>
              </div>

              <div className="grid-columns-2">
                <div className="input-group">
                  <label>Критический ветер (м/с)</label>
                  <input 
                    type="number" step="0.5" min="0"
                    value={newEdge.critical_wind} 
                    onChange={(e) => setNewEdge({...newEdge, critical_wind: parseFloat(e.target.value)})} 
                  />
                </div>
              </div>

              <button type="submit" className="btn btn-primary" style={{ marginTop: '10px' }} disabled={actionLoading}>
                <Plus size={16} /> Создать линию
              </button>
            </form>
          )}

          {leftTab === 'users' && isAdmin && (
            <section style={{ display: 'flex', flexDirection: 'column', flexGrow: 1 }}>
              <h2>Управление пользователями</h2>
              
              {/* Users List */}
              <div className="grid-list" style={{ maxHeight: '180px', flexGrow: 1 }}>
                {users.map(u => (
                  <div key={u.id} className="grid-list-item" style={{ cursor: 'default' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                      <span className="bold" style={{ fontSize: '0.85rem' }}>{u.username}</span>
                      <span className="text-subtle" style={{ fontSize: '0.7rem' }}>{u.email}</span>
                    </div>
                    <div className="flex-row">
                      <span className={`badge ${u.role === 'admin' ? 'badge-red' : 'badge-green'}`} style={{ fontSize: '0.65rem' }}>
                        {u.role === 'admin' ? 'Админ' : 'Диспетчер'}
                      </span>
                      {u.username !== 'admin' && u.username !== username && (
                        <button 
                          onClick={() => handleDeleteUser(u.id)}
                          style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '4px' }}
                          title="Удалить пользователя"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Add User Form */}
              <form onSubmit={handleCreateUser} className="glass-card" style={{ marginTop: '10px', marginBottom: 0 }}>
                <h3 style={{ fontSize: '0.8rem', marginBottom: '8px' }}>+ Добавить пользователя</h3>
                
                <div className="input-group">
                  <label>Логин</label>
                  <input 
                    type="text" 
                    value={newUserForm.username} 
                    onChange={e => setNewUserForm({...newUserForm, username: e.target.value})} 
                    required 
                  />
                </div>

                <div className="input-group">
                  <label>Email</label>
                  <input 
                    type="email" 
                    value={newUserForm.email} 
                    onChange={e => setNewUserForm({...newUserForm, email: e.target.value})} 
                    required 
                  />
                </div>

                <div className="input-group">
                  <label>Пароль</label>
                  <input 
                    type="password" 
                    value={newUserForm.password} 
                    onChange={e => setNewUserForm({...newUserForm, password: e.target.value})} 
                    required 
                  />
                </div>

                <div className="input-group">
                  <label>Роль</label>
                  <select 
                    value={newUserForm.role} 
                    onChange={e => setNewUserForm({...newUserForm, role: e.target.value})}
                  >
                    <option value="dispatcher">Диспетчер (Просмотр)</option>
                    <option value="admin">Администратор (Полный доступ)</option>
                  </select>
                </div>

                <button type="submit" className="btn btn-primary" style={{ marginTop: '10px' }} disabled={actionLoading}>
                  <Plus size={14} /> Создать аккаунт
                </button>
              </form>
            </section>
          )}

          {leftTab === 'debug' && isAdmin && (
            <section style={{ display: 'flex', flexDirection: 'column', flexGrow: 1 }}>
              <h2>Отладка и симуляция</h2>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '15px' }}>
                Панель инструментов администратора для симуляции погодных воздействий и обучения нейронной сети.
              </p>

              <div className="input-group" style={{ marginBottom: '15px' }}>
                <label style={{ fontWeight: 600 }}>Режим получения погодных данных</label>
                <div style={{ display: 'flex', gap: '20px', marginTop: '5px', marginBottom: '10px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', cursor: 'pointer' }}>
                    <input 
                      type="radio" 
                      name="weatherSourceMode" 
                      value="simulated" 
                      checked={weatherSourceMode === 'simulated'} 
                      onChange={() => setWeatherSourceMode('simulated')} 
                      disabled={actionLoading}
                    />
                    Симуляция
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', cursor: 'pointer' }}>
                    <input 
                      type="radio" 
                      name="weatherSourceMode" 
                      value="real" 
                      checked={weatherSourceMode === 'real'} 
                      onChange={() => setWeatherSourceMode('real')} 
                      disabled={actionLoading}
                    />
                    Реальный API
                  </label>
                </div>
              </div>

              {weatherSourceMode === 'simulated' && (
                <div className="input-group" style={{ marginBottom: '15px' }}>
                  <label style={{ fontWeight: 600 }}>Погодный сценарий</label>
                  <select 
                    value={weatherScenario} 
                    onChange={(e) => setWeatherScenario(e.target.value)}
                    disabled={actionLoading}
                  >
                    <option value="normal">Нормальная погода</option>
                    <option value="storm">Сильный грозовой шторм</option>
                    <option value="hurricane">Ураганный ветер (&gt;30 м/с)</option>
                    <option value="ice">Гололед и мокрый снег</option>
                    <option value="seismic">Землетрясение (сейсмика)</option>
                  </select>
                </div>
              )}

              {weatherSourceMode === 'real' && (
                <div className="input-group" style={{ marginBottom: '15px' }}>
                  <label style={{ fontWeight: 600 }}>Дата и время прогноза (UTC)</label>
                  <input
                    type="datetime-local"
                    value={forecastDate}
                    onChange={(e) => setForecastDate(e.target.value)}
                    disabled={actionLoading}
                    min={new Date().toISOString().slice(0, 16)}
                    max={new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString().slice(0, 16)}
                  />
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '3px' }}>
                    Прогноз OpenWeatherMap: до 5 суток вперёд (шаг 3 ч). По умолчанию — завтра в 12:00 UTC.
                  </span>
                </div>
              )}


              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <button 
                  className="btn btn-primary" 
                  onClick={handleSyncWeather}
                  disabled={actionLoading}
                  style={{ width: '100%' }}
                >
                  <RefreshCw size={14} className={actionLoading ? 'logo-spin' : ''} style={{ marginRight: '6px' }} />
                  {weatherSourceMode === 'real' ? 'Загрузить погоду с OpenWeather' : 'Сгенерировать погодные данные'}
                </button>
                
                <button 
                  className="btn btn-primary" 
                  onClick={handleRunPrediction}
                  disabled={actionLoading}
                  style={{ width: '100%' }}
                >
                  <Activity size={14} style={{ marginRight: '6px' }} />
                  Запустить расчет рисков GNN
                </button>

                {/* Weather API test section */}
                <div style={{ marginTop: '10px', borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: '12px' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Диагностика API погоды</div>
                  <button
                    className="btn"
                    onClick={handleTestWeatherApi}
                    disabled={actionLoading}
                    style={{ width: '100%', borderColor: 'rgba(56,189,248,0.3)' }}
                  >
                    <Wifi size={14} style={{ marginRight: '6px' }} />
                    Проверить подключение к OpenWeather API
                  </button>
                  {weatherApiTestResult && (
                    <div style={{
                      marginTop: '10px',
                      padding: '10px 12px',
                      borderRadius: '6px',
                      fontSize: '0.8rem',
                      border: `1px solid ${
                        weatherApiTestResult.status === 'ok' ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)'
                      }`,
                      background: weatherApiTestResult.status === 'ok'
                        ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.08)',
                      color: weatherApiTestResult.status === 'ok' ? '#6ee7b7' : '#fca5a5',
                    }}>
                      <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                        {weatherApiTestResult.status === 'ok' ? '✓ Подключение успешно' :
                         weatherApiTestResult.status === 'no_key' ? '✗ Ключ не настроен' : '✗ Ошибка подключения'}
                      </div>
                      <div style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>{weatherApiTestResult.message}</div>
                      {weatherApiTestResult.api_data && (
                        <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                          <div>Температура: <b style={{ color: 'var(--text-main)' }}>{(weatherApiTestResult.api_data as {temperature?: number}).temperature?.toFixed(1)}°C</b></div>
                          <div>Ветер: <b style={{ color: 'var(--text-main)' }}>{(weatherApiTestResult.api_data as {wind_speed?: number}).wind_speed?.toFixed(1)} м/с</b></div>
                          <div>Влажность: <b style={{ color: 'var(--text-main)' }}>{(weatherApiTestResult.api_data as {humidity?: number}).humidity?.toFixed(0)}%</b></div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <button 
                  className="btn" 
                  onClick={handleTrainModel} 
                  disabled={actionLoading}
                  style={{ width: '100%', borderColor: 'rgba(56, 189, 248, 0.3)', marginTop: '10px' }}
                >
                  <Cpu size={14} style={{ marginRight: '6px' }} />
                  Обучить модель RGCN
                </button>
              </div>
            </section>
          )}
        </aside>

        {/* Map Center Panel */}
        <section className="map-container">
          <Map 
            nodes={nodes} 
            edges={edges} 
            selectedNodeId={selectedNodeId}
            onSelectNode={setSelectedNodeId}
            selectedEdgeId={selectedEdgeId}
            onSelectEdge={setSelectedEdgeId}
            onMapClick={handleMapClick}
            clickedCoords={clickedCoords}
          />
        </section>

        {/* Right Panel: Detailed Metrics */}
        <aside className="sidebar-right glass-panel">
          {selectedNodeState ? (
            <>
              <h2>Состояние: {selectedNodeState.node.name}</h2>

              {/* Top risk badge */}
              <div 
                className="glass-card"
                style={{ 
                  display: 'flex', 
                  flexDirection: 'column', 
                  alignItems: 'center', 
                  justifyContent: 'center',
                  background: 'rgba(0,0,0,0.2)'
                }}
              >
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>ВЕРОЯТНОСТЬ АВАРИИ (С УЧЕТОМ КАСКАДА)</span>
                <span style={{ 
                  fontSize: '2.5rem', 
                  fontWeight: 700, 
                  color: selectedNodeState.latest_prediction?.threat_level === 'red' ? 'var(--color-red)' :
                         selectedNodeState.latest_prediction?.threat_level === 'yellow' ? 'var(--color-yellow)' : 'var(--color-green)',
                  textShadow: '0 0 15px ' + (
                    selectedNodeState.latest_prediction?.threat_level === 'red' ? 'rgba(239, 68, 68, 0.4)' :
                    selectedNodeState.latest_prediction?.threat_level === 'yellow' ? 'rgba(245, 158, 11, 0.4)' : 'rgba(16, 185, 129, 0.4)'
                  ),
                  margin: '5px 0'
                }}>
                  {selectedNodeState.latest_prediction 
                    ? `${Math.round(selectedNodeState.latest_prediction.cascade_probability * 100)}%` 
                    : 'Нет расчета'}
                </span>
                
                <span className={`badge badge-${selectedNodeState.latest_prediction?.threat_level || 'green'}`}>
                  {selectedNodeState.latest_prediction?.threat_level === 'red' ? 'Критический риск' : 
                   selectedNodeState.latest_prediction?.threat_level === 'yellow' ? 'Повышенный риск' : 'Угроза отсутствует'}
                </span>
              </div>

              {/* Specific Reasons Cards if high/medium risk */}
              {selectedNodeState.latest_prediction?.reasons && (
                <div className="glass-card">
                  <h3>Факторы и причины риска</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
                    {selectedNodeState.latest_prediction.reasons.split('; ').filter(Boolean).map((reason, idx) => {
                      const isCritical = reason.includes('критического') || reason.includes('Физический износ') || reason.includes('сейсмического');
                      return (
                        <div key={idx} className={`reason-item ${!isCritical ? 'warning' : ''}`} style={{ margin: 0 }}>
                          <span style={{ fontSize: '1rem', lineHeight: 1 }}></span>
                          <span style={{ fontSize: '0.75rem', lineHeight: 1.2 }}>{reason}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}



              {/* Weather Data */}
              <div className="glass-card">
                <h3>Метеорологические данные</h3>
                {selectedNodeState.latest_meteo ? (
                  <div className="details-list" style={{ marginTop: '10px' }}>
                    <div className="details-row">
                      <span className="details-label flex-row"><Thermometer size={14} className="text-primary" /> Температура воздуха</span>
                      <span className="details-value">{selectedNodeState.latest_meteo.temperature}°C</span>
                    </div>
                    <div className="details-row">
                      <span className="details-label flex-row"><Wind size={14} className="text-primary" /> Скорость ветра</span>
                      <span className="details-value">{selectedNodeState.latest_meteo.wind_speed} м/с</span>
                    </div>
                    <div className="details-row">
                      <span className="details-label flex-row"><CloudRain size={14} className="text-primary" /> Интенсивность осадков</span>
                      <span className="details-value">{selectedNodeState.latest_meteo.precipitation} мм/ч</span>
                    </div>
                    <div className="details-row">
                      <span className="details-label flex-row"><Zap size={14} className="text-primary" /> Вероятность грозы</span>
                      <span className="details-value">{Math.round(selectedNodeState.latest_meteo.storm_probability * 100)}%</span>
                    </div>
                    <div className="details-row">
                      <span className="details-label flex-row"><Info size={14} className="text-primary" /> Влажность воздуха</span>
                      <span className="details-value">{selectedNodeState.latest_meteo.humidity}%</span>
                    </div>
                    <div className="details-row">
                      <span className="details-label flex-row"><ShieldAlert size={14} className="text-primary" /> Сейсмическая активность</span>
                      <span className="details-value">{selectedNodeState.latest_meteo.actual_seismicity} баллов</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-subtle" style={{ margin: '10px 0' }}>Метеоданные отсутствуют</p>
                )}
              </div>

              {/* Passport Specs */}
              <div className="glass-card">
                <h3>Паспорт объекта</h3>
                <div className="details-list" style={{ marginTop: '10px' }}>
                  <div className="details-row">
                    <span className="details-label">Тип энергообъекта</span>
                    <span className="details-value">
                      {selectedNodeState.node.type === 'generation' ? 'Генерация' : 'Подстанция'}
                    </span>
                  </div>
                  <div className="details-row">
                    <span className="details-label">Физический износ</span>
                    <span className="details-value text-danger">{selectedNodeState.node.wear}%</span>
                  </div>
                  {selectedNodeState.node.type === 'generation' && (
                    <>
                      <div className="details-row">
                        <span className="details-label">Номин. мощность</span>
                        <span className="details-value">{selectedNodeState.node.nominal_power} МВт</span>
                      </div>
                      <div className="details-row">
                        <span className="details-label">Резерв мощности</span>
                        <span className="details-value">{selectedNodeState.node.reserve_power} МВт</span>
                      </div>
                    </>
                  )}
                  <div className="details-row">
                    <span className="details-label">Критический ветер</span>
                    <span className="details-value">{selectedNodeState.node.critical_wind} м/с</span>
                  </div>
                  <div className="details-row">
                    <span className="details-label">Сейсмостойкость</span>
                    <span className="details-value">{selectedNodeState.node.seismic_limit} баллов</span>
                  </div>
                  <div className="details-row">
                    <span className="details-label">Координаты GPS</span>
                    <span className="details-value" style={{ fontSize: '0.75rem' }}>
                      {selectedNodeState.node.latitude.toFixed(4)}, {selectedNodeState.node.longitude.toFixed(4)}
                    </span>
                  </div>
                </div>
                
                {/* Admin controls: Edit and Delete */}
                {isAdmin && (
                  <div className="grid-columns-2" style={{ marginTop: '15px' }}>
                    <button 
                      className="btn" 
                      onClick={() => handleEditClick(selectedNodeState.node)}
                      disabled={actionLoading}
                    >
                      <Edit size={14} /> Изменить
                    </button>
                    <button 
                      className="btn btn-danger" 
                      onClick={() => handleDeleteNode(selectedNodeState.node.id)}
                      disabled={actionLoading}
                    >
                      <Trash2 size={14} /> Удалить
                    </button>
                  </div>
                )}
              </div>

            </>
          ) : selectedEdgeState ? (
            <>
              <h2>Линия: {(() => {
                const sName = nodes.find(n => n.node.id === selectedEdgeState.source_id)?.node.name || `Node ${selectedEdgeState.source_id}`;
                const tName = nodes.find(n => n.node.id === selectedEdgeState.target_id)?.node.name || `Node ${selectedEdgeState.target_id}`;
                return `${sName} → ${tName}`;
              })()}</h2>

              {/* Top risk badge */}
              <div 
                className="glass-card"
                style={{ 
                  display: 'flex', 
                  flexDirection: 'column', 
                  alignItems: 'center', 
                  justifyContent: 'center',
                  background: 'rgba(0,0,0,0.2)'
                }}
              >
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>ВЕРОЯТНОСТЬ АВАРИИ НА ЛИНИИ</span>
                <span style={{ 
                  fontSize: '2.5rem', 
                  fontWeight: 700, 
                  color: selectedEdgeState.latest_prediction?.threat_level === 'red' ? 'var(--color-red)' :
                         selectedEdgeState.latest_prediction?.threat_level === 'yellow' ? 'var(--color-yellow)' : 'var(--color-green)',
                  textShadow: '0 0 15px ' + (
                    selectedEdgeState.latest_prediction?.threat_level === 'red' ? 'rgba(239, 68, 68, 0.4)' :
                    selectedEdgeState.latest_prediction?.threat_level === 'yellow' ? 'rgba(245, 158, 11, 0.4)' : 'rgba(16, 185, 129, 0.4)'
                  )
                }}>
                  {selectedEdgeState.latest_prediction
                    ? `${Math.round(selectedEdgeState.latest_prediction.cascade_probability * 100)}%`
                    : '0%'}
                </span>
                
                <span className={`badge badge-${selectedEdgeState.latest_prediction?.threat_level || 'green'}`} style={{ marginTop: '8px' }}>
                  {selectedEdgeState.latest_prediction?.threat_level === 'red' ? 'Критический риск' :
                   selectedEdgeState.latest_prediction?.threat_level === 'yellow' ? 'Повышенный риск' : 'Стабильное состояние'}
                </span>
              </div>

              {/* Analysis of risk factors */}
              <div className="glass-card">
                <h3>Анализ факторов риска ЛЭП</h3>
                <div className="details-list" style={{ marginTop: '10px' }}>
                  {selectedEdgeState.latest_prediction?.reasons ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {selectedEdgeState.latest_prediction.reasons.split('; ').filter(Boolean).map((reason, idx) => (
                        <div key={idx} className="reason-item warning" style={{ margin: 0 }}>
                          <span style={{ fontSize: '0.75rem', lineHeight: 1.2 }}>{reason}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p style={{ fontSize: '0.75rem', color: '#10b981', margin: 0 }}>✓ Все показатели в пределах нормы</p>
                  )}
                </div>
              </div>

              {/* Weather Data for Edge */}
              {(() => {
                const sourceNodeState = nodes.find(n => n.node.id === selectedEdgeState.source_id);
                const targetNodeState = nodes.find(n => n.node.id === selectedEdgeState.target_id);
                const srcMeteo = sourceNodeState?.latest_meteo;
                const tgtMeteo = targetNodeState?.latest_meteo;
                
                return (
                  <div className="glass-card">
                    <h3>Метеоданные по линии</h3>
                    <div className="details-list" style={{ marginTop: '10px', fontSize: '0.75rem' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                        <thead>
                          <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                            <th style={{ padding: '6px 0', color: 'var(--text-muted)' }}>Параметр</th>
                            <th style={{ padding: '6px 0', color: 'var(--text-muted)' }}>Начало</th>
                            <th style={{ padding: '6px 0', color: 'var(--text-muted)' }}>Конец</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                            <td style={{ padding: '6px 0' }}>Температура</td>
                            <td style={{ padding: '6px 0' }}>{srcMeteo ? `${srcMeteo.temperature}°C` : '—'}</td>
                            <td style={{ padding: '6px 0' }}>{tgtMeteo ? `${tgtMeteo.temperature}°C` : '—'}</td>
                          </tr>
                          <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                            <td style={{ padding: '6px 0' }}>Скорость ветра</td>
                            <td style={{ padding: '6px 0' }}>{srcMeteo ? `${srcMeteo.wind_speed} м/с` : '—'}</td>
                            <td style={{ padding: '6px 0' }}>{tgtMeteo ? `${tgtMeteo.wind_speed} м/с` : '—'}</td>
                          </tr>
                          <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                            <td style={{ padding: '6px 0' }}>Осадки</td>
                            <td style={{ padding: '6px 0' }}>{srcMeteo ? `${srcMeteo.precipitation} мм/ч` : '—'}</td>
                            <td style={{ padding: '6px 0' }}>{tgtMeteo ? `${tgtMeteo.precipitation} мм/ч` : '—'}</td>
                          </tr>
                          <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                            <td style={{ padding: '6px 0' }}>Грозовая активность</td>
                            <td style={{ padding: '6px 0' }}>{srcMeteo ? (srcMeteo.storm_probability > 0 ? 'Да' : 'Нет') : '—'}</td>
                            <td style={{ padding: '6px 0' }}>{tgtMeteo ? (tgtMeteo.storm_probability > 0 ? 'Да' : 'Нет') : '—'}</td>
                          </tr>
                          <tr>
                            <td style={{ padding: '6px 0' }}>Влажность</td>
                            <td style={{ padding: '6px 0' }}>{srcMeteo ? `${srcMeteo.humidity}%` : '—'}</td>
                            <td style={{ padding: '6px 0' }}>{tgtMeteo ? `${tgtMeteo.humidity}%` : '—'}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}

              {/* Line parameters */}
              <div className="glass-card">
                <h3>Паспорт ЛЭП</h3>
                <div className="details-list" style={{ marginTop: '10px' }}>
                  <div className="details-row">
                    <span className="details-label">Тип линии</span>
                    <span className="details-value">{selectedEdgeState.type === 'reserve' ? 'Резервный кабель' : selectedEdgeState.type === 'LEP_220' ? 'ЛЭП 220 кВ' : 'ЛЭП 110 кВ'}</span>
                  </div>
                  <div className="details-row">
                    <span className="details-label">Длина линии</span>
                    <span className="details-value">{selectedEdgeState.length} км</span>
                  </div>
                  <div className="details-row">
                    <span className="details-label">Пропускная способность</span>
                    <span className="details-value">{selectedEdgeState.capacity} МВт</span>
                  </div>
                  <div className="details-row">
                    <span className="details-label">Опасность птиц / животных (0-1)</span>
                    <span className="details-value">{selectedEdgeState.animal_hazard}</span>
                  </div>
                  <div className="details-row">
                    <span className="details-label">Лесистость вдоль линии (0-1)</span>
                    <span className="details-value">{selectedEdgeState.forestry ?? 0}</span>
                  </div>
                  <div className="details-row">
                    <span className="details-label">Критический ветер</span>
                    <span className="details-value">{selectedEdgeState.critical_wind ?? 25.0} м/с</span>
                  </div>
                </div>

                {/* Admin controls: Edit and Delete */}
                {isAdmin && (
                  <div className="grid-columns-2" style={{ marginTop: '15px' }}>
                    <button 
                      className="btn" 
                      onClick={() => handleEditEdgeClick(selectedEdgeState)}
                      disabled={actionLoading}
                    >
                      <Edit size={14} /> Изменить
                    </button>
                    <button 
                      className="btn btn-danger" 
                      onClick={() => handleDeleteEdge(selectedEdgeState.id)}
                      disabled={actionLoading}
                    >
                      <Trash2 size={14} /> Удалить
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)' }}>
              <Eye size={40} strokeWidth={1} style={{ marginBottom: '10px' }} />
              <p>Выберите энергообъект на карте</p>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
};
