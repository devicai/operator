import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Drawer, Spin, Tooltip, Typography, message } from 'antd';
import { LoadingOutlined, UploadOutlined } from '@ant-design/icons';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircle, faDownload } from '@fortawesome/free-solid-svg-icons';
import { sandboxesApi } from '../../api/client';
import type { SandboxDto } from '../../api/types';
import FilePreviewDrawer, { isPreviewable, triggerDownload } from './FilePreviewDrawer';

const { Text } = Typography;

type TerminalLineType = 'command' | 'stdout' | 'stderr' | 'exit-code' | 'system';

interface TerminalLine {
  type: TerminalLineType;
  content: string;
  cwd?: string;
}

// ── ls output parsing ──────────────────────────────────────────────

function isLsCommand(command: string): boolean {
  const base = command.trim().split(/\s*[|;&]\s*/)[0];
  return base.trim().split(/\s+/)[0] === 'ls';
}

function hasLongFlag(command: string): boolean {
  const base = command.trim().split(/\s*[|;&]\s*/)[0];
  return base.trim().split(/\s+/).some((p) => p.startsWith('-') && p.includes('l'));
}

function extractFileFromLsLine(line: string): string | null {
  const trimmed = line.trim();
  if (!/^-[rwxsStT-]{9}/.test(trimmed)) return null;
  const fields = trimmed.split(/\s+/);
  if (fields.length < 9) return null;
  return fields.slice(8).join(' ');
}

// ── Clickable file span ────────────────────────────────────────────

const ClickableFile: React.FC<{
  fileName: string;
  onClick: (fileName: string, cwd: string) => void;
  cwd: string;
}> = ({ fileName, onClick, cwd }) => (
  <Tooltip title={isPreviewable(fileName) ? `Preview ${fileName}` : `Download ${fileName}`}>
    <span
      onClick={(e) => {
        e.stopPropagation();
        onClick(fileName, cwd);
      }}
      style={{
        color: '#69b1ff',
        cursor: 'pointer',
        borderBottom: '1px dashed rgba(105, 177, 255, 0.4)',
      }}
      onMouseEnter={(e) => {
        (e.target as HTMLSpanElement).style.borderBottomColor = '#69b1ff';
      }}
      onMouseLeave={(e) => {
        (e.target as HTMLSpanElement).style.borderBottomColor = 'rgba(105, 177, 255, 0.4)';
      }}
    >
      <FontAwesomeIcon icon={faDownload} style={{ fontSize: 10, marginRight: 4, opacity: 0.7 }} />
      {fileName}
    </span>
  </Tooltip>
);

// ── Stdout renderer with clickable files ───────────────────────────

const StdoutContent: React.FC<{
  content: string;
  lastCommand: string;
  commandCwd: string;
  onFileClick: (fileName: string, cwd: string) => void;
}> = ({ content, lastCommand, commandCwd, onFileClick }) => {
  const lsCmd = isLsCommand(lastCommand);
  const longFmt = lsCmd && hasLongFlag(lastCommand);
  const simpleFmt = lsCmd && !longFmt;

  const lines = content.split('\n');

  return (
    <pre
      style={{
        margin: 0,
        color: '#d9d9d9',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        fontFamily: 'inherit',
        fontSize: 'inherit',
        lineHeight: 'inherit',
      }}
    >
      {lines.map((line, i) => {
        if (longFmt) {
          const fileName = extractFileFromLsLine(line);
          if (fileName) {
            const idx = line.lastIndexOf(fileName);
            const prefix = line.slice(0, idx);
            return (
              <React.Fragment key={i}>
                {prefix}
                <ClickableFile fileName={fileName} onClick={onFileClick} cwd={commandCwd} />
                {i < lines.length - 1 ? '\n' : ''}
              </React.Fragment>
            );
          }
          return (
            <React.Fragment key={i}>
              {line}
              {i < lines.length - 1 ? '\n' : ''}
            </React.Fragment>
          );
        }

        if (simpleFmt) {
          const trimmed = line.trim();
          if (!trimmed || /^total\s+\d+/.test(trimmed)) {
            return (
              <React.Fragment key={i}>
                {line}
                {i < lines.length - 1 ? '\n' : ''}
              </React.Fragment>
            );
          }
          const entries = trimmed.split(/\s{2,}/);
          return (
            <React.Fragment key={i}>
              {entries.map((entry, j) => {
                const name = entry.trim();
                const looksLikeFile = name && name !== '.' && name !== '..' && /\.\w+$/.test(name);
                if (looksLikeFile) {
                  return (
                    <React.Fragment key={j}>
                      <ClickableFile fileName={name} onClick={onFileClick} cwd={commandCwd} />
                      {j < entries.length - 1 ? '  ' : ''}
                    </React.Fragment>
                  );
                }
                return (
                  <React.Fragment key={j}>
                    {name}
                    {j < entries.length - 1 ? '  ' : ''}
                  </React.Fragment>
                );
              })}
              {i < lines.length - 1 ? '\n' : ''}
            </React.Fragment>
          );
        }

        return (
          <React.Fragment key={i}>
            {line}
            {i < lines.length - 1 ? '\n' : ''}
          </React.Fragment>
        );
      })}
    </pre>
  );
};

