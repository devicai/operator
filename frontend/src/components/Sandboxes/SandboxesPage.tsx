import { useState } from 'react';
import {
  Button,
  Empty,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCamera,
  faPlus,
  faStop,
  faTerminal,
  faTrash,
  faUpRightFromSquare,
} from '@fortawesome/free-solid-svg-icons';
import type { ColumnsType } from 'antd/es/table';
import { useSandboxes, useStopSandbox, useDestroySandbox } from '../../hooks/useSandboxes';
import { useSnapshots } from '../../hooks/useSnapshots';
import { useUsage } from '../../hooks/useUsage';
import type { SandboxDto } from '../../api/types';
import CreateSandboxModal from './CreateSandboxModal';
import CreateSnapshotModal from './CreateSnapshotModal';
import TerminalDrawer from './TerminalDrawer';
import UsagePanel from '../Usage/UsagePanel';
import HotPoolPanel from '../HotPool/HotPoolPanel';
import {
  formatDateTime,
  formatDuration,
  formatRelative,
  formatSize,
} from '../../utils/date';

const { Title } = Typography;

const STATUS_COLORS: Record<string, string> = {
  running: 'green',
  creating: 'blue',
  pending: 'default',
  stopping: 'orange',
  stopped: 'default',
  expired: 'red',
  failed: 'red',
};

