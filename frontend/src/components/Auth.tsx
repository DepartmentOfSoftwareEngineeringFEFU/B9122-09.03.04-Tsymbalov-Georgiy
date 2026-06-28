import React, { useState } from 'react';
import { Zap, Shield, Mail, User as UserIcon, Lock } from 'lucide-react';

interface AuthProps {
  onLoginSuccess: (token: string, username: string, role: string) => void;
}

export const Auth: React.FC<AuthProps> = ({ onLoginSuccess }) => {
  const [isRegister, setIsRegister] = useState<boolean>(false);
  const [username, setUsername] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const endpoint = isRegister ? '/api/auth/register' : '/api/auth/login';
    const url = isRegister 
      ? endpoint 
      : `${endpoint}?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: isRegister ? JSON.stringify({ username, email, password }) : undefined
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || 'Что-то пошло не так');
      }

      if (isRegister) {
        // Automatically switch to login on success
        alert('Регистрация успешна! Войдите под своими учетными данными.');
        setIsRegister(false);
        setPassword('');
      } else {
        // Save to session/local storage
        onLoginSuccess(data.access_token, data.user.username, data.user.role);
      }
    } catch (err: any) {
      setError(err.message || 'Ошибка подключения к серверу');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-panel glass-panel">
        <div className="auth-header">
          <div style={{ display: 'inline-flex', padding: '12px', borderRadius: '50%', background: 'rgba(56, 189, 248, 0.1)', marginBottom: '15px' }}>
            <Zap size={32} className="logo-icon text-primary" style={{ color: '#38bdf8' }} />
          </div>
          <h1>СМПА Электросети</h1>
          <p>Система мониторинга и прогнозирования аварийных ситуаций</p>
        </div>

        {error && (
          <div style={{ padding: '10px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#ef4444', borderRadius: '6px', fontSize: '0.85rem', marginBottom: '15px', display: 'flex', gap: '8px', alignItems: 'center' }}>
            <Shield size={16} />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="details-list">
          <div className="input-group">
            <label>Имя пользователя</label>
            <div style={{ position: 'relative' }}>
              <UserIcon size={14} style={{ position: 'absolute', left: '12px', top: '11px', color: 'var(--text-muted)' }} />
              <input 
                type="text" 
                value={username} 
                onChange={(e) => setUsername(e.target.value)} 
                placeholder="Имя пользователя"
                style={{ paddingLeft: '35px', width: '100%' }}
                required 
              />
            </div>
          </div>

          {isRegister && (
            <div className="input-group">
              <label>Электронная почта</label>
              <div style={{ position: 'relative' }}>
                <Mail size={14} style={{ position: 'absolute', left: '12px', top: '11px', color: 'var(--text-muted)' }} />
                <input 
                  type="email" 
                  value={email} 
                  onChange={(e) => setEmail(e.target.value)} 
                  placeholder="name@company.com"
                  style={{ paddingLeft: '35px', width: '100%' }}
                  required 
                />
              </div>
            </div>
          )}

          <div className="input-group">
            <label>Пароль</label>
            <div style={{ position: 'relative' }}>
              <Lock size={14} style={{ position: 'absolute', left: '12px', top: '11px', color: 'var(--text-muted)' }} />
              <input 
                type="password" 
                value={password} 
                onChange={(e) => setPassword(e.target.value)} 
                placeholder="••••••••"
                style={{ paddingLeft: '35px', width: '100%' }}
                required 
              />
            </div>
          </div>

          <button 
            type="submit" 
            className="btn btn-primary" 
            style={{ marginTop: '15px' }}
            disabled={loading}
          >
            {loading ? 'Загрузка...' : isRegister ? 'Зарегистрироваться' : 'Войти в систему'}
          </button>
        </form>

        <div className="auth-footer">
          {isRegister ? (
            <span>Уже зарегистрированы? <button className="auth-toggle" onClick={() => setIsRegister(false)}>Войти</button></span>
          ) : (
            <span>Новый пользователь? <button className="auth-toggle" onClick={() => setIsRegister(true)}>Создать аккаунт</button></span>
          )}
        </div>
      </div>
    </div>
  );
};
