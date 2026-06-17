export interface McpToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  description: string;
}

export interface AvailableMcpTool {
  name: string;
  description: string;
  writeAccess: boolean;
  parameters: McpToolParameter[];
}

const SANDBOX_ID_PARAM: McpToolParameter = {
  name: 'sandboxId',
  type: 'string',
  required: false,
  description:
    'Optional explicit sandbox id. When provided overrides the session-bound sandbox for this single call.',
};

export const AVAILABLE_MCP_TOOLS: AvailableMcpTool[] = [
  {
    name: 'create_sandbox',
    description:
      'Create a new sandbox environment or reuse an existing one. Without arguments returns the session-bound sandbox if one already exists; pass a bindingId for cross-session resolution or force=true to always allocate a fresh sandbox. Hot pool is used by default when no incompatible override (image/profileId) is present — pass useHotPool=false to skip it.',
    writeAccess: true,
    parameters: [
      { name: 'profileId', type: 'string', required: false, description: 'Sandbox profile ID for preconfigured settings' },
      { name: 'bindingId', type: 'string', required: false, description: 'External binding ID for implicit resolution' },
      { name: 'image', type: 'string', required: false, description: 'Docker image (default: node:24)' },
      { name: 'ttlSeconds', type: 'number', required: false, description: 'Time to live in seconds (default: 1800)' },
      { name: 'force', type: 'boolean', required: false, description: 'Create a fresh sandbox even if the session already has one bound' },
      { name: 'useHotPool', type: 'boolean', required: false, description: 'Override hot pool resolution: true forces an attempt (falls back to fresh create), false skips it. Defaults to true unless image/profileId would diverge from the pool snapshot.' },
    ],
  },
  {
    name: 'run_command',
    description:
      'Execute a shell command in the active sandbox. Returns stdout, stderr and exit code.',
    writeAccess: true,
    parameters: [
      { name: 'command', type: 'string', required: true, description: 'Shell command to execute' },
      { name: 'cwd', type: 'string', required: false, description: 'Working directory override' },
      SANDBOX_ID_PARAM,
    ],
  },
  {
    name: 'write_file',
    description:
      'Write content to a file in the sandbox workspace (/workspace), the persistent working directory. Paths are relative to the workspace; parent directories are created automatically. Writing outside the workspace is not allowed.',
    writeAccess: true,
    parameters: [
      { name: 'path', type: 'string', required: true, description: 'File path, relative to the workspace (/workspace). Paths outside the workspace are rejected.' },
      { name: 'content', type: 'string', required: true, description: 'File content to write' },
      SANDBOX_ID_PARAM,
    ],
  },
  {
    name: 'create_directory',
    description: 'Create a directory in the sandbox workspace (/workspace). Paths are relative to the workspace; creating directories outside it is not allowed.',
    writeAccess: true,
    parameters: [
      { name: 'path', type: 'string', required: true, description: 'Directory path to create, relative to the workspace (/workspace).' },
      SANDBOX_ID_PARAM,
    ],
  },
  {
    name: 'stop_sandbox',
    description: 'Stop the active sandbox. Creates a snapshot for potential restore.',
    writeAccess: true,
    parameters: [SANDBOX_ID_PARAM],
  },
  {
    name: 'extend_ttl',
    description: 'Extend the time to live of the active sandbox.',
    writeAccess: true,
    parameters: [
      { name: 'additionalSeconds', type: 'number', required: true, description: 'Additional seconds to add' },
      SANDBOX_ID_PARAM,
    ],
  },
  {
    name: 'upload_file',
    description: 'Download a file from a URL and save it into the sandbox workspace (/workspace). The destination is relative to the workspace; saving outside it is not allowed.',
    writeAccess: true,
    parameters: [
      { name: 'url', type: 'string', required: true, description: 'Public URL to download from' },
      { name: 'path', type: 'string', required: true, description: 'Destination path, relative to the workspace (/workspace). Paths outside the workspace are rejected.' },
      SANDBOX_ID_PARAM,
    ],
  },
  {
    name: 'get_sandbox_status',
    description: 'Get the current status of the sandbox including remaining TTL.',
    writeAccess: false,
    parameters: [SANDBOX_ID_PARAM],
  },
  {
    name: 'list_files',
    description: 'List files and directories in the sandbox.',
    writeAccess: false,
    parameters: [
      { name: 'path', type: 'string', required: false, description: 'Directory path to list (default: current working directory)' },
      SANDBOX_ID_PARAM,
    ],
  },
  {
    name: 'read_file',
    description: 'Read the content of a file in the sandbox.',
    writeAccess: false,
    parameters: [
      { name: 'path', type: 'string', required: true, description: 'File path to read' },
      SANDBOX_ID_PARAM,
    ],
  },
  {
    name: 'download_file',
    description: 'Get a download URL for a file in the sandbox. The file content is returned base64 encoded.',
    writeAccess: false,
    parameters: [
      { name: 'path', type: 'string', required: true, description: 'File path to download' },
      SANDBOX_ID_PARAM,
    ],
  },
];

export const MCP_TOOL_NAMES = AVAILABLE_MCP_TOOLS.map((t) => t.name);