function formatRemaining(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min}m ${sec}s`;
}

/**
 * When a sandbox was claimed from the hot pool, or null if it never was.
 * Sandboxes claimed before `claimedAt` was persisted only carry the timestamp
 * inside `metadata`.
 */
function claimTime(row: SandboxDto): string | null {
  if (row.hotReserved) return null;
  return row.claimedAt ?? ((row.metadata as any)?.hotClaimedAt as string) ?? null;
}

/** Hot-pool origin filter — maps to the API's two independent flags. */
type OriginFilter = 'claimed' | 'in-pool' | 'not-pooled';

const ORIGIN_QUERY: Record<
  OriginFilter,
  { fromHotPool?: boolean; hotReserved?: boolean }
> = {
  claimed: { fromHotPool: true },
  'in-pool': { hotReserved: true },
  'not-pooled': { fromHotPool: false, hotReserved: false },
};

const SandboxesPage: React.FC = () => {
  const [statusFilter, setStatusFilter] = useState<string | undefined>();
  const [snapshotFilter, setSnapshotFilter] = useState<string | undefined>();
  const [originFilter, setOriginFilter] = useState<OriginFilter | undefined>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [createOpen, setCreateOpen] = useState(false);
  const [terminalSandbox, setTerminalSandbox] = useState<SandboxDto | null>(null);
  const [snapshotSandbox, setSnapshotSandbox] = useState<SandboxDto | null>(null);
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(new Set());
  const [destroyingIds, setDestroyingIds] = useState<Set<string>>(new Set());

  // Any filter change re-slices the result set, so an offset from the old set
  // would land on an arbitrary page (or past the end).
  const resetPage = <T,>(setter: (v: T) => void) => (value: T) => {
    setter(value);
    setPage(1);
  };

  const { data, isLoading } = useSandboxes({
    status: statusFilter,
    snapshotId: snapshotFilter,
    ...(originFilter ? ORIGIN_QUERY[originFilter] : {}),
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  const { data: snapshotsPage } = useSnapshots();
  const { data: usage, isLoading: usageLoading } = useUsage();
  const stopSandbox = useStopSandbox();
  const destroySandbox = useDestroySandbox();

  const handleStop = async (id: string) => {
    setStoppingIds((prev) => new Set(prev).add(id));
    try {
      await stopSandbox.mutateAsync(id);
      message.success('Sandbox stopped');
    } catch (e: any) {
      message.error(e?.message ?? 'Stop failed');
    } finally {
      setStoppingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleDestroy = async (id: string) => {
    setDestroyingIds((prev) => new Set(prev).add(id));
    try {
      await destroySandbox.mutateAsync(id);
      message.success('Sandbox destroyed');
    } catch (e: any) {
      message.error(e?.message ?? 'Destroy failed');
    } finally {
      setDestroyingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const sandboxes = data?.data ?? [];
  const totalMemoryMib = usage?.memory.usedMib ?? 0;

  const columns: ColumnsType<SandboxDto> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, row) => {
        const claimedAt = claimTime(row);
        return (
          <div>
            <code style={{ fontSize: 12 }}>{name}</code>
            {row.hotReserved && (
              <Tooltip title="Pre-warmed sandbox waiting in the hot pool">
                <Tag color="orange" style={{ fontSize: 10, marginLeft: 6 }}>HOT</Tag>
              </Tooltip>
            )}
            {claimedAt && (
              <Tooltip
                title={`Claimed from the hot pool ${formatRelative(claimedAt)} (${formatDateTime(
                  claimedAt,
                )}) — no cold-start cost`}
              >
                <Tag color="volcano" style={{ fontSize: 10, marginLeft: 6 }}>
                  CLAIMED {formatRelative(claimedAt)}
                </Tag>
              </Tooltip>
            )}
            {row.stoppedReason === 'disk-limit' && (
              <Tooltip
                title={`Stopped automatically: wrote ${formatSize(row.diskBytes)}, over the per-sandbox disk cap`}
              >
                <Tag color="red" style={{ fontSize: 10, marginLeft: 6 }}>
                  DISK LIMIT
                </Tag>
              </Tooltip>
            )}
            {row.publicUrl && row.status === 'running' && (
              <Tooltip title={`Public URL → forwards to :${row.exposedHttpPort ?? 80} inside the sandbox`}>
                <a
                  href={row.publicUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ marginLeft: 6, fontSize: 11 }}
                >
                  <FontAwesomeIcon
                    icon={faUpRightFromSquare}
                    style={{ marginRight: 4 }}
                  />
                  {row.publicUrl.replace(/^https?:\/\//, '')}
                </a>
              </Tooltip>
            )}
            {row.bindingId && (
              <div><Tag style={{ fontSize: 10, marginTop: 2 }}>binding: {row.bindingId}</Tag></div>
            )}
          </div>
        );
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (s: string) => <Tag color={STATUS_COLORS[s] ?? 'default'}>{s}</Tag>,
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
      width: 120,
      render: (_: any, row) => (
        <span style={{ fontSize: 11 }}>
          {row.cpus} vCPU / {row.memoryMib} MiB
        </span>
      ),
    },
    {
      // What the sandbox wrote on top of its image. The image is shared, so
      // counting it would show every sandbox owning another 1.1 GB of node:24.
      title: 'Disk',
      key: 'disk',
      width: 100,
      align: 'right',
      render: (_: any, row) => {
        if (row.diskBytes === undefined) {
          return <span style={{ fontSize: 11, opacity: 0.4 }}>-</span>;
        }
        const limit = usage?.disk.sandboxLimitBytes ?? null;
        const ratio = limit ? row.diskBytes / limit : 0;
        const color =
          ratio >= 0.9 ? '#ff4d4f' : ratio >= 0.6 ? '#faad14' : undefined;
        return (
          <Tooltip
            title={
              (limit
                ? `${((ratio) * 100).toFixed(0)}% of the ${formatSize(limit)} per-sandbox cap`
                : 'Written on top of the image') +
              (row.diskCheckedAt ? ` · measured ${formatRelative(row.diskCheckedAt)}` : '')
            }
          >
            <span style={{ fontSize: 11, color }}>{formatSize(row.diskBytes)}</span>
          </Tooltip>
        );
      },
    },
    {
      title: 'RAM share',
      key: 'memoryShare',
      width: 110,
      align: 'right',
      render: (_: any, row) => {
        if (totalMemoryMib <= 0) return <span style={{ fontSize: 11, opacity: 0.5 }}>-</span>;
        const pct = (row.memoryMib / totalMemoryMib) * 100;
        return (
          <Tooltip title={`${row.memoryMib} MiB of ${totalMemoryMib} MiB in use`}>
            <span style={{ fontSize: 11 }}>{pct.toFixed(1)}%</span>
          </Tooltip>
        );
      },
    },
    {
      // For a claimed pod the row's own createdAt is when it was pre-warmed,
      // not when it started serving — showing that would misdate every session.
      title: 'Started',
      key: 'startedAt',
      width: 125,
      render: (_: any, row) => {
        const claimedAt = claimTime(row);
        const shown = claimedAt ?? row.createdAt;
        return (
          <Tooltip
            title={
              claimedAt
                ? `Claimed ${formatRelative(claimedAt)} · pod pre-warmed ${formatDateTime(
                    row.createdAt,
                  )}`
                : formatRelative(shown)
            }
          >
            <span style={{ fontSize: 11 }}>{formatDateTime(shown)}</span>
          </Tooltip>
        );
      },
    },
    {
      title: 'Expires',
      dataIndex: 'expiresAt',
      key: 'expiresAt',
      width: 125,
      render: (d: string, row) => {
        if (!d) return <span style={{ fontSize: 11, opacity: 0.5 }}>-</span>;
        if (row.hotReserved) {
          return (
            <Tooltip title="Idle pool pods carry a placeholder expiry so the TTL sweep skips them">
              <span style={{ fontSize: 11, opacity: 0.5 }}>—</span>
            </Tooltip>
          );
        }
        return (
          <Tooltip title={row.status === 'running' ? formatRelative(d) : 'Not running'}>
            <span style={{ fontSize: 11, opacity: row.status === 'running' ? 1 : 0.5 }}>
              {formatDateTime(d)}
            </span>
          </Tooltip>
        );
      },
    },
    {
      title: 'TTL',
      key: 'ttl',
      width: 130,
      render: (_: any, row) => {
        // A pod waiting in the pool holds a year-long placeholder TTL. Rendering
        // it as a countdown ("525583m 56s") reads like a real lifetime and is
        // what makes a pool pod indistinguishable from a live session at a glance.
        if (row.hotReserved) {
          return (
            <Tooltip title="Waiting in the hot pool — its real TTL is set when a caller claims it">
              <Tag color="orange" style={{ marginRight: 0 }}>in pool</Tag>
            </Tooltip>
          );
        }
        const duration = (
          <Tooltip title="Configured lifetime">
            <span style={{ fontSize: 11, opacity: 0.75 }}>
              {formatDuration(row.ttlSeconds)}
            </span>
          </Tooltip>
        );
        if (row.status !== 'running') return duration;
        const remaining = formatRemaining(row.expiresAt);
        const ms = new Date(row.expiresAt).getTime() - Date.now();
        const color = ms > 600000 ? 'green' : ms > 300000 ? 'orange' : 'red';
        return (
          <Space size={4}>
            <Tooltip title="Time remaining">
              <Tag color={color} style={{ marginRight: 0 }}>{remaining}</Tag>
            </Tooltip>
            {duration}
            {/* A sandbox that keeps outliving its countdown looks like a stuck
                reaper unless the renewal is visible here. */}
            {row.autoExtend && (
              <Tooltip title="Auto-extends on activity: any command or file operation in the last seconds before expiry buys another TTL, up to the configured maximum">
                <Tag color="blue" style={{ marginRight: 0 }}>auto</Tag>
              </Tooltip>
            )}
          </Space>
        );
      },
    },
    {
      title: 'Commands',
      dataIndex: 'commandCount',
      key: 'commands',
      width: 90,
      align: 'center',
    },
    {
      title: '',
      key: 'actions',
      width: 120,
      align: 'right',
      render: (_: any, row) => (
        <Space size={4}>
          {row.status === 'running' && (
            <>
              <Tooltip title="Terminal">
                <Button
                  size="small"
                  icon={<FontAwesomeIcon icon={faTerminal} />}
                  onClick={() => setTerminalSandbox(row)}
                />
              </Tooltip>
              <Tooltip title="Snapshot">
                <Button
                  size="small"
                  icon={<FontAwesomeIcon icon={faCamera} />}
                  onClick={() => setSnapshotSandbox(row)}
                />
              </Tooltip>
              <Tooltip title={stoppingIds.has(row.sandboxId) ? 'Stopping…' : 'Stop'}>
                <Button
                  size="small"
                  icon={<FontAwesomeIcon icon={faStop} />}
                  loading={stoppingIds.has(row.sandboxId)}
                  disabled={stoppingIds.has(row.sandboxId)}
                  onClick={() => handleStop(row.sandboxId)}
                />
              </Tooltip>
            </>
          )}
          <Popconfirm
            title="Destroy this sandbox?"
            onConfirm={() => handleDestroy(row.sandboxId)}
            disabled={destroyingIds.has(row.sandboxId)}
          >
            <Tooltip title={destroyingIds.has(row.sandboxId) ? 'Destroying…' : 'Destroy'}>
              <Button
                size="small"
                danger
                icon={<FontAwesomeIcon icon={faTrash} />}
                loading={destroyingIds.has(row.sandboxId)}
                disabled={destroyingIds.has(row.sandboxId)}
              />
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
          <FontAwesomeIcon icon={faTerminal} style={{ marginRight: 8 }} />
          Sandboxes
        </Title>
        <Space wrap>
          <Select
            placeholder="Filter status"
            allowClear
            style={{ width: 140 }}
            value={statusFilter}
            onChange={resetPage(setStatusFilter)}
            options={[
              { label: 'Running', value: 'running' },
              { label: 'Creating', value: 'creating' },
              { label: 'Pending', value: 'pending' },
              { label: 'Stopping', value: 'stopping' },
              { label: 'Stopped', value: 'stopped' },
              { label: 'Expired', value: 'expired' },
              { label: 'Failed', value: 'failed' },
            ]}
          />
          <Select
            placeholder="Filter origin"
            allowClear
            style={{ width: 160 }}
            value={originFilter}
            onChange={resetPage(setOriginFilter)}
            options={[
              { label: 'Claimed from pool', value: 'claimed' },
              { label: 'Idle in pool', value: 'in-pool' },
              { label: 'Never pooled', value: 'not-pooled' },
            ]}
          />
          <Select
            placeholder="Filter snapshot"
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ width: 200 }}
            value={snapshotFilter}
            onChange={resetPage(setSnapshotFilter)}
            options={(snapshotsPage?.data ?? []).map((s) => ({
              label: s.name || s.snapshotId,
              value: s.snapshotId,
            }))}
          />
          <Button
            type="primary"
            icon={<FontAwesomeIcon icon={faPlus} />}
            onClick={() => setCreateOpen(true)}
          >
            New Sandbox
          </Button>
        </Space>
      </div>

      <UsagePanel usage={usage} loading={usageLoading} />
      <HotPoolPanel />

      <Table
        rowKey="_id"
        size="small"
        loading={isLoading}
        columns={columns}
        dataSource={sandboxes}
        pagination={{
          current: page,
          pageSize,
          total: data?.pagination.total ?? 0,
          showSizeChanger: true,
          pageSizeOptions: [20, 50, 100],
          showTotal: (total, [from, to]) => `${from}-${to} of ${total}`,
          onChange: (nextPage, nextSize) => {
            setPage(nextSize !== pageSize ? 1 : nextPage);
            setPageSize(nextSize);
          },
        }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                statusFilter || originFilter || snapshotFilter
                  ? 'No sandboxes match these filters.'
                  : 'No sandboxes yet. Create one to get started.'
              }
            />
          ),
        }}
      />

      <CreateSandboxModal
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
      />

      <TerminalDrawer
        sandbox={terminalSandbox}
        onClose={() => setTerminalSandbox(null)}
      />

      <CreateSnapshotModal
        sandbox={snapshotSandbox}
        onClose={() => setSnapshotSandbox(null)}
      />
    </div>
  );
};

export default SandboxesPage;
