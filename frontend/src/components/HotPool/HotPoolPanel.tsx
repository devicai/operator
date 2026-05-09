import React from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Progress,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faArrowsRotate,
  faBoltLightning,
  faCircleCheck,
  faCircleXmark,
  faFire,
  faLayerGroup,
} from '@fortawesome/free-solid-svg-icons';
import { useHotPoolStatus, useReconcileHotPool } from '../../hooks/useHotPool';

const { Text } = Typography;

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const HotPoolPanel: React.FC = () => {
  const { data, isLoading } = useHotPoolStatus();
  const reconcile = useReconcileHotPool();

  if (isLoading) {
    return (
      <Card size="small" loading style={{ marginBottom: 12 }} />
    );
  }
  if (!data) return null;

  const { config, metrics, snapshot, hotSandboxes, lastError } = data;

  const enabled = !!config.enabled;
  const fillPct = metrics.target > 0 ? (metrics.current / metrics.target) * 100 : 0;
  const reservedPct =
    metrics.totalLimitMib && metrics.totalLimitMib > 0
      ? (metrics.reservedMib / metrics.totalLimitMib) * 100
      : 0;

  return (
    <Card
      size="small"
      style={{ marginBottom: 12 }}
      title={
        <Space size={8}>
          <FontAwesomeIcon icon={faFire} style={{ color: enabled ? '#ff7a45' : '#888' }} />
          <span>Hot Pool</span>
          {enabled ? (
            <Badge status="success" text="enabled" />
          ) : (
            <Badge status="default" text="disabled" />
          )}
        </Space>
      }
      extra={
        <Space size={6}>
          <Tooltip title="Force reconcile (provision missing pods now)">
            <Button
              size="small"
              icon={<FontAwesomeIcon icon={faArrowsRotate} />}
              onClick={() => reconcile.mutate()}
              loading={reconcile.isPending}
              disabled={!enabled}
            >
              Reconcile
            </Button>
          </Tooltip>
        </Space>
      }
    >
      {!enabled && (
        <Alert
          type="info"
          showIcon
          message="Hot pool is disabled"
          description="Enable it from Settings → Hot Pool to keep pre-warmed sandboxes ready to claim."
          style={{ marginBottom: 12 }}
        />
      )}

      {enabled && !snapshot && (
        <Alert
          type="warning"
          showIcon
          message="No snapshot configured"
          description="Pick a snapshot in Settings → Hot Pool. Hot sandboxes are restored from this snapshot."
          style={{ marginBottom: 12 }}
        />
      )}

      <div
        style={{
          display: 'flex',
          gap: 24,
          flexWrap: 'wrap',
          marginBottom: 8,
        }}
      >
        <Statistic
          title={
            <Space size={4}>
              <FontAwesomeIcon icon={faLayerGroup} />
              <span>Pool fill</span>
            </Space>
          }
          value={metrics.current}
          suffix={`/ ${metrics.target}`}
          valueStyle={{ fontSize: 22 }}
        />
        <Statistic
          title={
            <Space size={4}>
              <FontAwesomeIcon icon={faBoltLightning} />
              <Tooltip title="Successful claims served by this process since boot. Resets on restart.">
                <span>Claims served</span>
              </Tooltip>
            </Space>
          }
          value={metrics.totalClaims}
          valueStyle={{ fontSize: 22 }}
          suffix={
            metrics.lastClaimedAt ? (
              <Tooltip title={`Last claim: ${new Date(metrics.lastClaimedAt).toLocaleString()}`}>
                <span style={{ fontSize: 11, opacity: 0.6, marginLeft: 6 }}>
                  · last {timeAgo(metrics.lastClaimedAt)}
                </span>
              </Tooltip>
            ) : undefined
          }
        />
        <div style={{ minWidth: 220, flex: 1 }}>
          <Text style={{ fontSize: 12, opacity: 0.7 }}>
            Reserved memory ({metrics.currentMemoryMib} / {metrics.reservedMib} MiB)
          </Text>
          <Progress
            percent={Math.min(100, fillPct)}
            showInfo={false}
            strokeColor={fillPct >= 100 ? '#52c41a' : '#ff7a45'}
            size="small"
          />
          <Text style={{ fontSize: 11, opacity: 0.6 }}>
            {metrics.totalLimitMib
              ? `${metrics.reservedMib} / ${metrics.totalLimitMib} MiB of total cap (${reservedPct.toFixed(1)}%)`
              : 'No total memory cap configured'}
          </Text>
        </div>
        <div style={{ minWidth: 200 }}>
          <Text style={{ fontSize: 12, opacity: 0.7 }}>Source snapshot</Text>
          <div>
            {snapshot ? (
              <Tooltip title={snapshot.snapshotId}>
                <Tag color="geekblue" style={{ marginTop: 4 }}>
                  {snapshot.name}
                </Tag>
              </Tooltip>
            ) : (
              <Tag>not set</Tag>
            )}
          </div>
        </div>
      </div>

      {lastError && (
        <Alert
          type="error"
          showIcon
          icon={<FontAwesomeIcon icon={faCircleXmark} />}
          message="Last reconcile error"
          description={lastError}
          style={{ marginTop: 8 }}
        />
      )}

      {enabled && hotSandboxes.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <Text style={{ fontSize: 12, opacity: 0.7 }}>
            <FontAwesomeIcon icon={faCircleCheck} style={{ marginRight: 6, color: '#52c41a' }} />
            Available pods:
          </Text>
          <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {hotSandboxes.map((s) => (
              <Tooltip
                key={s.sandboxId}
                title={`${s.sandboxId} — ${s.cpus} vCPU / ${s.memoryMib} MiB · age ${s.ageSeconds}s`}
              >
                <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                  <code style={{ fontSize: 10 }}>{s.name}</code>
                </Tag>
              </Tooltip>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
};

export default HotPoolPanel;
