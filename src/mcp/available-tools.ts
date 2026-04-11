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

export const AVAILABLE_MCP_TOOLS: AvailableMcpTool[] = [
  {
    name: 'create_sandbox',
    description:
      'Create a new sandbox environment. Optionally specify a profile for preconfigured settings, or pass a bindingId to reuse an existing sandbox.',
    writeAccess: true,
    parameters: [
      { name: 'profileId', type: 'string', required: false, description: 'Sandbox profile ID for preconfigured settings' },
      { name: 'bindingId', type: 'string', required: false, description: 'External binding ID for implicit resolution' },
      { name: 'image', type: 'string', required: false, description: 'Docker image (default: node:24)' },
      { name: 'ttlSeconds', type: 'number', required: false, description: 'Time to live in seconds (default: 1800)' },
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
    ],
  },
  {
    name: 'write_file',
    description: 'Write content to a file in the sandbox.',
    writeAccess: true,
    parameters: [
      { name: 'path', type: 'string', required: true, description: 'File path in the sandbox' },
      { name: 'content', type: 'string', required: true, description: 'File content to write' },
    ],
  },
  {
    name: 'create_directory',
    description: 'Create a directory in the sandbox.',
    writeAccess: true,
    parameters: [
      { name: 'path', type: 'string', required: true, description: 'Directory path to create' },
    ],
  },
  {
    name: 'stop_sandbox',
    description: 'Stop the active sandbox. Creates a snapshot for potential restore.',
    writeAccess: true,
    parameters: [],
  },
  {
    name: 'extend_ttl',
    description: 'Extend the time to live of the active sandbox.',
    writeAccess: true,
    parameters: [
      { name: 'additionalSeconds', type: 'number', required: true, description: 'Additional seconds to add' },
    ],
  },
  {
    name: 'upload_file',
    description: 'Download a file from a URL and save it to the sandbox.',
    writeAccess: true,
    parameters: [
      { name: 'url', type: 'string', required: true, description: 'Public URL to download from' },
      { name: 'path', type: 'string', required: true, description: 'Destination path in the sandbox' },
    ],
  },
  {
    name: 'get_sandbox_status',
    description: 'Get the current status of the sandbox including remaining TTL.',
    writeAccess: false,
    parameters: [],
  },
  {
    name: 'list_files',
    description: 'List files and directories in the sandbox.',
    writeAccess: false,
    parameters: [
      { name: 'path', type: 'string', required: false, description: 'Directory path to list (default: current working directory)' },
    ],
  },
  {
    name: 'read_file',
    description: 'Read the content of a file in the sandbox.',
    writeAccess: false,
    parameters: [
      { name: 'path', type: 'string', required: true, description: 'File path to read' },
    ],
  },
  {
    name: 'download_file',
    description: 'Get a download URL for a file in the sandbox. The file content is returned base64 encoded.',
    writeAccess: false,
    parameters: [
      { name: 'path', type: 'string', required: true, description: 'File path to download' },
    ],
  },
];

export const MCP_TOOL_NAMES = AVAILABLE_MCP_TOOLS.map((t) => t.name);
