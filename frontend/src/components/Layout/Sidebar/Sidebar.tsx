import React, { useState } from 'react';
import { Input } from 'antd';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSearch } from '@fortawesome/free-solid-svg-icons';
import { useNavigate } from 'react-router';
import { SidebarModuleMenu } from './SidebarModuleMenu';
import { SidebarFooter } from './SidebarFooter';
import { MODULE_CONFIG } from './moduleConfig';
import DevicLogo from '../../../assets/devic-logo.png';

const Sidebar: React.FC = () => {
  const [searchText, setSearchText] = useState('');
  const navigate = useNavigate();

  return (
    <div
      style={{
        height: '100%',
        width: '100%',
        backgroundColor: '#1f1f1f',
        position: 'relative',
        userSelect: 'none',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          height: 30,
          minHeight: 30,
          flexShrink: 0,
          position: 'relative',
          marginBottom: 20,
          marginTop: 10,
        }}
      >
        <img
          src={DevicLogo}
          alt="Devic"
          onClick={() => navigate(MODULE_CONFIG.basePath)}
          style={{
            position: 'absolute',
            top: 10,
            left: 10,
            height: 30,
            cursor: 'pointer',
          }}
        />
      </div>
      <div style={{ flexGrow: 1, position: 'relative', overflowY: 'auto' }}>
        <div style={{ padding: '0 12px 8px' }}>
          <Input
            placeholder="Search..."
            prefix={<FontAwesomeIcon icon={faSearch} style={{ color: '#8c8c8c', fontSize: 12 }} />}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            allowClear
            size="small"
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.06)',
              borderColor: 'rgba(255, 255, 255, 0.1)',
              borderRadius: 6,
            }}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
          <SidebarModuleMenu searchText={searchText} defaultExpanded />
        </div>
      </div>
      <div style={{ width: '100%', height: 60, flexShrink: 0, zIndex: 9, padding: 4 }}>
        <SidebarFooter />
      </div>
    </div>
  );
};

export default Sidebar;
