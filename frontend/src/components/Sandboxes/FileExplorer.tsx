import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Breadcrumb, Button, Empty, Space, Table, Tooltip, message } from 'antd';
import { LoadingOutlined, UploadOutlined, ReloadOutlined } from '@ant-design/icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faDownload,
  faFile,
  faFolder,
  faLink,
  faTurnUp,
} from '@fortawesome/free-solid-svg-icons';
import type { ColumnsType } from 'antd/es/table';
import { sandboxesApi } from '../../api/client';
import type { FileEntryDto, SandboxDto } from '../../api/types';
import { isPreviewable, triggerDownload } from './FilePreviewDrawer';
import { formatDateTime, formatSize } from '../../utils/date';

interface Props {
  sandbox: SandboxDto;
  active: boolean;
  onPreviewFile: (fullPath: string) => void;
}

interface Row extends FileEntryDto {
  key: string;
  isParentLink?: boolean;
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
}

const FileExplorer: React.FC<Props> = ({ sandbox, active, onPreviewFile }) => {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntryDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [downloading, setDownloading] = useState<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const loadedOnce = useRef(false);

  const load = useCallback(
    async (path?: string) => {
      setLoading(true);
      setError(null);
      try {
        const res = await sandboxesApi.listFiles(sandbox.sandboxId, path);
        setEntries(res.data.entries);
        setCurrentPath(res.data.path);
      } catch (e: any) {
        setError(e?.response?.data?.message ?? e?.message ?? 'Failed to list directory');
      } finally {
        setLoading(false);
      }
    },
    [sandbox.sandboxId],
  );

  useEffect(() => {
    if (active && !loadedOnce.current) {
      loadedOnce.current = true;
      load();
    }
  }, [active, load]);

  const navigateTo = useCallback(
    (path: string) => {
      load(path);
    },
    [load],
  );

  const handleDownload = useCallback(
    async (row: FileEntryDto) => {
      if (!currentPath) return;
      const fullPath = joinPath(currentPath, row.name);
      setDownloading((prev) => new Set(prev).add(row.name));
      try {
        const res = await sandboxesApi.downloadFile(sandbox.sandboxId, fullPath);
        triggerDownload(res.data, row.name);
        message.success(`Downloaded ${row.name}`);
      } catch (e: any) {
        let msg = e?.message ?? 'Download failed';
        try {
          const text = await (e?.response?.data as Blob)?.text?.();
          if (text) msg = JSON.parse(text)?.message ?? msg;
        } catch {}
        message.error(msg);
      } finally {
        setDownloading((prev) => {
          const next = new Set(prev);
          next.delete(row.name);
          return next;
        });
      }
    },
    [currentPath, sandbox.sandboxId],
  );

  const handleFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !currentPath) return;
      setIsUploading(true);
      try {
        await sandboxesApi.uploadFile(sandbox.sandboxId, `${currentPath.replace(/\/+$/, '')}/`, file);
        message.success(`Uploaded ${file.name}`);
        load(currentPath);
      } catch (err: any) {
        message.error(err?.response?.data?.message ?? err?.message ?? 'Upload failed');
      } finally {
        setIsUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [currentPath, sandbox.sandboxId, load],
  );

  const rows: Row[] = [
    ...(currentPath && currentPath !== '/'
      ? [
          {
            key: '..',
            name: '..',
            type: 'dir' as const,
            sizeBytes: 0,
            mtime: null,
            isParentLink: true,
          },
        ]
      : []),
    ...entries.map((entry) => ({ ...entry, key: entry.name })),
  ];

  const breadcrumbItems = (() => {
    if (!currentPath) return [];
    const segments = currentPath.split('/').filter(Boolean);
    const items = [
      {
        title: <a onClick={() => navigateTo('/')}>/</a>,
        key: '/',
      },
    ];
    let acc = '';
    for (const segment of segments) {
      acc += `/${segment}`;
      const target = acc;
      items.push({
        title: <a onClick={() => navigateTo(target)}>{segment}</a>,
        key: target,
      });
    }
    return items;
  })();

  const columns: ColumnsType<Row> = [
    {
      title: 'Name',
      key: 'name',
      render: (_: any, row) => {
        const icon =
          row.type === 'dir' ? (
            <FontAwesomeIcon icon={row.isParentLink ? faTurnUp : faFolder} style={{ color: '#e3b341', width: 14 }} />
          ) : row.type === 'symlink' ? (
            <FontAwesomeIcon icon={faLink} style={{ color: '#69b1ff', width: 14 }} />
          ) : (
            <FontAwesomeIcon icon={faFile} style={{ color: '#8b949e', width: 14 }} />
          );
        const clickable = row.type === 'dir' || row.type === 'symlink' || row.type === 'file';
        return (
          <span
            onClick={() => {
              if (!currentPath) return;
              if (row.isParentLink) return navigateTo(parentOf(currentPath));
              if (row.type === 'dir' || row.type === 'symlink') {
                return navigateTo(joinPath(currentPath, row.name));
              }
              if (isPreviewable(row.name)) return onPreviewFile(joinPath(currentPath, row.name));
              handleDownload(row);
            }}
            style={{ cursor: clickable ? 'pointer' : 'default', display: 'inline-flex', alignItems: 'center', gap: 8 }}
          >
            {icon}
            <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{row.name}</span>
            {row.type === 'symlink' && row.target && (
              <span style={{ fontSize: 11, color: '#666' }}>→ {row.target}</span>
            )}
          </span>
        );
      },
    },
    {
      title: 'Size',
      key: 'size',
      width: 90,
      align: 'right',
      render: (_: any, row) =>
        row.type === 'file' ? (
          <span style={{ fontSize: 11 }}>{formatSize(row.sizeBytes)}</span>
        ) : (
          <span style={{ fontSize: 11, opacity: 0.4 }}>-</span>
        ),
    },
    {
      title: 'Modified',
      key: 'mtime',
      width: 130,
      render: (_: any, row) =>
        row.isParentLink ? null : <span style={{ fontSize: 11 }}>{formatDateTime(row.mtime)}</span>,
    },
    {
      title: '',
      key: 'actions',
      width: 44,
      align: 'right',
      render: (_: any, row) =>
        row.type === 'file' ? (
          <Tooltip title="Download">
            <Button
              size="small"
              type="text"
              loading={downloading.has(row.name)}
              icon={<FontAwesomeIcon icon={faDownload} style={{ fontSize: 12 }} />}
              onClick={() => handleDownload(row)}
            />
          </Tooltip>
        ) : null,
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: '#0d1117' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '8px 16px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <Breadcrumb items={breadcrumbItems} separator="/" style={{ fontSize: 12, fontFamily: 'monospace' }} />
        <Space size={8}>
          <Tooltip title="Refresh">
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => currentPath && load(currentPath)}
              disabled={loading || !currentPath}
            />
          </Tooltip>
          <Tooltip title={`Upload file to ${currentPath ?? ''}`}>
            <Button
              size="small"
              icon={isUploading ? <LoadingOutlined spin /> : <UploadOutlined />}
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading || !currentPath}
            >
              Upload
            </Button>
          </Tooltip>
        </Space>
        <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={handleFileSelected} />
      </div>

      {error && (
        <Alert
          type="error"
          message={error}
          showIcon
          closable
          onClose={() => setError(null)}
          style={{ margin: '8px 16px 0' }}
        />
      )}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        <Table<Row>
          size="small"
          rowKey="key"
          loading={loading}
          columns={columns}
          dataSource={rows}
          pagination={rows.length > 100 ? { pageSize: 100, size: 'small' } : false}
          locale={{
            emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Empty directory" />,
          }}
        />
      </div>
    </div>
  );
};

export default FileExplorer;
