import { useState } from 'react';
import {
  Button,
  Empty,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCubes, faPen, faPlus, faTrash } from '@fortawesome/free-solid-svg-icons';
import type { ColumnsType } from 'antd/es/table';
import {
  useSandboxProfiles,
  useDeleteSandboxProfile,
} from '../../hooks/useSandboxProfiles';
import type { SandboxProfileDto } from '../../api/types';
import ProfileModal from './ProfileModal';

const { Title } = Typography;

const ProfilesPage: React.FC = () => {
  const { data, isLoading } = useSandboxProfiles();
  const deleteProfile = useDeleteSandboxProfile();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<SandboxProfileDto | null>(null);

  const profiles = data?.data ?? [];

  const columns: ColumnsType<SandboxProfileDto> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, row) => (
        <div>
          <div style={{ fontWeight: 600 }}>{name}</div>
          {row.description && (
            <span style={{ fontSize: 11, color: '#8c8c8c' }}>{row.description}</span>
          )}
        </div>
      ),
    },
    {
      title: 'Image',
      dataIndex: 'image',
      key: 'image',
      width: 120,
      render: (img: string) => <code style={{ fontSize: 11 }}>{img}</code>,
    },
    {
      title: 'Resources',
      key: 'resources',
      width: 140,
      render: (_: any, row) => (
        <span style={{ fontSize: 11 }}>
          {row.cpus} vCPU / {row.memoryMib} MiB
        </span>
      ),
    },
    {
      title: 'TTL',
      dataIndex: 'ttlSeconds',
      key: 'ttl',
      width: 90,
      render: (v: number) => <Tag>{Math.floor(v / 60)}m</Tag>,
    },
    {
      title: 'Init Script',
      key: 'initScript',
      width: 90,
      render: (_: any, row) =>
        row.initScript ? <Tag color="blue">Yes</Tag> : <span style={{ color: '#8c8c8c' }}>-</span>,
    },
    {
      title: '',
      key: 'actions',
      width: 90,
      align: 'right',
      render: (_: any, row) => (
        <Space size={4}>
          <Tooltip title="Edit">
            <Button
              size="small"
              icon={<FontAwesomeIcon icon={faPen} />}
              onClick={() => { setEditing(row); setModalOpen(true); }}
            />
          </Tooltip>
          <Popconfirm
            title="Delete this profile?"
            onConfirm={() =>
              deleteProfile
                .mutateAsync(row._id)
                .then(() => message.success('Profile deleted'))
                .catch((e) => message.error(e?.message ?? 'Delete failed'))
            }
          >
            <Tooltip title="Delete">
              <Button size="small" danger icon={<FontAwesomeIcon icon={faTrash} />} />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={3} style={{ marginTop: 0, marginBottom: 0 }}>
          <FontAwesomeIcon icon={faCubes} style={{ marginRight: 8 }} />
          Sandbox Profiles
        </Title>
        <Button
          type="primary"
          icon={<FontAwesomeIcon icon={faPlus} />}
          onClick={() => { setEditing(null); setModalOpen(true); }}
        >
          New Profile
        </Button>
      </div>

      <Table
        rowKey="_id"
        size="small"
        loading={isLoading}
        columns={columns}
        dataSource={profiles}
        pagination={false}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No profiles yet. Create one to define reusable sandbox configurations."
            />
          ),
        }}
      />

      <ProfileModal
        open={modalOpen}
        profile={editing}
        onCancel={() => { setModalOpen(false); setEditing(null); }}
      />
    </div>
  );
};

export default ProfilesPage;
