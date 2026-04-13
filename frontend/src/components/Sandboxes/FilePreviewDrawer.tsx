import { useEffect, useState } from 'react';
import { Drawer, Spin, Button, Tooltip, Typography, message } from 'antd';
import { DownloadOutlined, LoadingOutlined } from '@ant-design/icons';
import Editor from '@monaco-editor/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { sandboxesApi } from '../../api/client';

const { Text } = Typography;

const PREVIEWABLE = ['.md', '.txt', '.csv', '.js', '.jsx', '.tsx', '.ts', '.py', '.html'];
const CODE_EXTS: Record<string, string> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.py': 'python',
  '.html': 'html',
  '.csv': 'plaintext',
  '.txt': 'plaintext',
};

export function isPreviewable(fileName: string): boolean {
  const ext = getExt(fileName);
  return PREVIEWABLE.includes(ext);
}

function getExt(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
}

export function triggerDownload(content: string, fileName: string) {
  const blob = new Blob([content], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

interface Props {
  open: boolean;
  sandboxId: string;
  filePath: string;
  onClose: () => void;
}

const FilePreviewDrawer: React.FC<Props> = ({ open, sandboxId, filePath, onClose }) => {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileName = filePath.split('/').pop() ?? filePath;
  const ext = getExt(fileName);
  const isMarkdown = ext === '.md';
  const language = CODE_EXTS[ext] ?? 'plaintext';

  useEffect(() => {
    if (!open || !sandboxId || !filePath) return;
    setLoading(true);
    setContent(null);
    setError(null);

    sandboxesApi
      .readFile(sandboxId, filePath)
      .then((res) => setContent(typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2)))
      .catch((e) => setError(e?.response?.data?.message ?? e?.message ?? 'Failed to read file'))
      .finally(() => setLoading(false));
  }, [open, sandboxId, filePath]);

  const handleDownload = () => {
    if (content != null) {
      triggerDownload(content, fileName);
      message.success(`Downloaded ${fileName}`);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={620}
      placement="right"
      title={
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: 24 }}>
          <Text strong style={{ color: '#e8e8e8', fontFamily: 'monospace', fontSize: 13 }}>
            {fileName}
          </Text>
          {content != null && (
            <Tooltip title="Download">
              <Button
                size="small"
                icon={<DownloadOutlined />}
                onClick={handleDownload}
                style={{ borderColor: 'rgba(255,255,255,0.15)', color: '#d9d9d9', backgroundColor: 'transparent' }}
              />
            </Tooltip>
          )}
        </div>
      }
      styles={{
        content: { backgroundColor: '#0d1117' },
        header: {
          backgroundColor: '#1a1a2e',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          padding: '10px 24px',
        },
        body: { padding: 0 },
      }}
    >
      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
          <Spin indicator={<LoadingOutlined style={{ fontSize: 24, color: '#52c41a' }} spin />} />
        </div>
      )}

      {error && (
        <div style={{ padding: 24, color: '#ff4d4f', fontFamily: 'monospace', fontSize: 13 }}>
          {error}
        </div>
      )}

      {content != null && !loading && (
        isMarkdown ? (
          <div
            style={{
              padding: '16px 24px',
              color: '#d9d9d9',
              fontFamily: "'Inter', -apple-system, sans-serif",
              fontSize: 14,
              lineHeight: 1.7,
              overflowY: 'auto',
              height: '100%',
            }}
            className="sandbox-markdown-preview"
          >
            <style>{`
              .sandbox-markdown-preview h1,
              .sandbox-markdown-preview h2,
              .sandbox-markdown-preview h3 { color: #e8e8e8; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 6px; }
              .sandbox-markdown-preview a { color: #69b1ff; }
              .sandbox-markdown-preview code { background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px; font-size: 12px; }
              .sandbox-markdown-preview pre { background: #161b22; padding: 12px; border-radius: 6px; overflow-x: auto; }
              .sandbox-markdown-preview pre code { background: none; padding: 0; }
              .sandbox-markdown-preview blockquote { border-left: 3px solid #30363d; padding-left: 12px; color: #8b949e; margin-left: 0; }
              .sandbox-markdown-preview table { border-collapse: collapse; width: 100%; }
              .sandbox-markdown-preview th, .sandbox-markdown-preview td { border: 1px solid #30363d; padding: 6px 12px; }
              .sandbox-markdown-preview th { background: #161b22; }
              .sandbox-markdown-preview img { max-width: 100%; }
              .sandbox-markdown-preview hr { border: none; border-top: 1px solid #30363d; }
            `}</style>
            <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
          </div>
        ) : (
          <Editor
            height="100%"
            language={language}
            value={content}
            theme="vs-dark"
            options={{
              readOnly: true,
              minimap: { enabled: false },
              fontSize: 13,
              fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              padding: { top: 12 },
            }}
          />
        )
      )}
    </Drawer>
  );
};

export default FilePreviewDrawer;
