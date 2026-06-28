import { useState, useEffect } from 'react';
import { Auth } from './components/Auth';
import { Dashboard } from './components/Dashboard';

function App() {
  const [token, setToken] = useState<string | null>(null);
  const [username, setUsername] = useState<string>('');
  const [role, setRole] = useState<string>('dispatcher');

  useEffect(() => {
    // Check if user is already logged in
    const savedToken = localStorage.getItem('access_token');
    const savedUser = localStorage.getItem('username');
    const savedRole = localStorage.getItem('role') || 'dispatcher';
    if (savedToken && savedUser) {
      setToken(savedToken);
      setUsername(savedUser);
      setRole(savedRole);
    }
  }, []);

  const handleLoginSuccess = (newToken: string, newUsername: string, newRole: string) => {
    localStorage.setItem('access_token', newToken);
    localStorage.setItem('username', newUsername);
    localStorage.setItem('role', newRole);
    setToken(newToken);
    setUsername(newUsername);
    setRole(newRole);
  };

  const handleLogout = () => {
    localStorage.removeItem('access_token');
    localStorage.removeItem('username');
    localStorage.removeItem('role');
    setToken(null);
    setUsername('');
    setRole('dispatcher');
  };

  return (
    <>
      {token ? (
        <Dashboard 
          username={username}
          role={role}
          onLogout={handleLogout} 
        />
      ) : (
        <Auth onLoginSuccess={handleLoginSuccess} />
      )}
    </>
  );
}

export default App;
