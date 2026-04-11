import React from 'react';
import { Outlet } from 'react-router';
import Sidebar from './Sidebar/Sidebar';

const AppLayout: React.FC = () => {
  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        padding: 5,
        gap: 5,
        backgroundColor: '#141414',
      }}
    >
      <div style={{ width: '15%', minWidth: 250, flexShrink: 0 }}>
        <Sidebar />
      </div>
      <main
        style={{
          flex: 1,
          backgroundColor: '#1f1f1f',
          color: '#b3b3b3',
          borderRadius: 8,
          padding: 10,
          overflowY: 'auto',
          minWidth: 0,
        }}
      >
        <Outlet />
      </main>
    </div>
  );
};

export default AppLayout;
