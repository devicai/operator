import React from 'react';
import { Card, Progress, Space, Tooltip, Typography } from 'antd';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faHardDrive, faMemory } from '@fortawesome/free-solid-svg-icons';
import type { UsageSummary } from '../../api/types';

const { Text } = Typography;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[i]}`;
}

function progressColor(pct: number): string {
  if (pct >= 90) return '#ff4d4f';
  if (pct >= 70) return '#faad14';
  return '#4661B1';
}

interface MetricProps {
  icon: typeof faMemory;
  label: string;
  used: string;
  limit: string | null;
  percent: number | null;
}

const Metric: React.FC<MetricProps> = ({ icon, label, used, limit, percent }) => (
  <div style={{ flex: 1, minWidth: 220 }}>
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        marginBottom: 4,
      }}
    >
      <Space size={6}>
        <FontAwesomeIcon icon={icon} style={{ opacity: 0.7 }} />
        <Text strong style={{ fontSize: 12 }}>
          {label}
        </Text>
      </Space>
      <Text style={{ fontSize: 12 }}>
        <code>{used}</code>
        {limit !== null && (
          <>
            {' / '}
            <code>{limit}</code>
            {percent !== null && (
              <span style={{ marginLeft: 8, opacity: 0.7 }}>
                {percent.toFixed(1)}%
              </span>
            )}
          </>
        )}
      </Text>
    </div>
    {percent !== null ? (
      <Progress
        percent={Math.min(100, percent)}
        showInfo={false}
        strokeColor={progressColor(percent)}
        size="small"
      />
    ) : (
      <Tooltip title="No limit configured">
        <Progress percent={0} showInfo={false} size="small" status="normal" />
      </Tooltip>
    )}
  </div>
);

interface UsagePanelProps {
  usage: UsageSummary | undefined;
  loading?: boolean;
}

const UsagePanel: React.FC<UsagePanelProps> = ({ usage, loading }) => {
  const memUsed = usage?.memory.usedMib ?? 0;
  const memLimit = usage?.memory.limitMib ?? null;
  const hotReserved = usage?.memory.hotPoolReservedMib ?? 0;
  const memPercent = memLimit && memLimit > 0 ? (memUsed / memLimit) * 100 : null;

  const diskUsed = usage?.disk.usedBytes ?? 0;
  const diskLimit = usage?.disk.limitBytes ?? null;
  const diskPercent = diskLimit && diskLimit > 0 ? (diskUsed / diskLimit) * 100 : null;

  return (
    <Card size="small" loading={loading} style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        <Metric
          icon={faMemory}
          label={
            hotReserved > 0
              ? `RAM (running) — +${hotReserved} MiB hot reserve`
              : 'RAM (running sandboxes)'
          }
          used={`${memUsed} MiB`}
          limit={memLimit !== null ? `${memLimit} MiB` : null}
          percent={memPercent}
        />
        <Metric
          icon={faHardDrive}
          label="Disk (snapshots)"
          used={formatBytes(diskUsed)}
          limit={diskLimit !== null ? formatBytes(diskLimit) : null}
          percent={diskPercent}
        />
      </div>
    </Card>
  );
};

export default UsagePanel;
