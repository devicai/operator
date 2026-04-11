import { useEffect, useRef, useState } from 'react';
import { Button, Drawer, Input, Space, message } from 'antd';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPaperPlane } from '@fortawesome/free-solid-svg-icons';
import { sandboxesApi } from '../../api/client';
import type { SandboxDto } from '../../api/types';

interface Props {
  sandbox: SandboxDto | null;
  onClose: () => void;
}

const TerminalDrawer: React.FC<Props> = ({ sandbox, onClose }) => {
  const [output, setOutput] = useState<string[]>([]);
  const [command, setCommand] = useState('');
  const [running, setRunning] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (sandbox) {
      setOutput([`Connected to sandbox ${sandbox.sandboxId}`, `Working directory: ${sandbox.currentCwd}`, '']);
    } else {
      setOutput([]);
    }
  }, [sandbox]);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const handleRun = async () => {
    if (!command.trim() || !sandbox) return;
    setRunning(true);
    setOutput((prev) => [...prev, `$ ${command}`]);
    setCommand('');

    try {
      const res = await sandboxesApi.runCommand(sandbox.sandboxId, command);
      const result = res.data;
      const lines: string[] = [];
      if (result.stdout) lines.push(result.stdout);
      if (result.stderr) lines.push(result.stderr);
      if (result.code !== 0) lines.push(`[exit code: ${result.code}]`);
      lines.push('');
      setOutput((prev) => [...prev, ...lines]);
    } catch (e: any) {
      message.error(e?.message ?? 'Command failed');
      setOutput((prev) => [...prev, `Error: ${e?.message}`, '']);
    } finally {
      setRunning(false);
    }
  };

  return (
    <Drawer
      open={!!sandbox}
      title={`Terminal — ${sandbox?.name ?? ''}`}
      onClose={onClose}
      width={700}
      placement="right"
    >
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div
          ref={outputRef}
          style={{
            flex: 1,
            backgroundColor: '#0d0d0d',
            color: '#00ff00',
            fontFamily: 'monospace',
            fontSize: 13,
            padding: 12,
            borderRadius: 6,
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            marginBottom: 12,
          }}
        >
          {output.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onPressEnter={handleRun}
            placeholder="Enter command..."
            disabled={running}
            style={{
              fontFamily: 'monospace',
              backgroundColor: '#1a1a1a',
              color: '#d9d9d9',
            }}
          />
          <Button
            type="primary"
            icon={<FontAwesomeIcon icon={faPaperPlane} />}
            onClick={handleRun}
            loading={running}
          />
        </Space.Compact>
      </div>
    </Drawer>
  );
};

export default TerminalDrawer;