// ── Line renderer ──────────────────────────────────────────────────

const TerminalLineRow: React.FC<{
  line: TerminalLine;
  lastCommand: string;
  commandCwd: string;
  onFileClick: (fileName: string, cwd: string) => void;
}> = ({ line, lastCommand, commandCwd, onFileClick }) => {
  switch (line.type) {
    case 'command':
      return (
        <div style={{ display: 'flex', gap: 8 }}>
          <span style={{ color: '#52c41a', flexShrink: 0 }}>{line.cwd ?? '~'} $</span>
          <span style={{ color: '#e8e8e8' }}>{line.content}</span>
        </div>
      );
    case 'stdout':
      return <StdoutContent content={line.content} lastCommand={lastCommand} commandCwd={commandCwd} onFileClick={onFileClick} />;
    case 'stderr':
      return (
        <pre style={{ margin: 0, color: '#ff4d4f', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'inherit', fontSize: 'inherit', lineHeight: 'inherit' }}>
          {line.content}
        </pre>
      );
    case 'exit-code':
      return <div style={{ color: '#faad14', fontSize: 12 }}>{line.content}</div>;
    case 'system':
      return <div style={{ color: '#8c8c8c', fontStyle: 'italic', fontSize: 12 }}>{line.content}</div>;
    default:
      return <div>{line.content}</div>;
  }
};

// ── Main component ─────────────────────────────────────────────────

interface Props {
  sandbox: SandboxDto | null;
  onClose: () => void;
}

const TerminalDrawer: React.FC<Props> = ({ sandbox, onClose }) => {
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [running, setRunning] = useState(false);
  const [currentCwd, setCurrentCwd] = useState('~');
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (sandbox) {
      setCurrentCwd(sandbox.currentCwd ?? '~');
      setLines([
        { type: 'system', content: `Connected to sandbox ${sandbox.sandboxId}` },
        { type: 'system', content: `Working directory: ${sandbox.currentCwd ?? '~'}` },
      ]);
      setInputValue('');
      setPreviewFile(null);
    } else {
      setLines([]);
      setCurrentCwd('~');
    }
  }, [sandbox]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [lines, running]);

  useEffect(() => {
    if (sandbox && !running && inputRef.current) {
      inputRef.current.focus();
    }
  }, [sandbox, running]);

  const handleFileClick = useCallback(
    async (fileName: string, fileCwd: string) => {
      if (!sandbox) return;
      const cwd = fileCwd.endsWith('/') ? fileCwd : `${fileCwd}/`;
      const fullPath = `${cwd}${fileName}`;

      if (isPreviewable(fileName)) {
        setPreviewFile(fullPath);
      } else {
        try {
          const res = await sandboxesApi.readFile(sandbox.sandboxId, fullPath);
          const content = typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2);
          triggerDownload(content, fileName);
          message.success(`Downloaded ${fileName}`);
        } catch (e: any) {
          message.error(e?.response?.data?.message ?? e?.message ?? 'Download failed');
        }
      }
    },
    [sandbox]
  );

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !sandbox) return;

      setIsUploading(true);
      const cwd = currentCwd.endsWith('/') ? currentCwd : `${currentCwd}/`;
      const destPath = `${cwd}${file.name}`;

      try {
        const content = await file.text();
        await sandboxesApi.writeFile(sandbox.sandboxId, destPath, content);
        setLines((prev) => [
          ...prev,
          { type: 'system', content: `Uploaded ${file.name} → ${destPath} (${(file.size / 1024).toFixed(1)} KB)` },
        ]);
        message.success(`Uploaded ${file.name}`);
      } catch (err: any) {
        message.error(err?.response?.data?.message ?? err?.message ?? 'Upload failed');
        setLines((prev) => [
          ...prev,
          { type: 'stderr', content: `Upload failed: ${err?.message ?? 'unknown error'}` },
        ]);
      } finally {
        setIsUploading(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [sandbox, currentCwd]
  );

  const handleSubmit = useCallback(async () => {
    const command = inputValue.trim();
    if (!command || !sandbox || running) return;

    setRunning(true);
    setLines((prev) => [...prev, { type: 'command', content: command, cwd: currentCwd }]);
    setInputValue('');

    try {
      const res = await sandboxesApi.runCommand(sandbox.sandboxId, command);
      const result = res.data;
      const newLines: TerminalLine[] = [];
      if (result.stdout) newLines.push({ type: 'stdout', content: result.stdout });
      if (result.stderr) newLines.push({ type: 'stderr', content: result.stderr });
      if (result.code !== 0) newLines.push({ type: 'exit-code', content: `[exit code: ${result.code}]` });
      if (result.cwd) setCurrentCwd(result.cwd);
      setLines((prev) => [...prev, ...newLines]);
    } catch (e: any) {
      message.error(e?.message ?? 'Command failed');
      setLines((prev) => [...prev, { type: 'stderr', content: `Error: ${e?.message ?? 'unknown'}` }]);
    } finally {
      setRunning(false);
    }
  }, [inputValue, sandbox, running, currentCwd]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') handleSubmit();
    },
    [handleSubmit]
  );

  const lastCommandInfoFor = (index: number): { command: string; cwd: string } => {
    for (let j = index - 1; j >= 0; j--) {
      if (lines[j].type === 'command') return { command: lines[j].content, cwd: lines[j].cwd ?? '~' };
    }
    return { command: '', cwd: currentCwd };
  };

  return (
    <>
      <Drawer
        open={!!sandbox}
        onClose={onClose}
        width={previewFile ? 900 : 820}
        placement="right"
        closable
        title={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingRight: 24 }}>
            <Text strong style={{ color: '#e8e8e8' }}>
              Sandbox Terminal — {sandbox?.name ?? ''}
            </Text>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <FontAwesomeIcon icon={faCircle} style={{ fontSize: 8, color: running ? '#faad14' : '#52c41a' }} />
              <Text style={{ fontSize: 12, color: '#9e9e9e' }}>{running ? 'Executing...' : 'Connected'}</Text>
            </div>
          </div>
        }
        styles={{
          content: { backgroundColor: '#1a1a2e' },
          header: { backgroundColor: '#1a1a2e', borderBottom: '1px solid rgba(255,255,255,0.08)', padding: '12px 24px' },
          body: { padding: 0, backgroundColor: '#1a1a2e' },
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div
            ref={terminalRef}
            onClick={() => inputRef.current?.focus()}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '12px 16px',
              fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
              fontSize: 13,
              lineHeight: 1.6,
              backgroundColor: '#0d1117',
              color: '#d9d9d9',
              cursor: 'text',
            }}
          >
            {lines.map((line, i) => {
              const info = lastCommandInfoFor(i);
              return (
                <TerminalLineRow key={i} line={line} lastCommand={info.command} commandCwd={info.cwd} onFileClick={handleFileClick} />
              );
            })}

            {!running && sandbox && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ color: '#52c41a', flexShrink: 0 }}>{currentCwd} $</span>
                <input
                  ref={inputRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  style={{
                    flex: 1,
                    background: 'transparent',
                    border: 'none',
                    outline: 'none',
                    color: '#e8e8e8',
                    fontFamily: 'inherit',
                    fontSize: 'inherit',
                    lineHeight: 'inherit',
                    padding: 0,
                    caretColor: '#52c41a',
                  }}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
            )}

            {running && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <Spin indicator={<LoadingOutlined style={{ fontSize: 12, color: '#52c41a' }} spin />} />
                <span style={{ color: '#8c8c8c', fontSize: 12 }}>Running...</span>
              </div>
            )}
          </div>

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '8px 16px',
              borderTop: '1px solid rgba(255,255,255,0.08)',
              backgroundColor: '#1a1a2e',
            }}
          >
            <Text style={{ fontSize: 11, color: '#666', fontFamily: 'monospace' }}>cwd: {currentCwd}</Text>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Tooltip title={`Upload file to ${currentCwd}`}>
                <Button
                  size="small"
                  icon={
                    isUploading ? (
                      <Spin indicator={<LoadingOutlined style={{ fontSize: 12, color: '#d9d9d9' }} spin />} />
                    ) : (
                      <UploadOutlined />
                    )
                  }
                  onClick={handleUploadClick}
                  disabled={isUploading || running}
                  style={{
                    borderColor: 'rgba(255,255,255,0.15)',
                    color: '#d9d9d9',
                    backgroundColor: 'transparent',
                  }}
                >
                  Upload
                </Button>
              </Tooltip>
              <Text style={{ fontSize: 11, color: '#666', fontFamily: 'monospace' }}>{sandbox?.sandboxId ?? ''}</Text>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              style={{ display: 'none' }}
              onChange={handleFileSelected}
            />
          </div>
        </div>
      </Drawer>

      {sandbox && (
        <FilePreviewDrawer
          open={!!previewFile}
          sandboxId={sandbox.sandboxId}
          filePath={previewFile ?? ''}
          onClose={() => setPreviewFile(null)}
        />
      )}
    </>
  );
};

export default TerminalDrawer;
