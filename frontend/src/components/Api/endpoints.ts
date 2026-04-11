export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export type ParamType = 'string' | 'number' | 'boolean';

export interface ParamSpec {
  name: string;
  type: ParamType;
  required?: boolean;
  description?: string;
  example?: string | number | boolean;
}

export interface BodySpec {
  description?: string;
  sample: string;
}

export interface EndpointSpec {
  id: string;
  category: string;
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  pathParams?: ParamSpec[];
  queryParams?: ParamSpec[];
  body?: BodySpec;
}

const CREATE_SANDBOX_SAMPLE = JSON.stringify(
  { profileId: null, image: 'node:24', cpus: 1, memoryMib: 256, ttlSeconds: 1800 },
  null, 2,
);

const RUN_COMMAND_SAMPLE = JSON.stringify(
  { command: 'ls -la', cwd: '/workspace' },
  null, 2,
);

const WRITE_FILE_SAMPLE = JSON.stringify(
  { path: '/workspace/hello.txt', content: 'Hello World!' },
  null, 2,
);

const CREATE_PROFILE_SAMPLE = JSON.stringify(
  { name: 'Node Dev', description: 'Node.js development environment', image: 'node:24', cpus: 2, memoryMib: 512, ttlSeconds: 3600, initScript: 'npm install' },
  null, 2,
);

const UPDATE_PROFILE_SAMPLE = JSON.stringify(
  { name: 'Updated Profile', memoryMib: 1024 },
  null, 2,
);

const CREATE_MCP_PROFILE_SAMPLE = JSON.stringify(
  { name: 'Agent Profile', allowedTools: ['create_sandbox', 'run_command', 'read_file'], readOnly: false },
  null, 2,
);

export const API_CATEGORIES = ['Sandboxes', 'Sandbox Profiles', 'MCP Profiles'];

export const API_ENDPOINTS: EndpointSpec[] = [
  // Sandboxes
  { id: 'list-sandboxes', category: 'Sandboxes', method: 'GET', path: '/sandboxes', summary: 'List sandboxes',
    queryParams: [
      { name: 'limit', type: 'number', description: 'Page size (default 20)' },
      { name: 'offset', type: 'number', description: 'Offset for pagination' },
      { name: 'status', type: 'string', description: 'Filter by status' },
    ],
  },
  { id: 'create-sandbox', category: 'Sandboxes', method: 'POST', path: '/sandboxes', summary: 'Create sandbox',
    body: { sample: CREATE_SANDBOX_SAMPLE },
  },
  { id: 'get-sandbox', category: 'Sandboxes', method: 'GET', path: '/sandboxes/:id', summary: 'Get sandbox by ID',
    pathParams: [{ name: 'id', type: 'string', required: true, description: 'Sandbox ID or sandboxId' }],
  },
  { id: 'get-sandbox-status', category: 'Sandboxes', method: 'GET', path: '/sandboxes/:id/status', summary: 'Get sandbox status with TTL',
    pathParams: [{ name: 'id', type: 'string', required: true }],
  },
  { id: 'run-command', category: 'Sandboxes', method: 'POST', path: '/sandboxes/:id/command', summary: 'Execute command in sandbox',
    pathParams: [{ name: 'id', type: 'string', required: true }],
    body: { sample: RUN_COMMAND_SAMPLE },
  },
  { id: 'stop-sandbox', category: 'Sandboxes', method: 'POST', path: '/sandboxes/:id/stop', summary: 'Stop sandbox',
    pathParams: [{ name: 'id', type: 'string', required: true }],
  },
  { id: 'extend-ttl', category: 'Sandboxes', method: 'POST', path: '/sandboxes/:id/extend-ttl', summary: 'Extend sandbox TTL',
    pathParams: [{ name: 'id', type: 'string', required: true }],
    body: { sample: JSON.stringify({ additionalSeconds: 600 }, null, 2) },
  },
  { id: 'read-file', category: 'Sandboxes', method: 'GET', path: '/sandboxes/:id/files', summary: 'Read file from sandbox',
    pathParams: [{ name: 'id', type: 'string', required: true }],
    queryParams: [{ name: 'path', type: 'string', required: true, description: 'File path in sandbox' }],
  },
  { id: 'write-file', category: 'Sandboxes', method: 'POST', path: '/sandboxes/:id/files', summary: 'Write file to sandbox',
    pathParams: [{ name: 'id', type: 'string', required: true }],
    body: { sample: WRITE_FILE_SAMPLE },
  },
  { id: 'destroy-sandbox', category: 'Sandboxes', method: 'DELETE', path: '/sandboxes/:id', summary: 'Destroy sandbox',
    pathParams: [{ name: 'id', type: 'string', required: true }],
  },
  { id: 'get-by-binding', category: 'Sandboxes', method: 'GET', path: '/sandboxes/by-binding/:bindingId', summary: 'Get sandbox by binding ID',
    pathParams: [{ name: 'bindingId', type: 'string', required: true }],
  },

  // Sandbox Profiles
  { id: 'list-profiles', category: 'Sandbox Profiles', method: 'GET', path: '/sandbox-profiles', summary: 'List sandbox profiles' },
  { id: 'create-profile', category: 'Sandbox Profiles', method: 'POST', path: '/sandbox-profiles', summary: 'Create sandbox profile',
    body: { sample: CREATE_PROFILE_SAMPLE },
  },
  { id: 'get-profile', category: 'Sandbox Profiles', method: 'GET', path: '/sandbox-profiles/:id', summary: 'Get sandbox profile',
    pathParams: [{ name: 'id', type: 'string', required: true }],
  },
  { id: 'update-profile', category: 'Sandbox Profiles', method: 'PATCH', path: '/sandbox-profiles/:id', summary: 'Update sandbox profile',
    pathParams: [{ name: 'id', type: 'string', required: true }],
    body: { sample: UPDATE_PROFILE_SAMPLE },
  },
  { id: 'delete-profile', category: 'Sandbox Profiles', method: 'DELETE', path: '/sandbox-profiles/:id', summary: 'Delete sandbox profile',
    pathParams: [{ name: 'id', type: 'string', required: true }],
  },

  // MCP Profiles
  { id: 'mcp-available-tools', category: 'MCP Profiles', method: 'GET', path: '/mcp-profiles/available-tools', summary: 'List available MCP tools' },
  { id: 'list-mcp-profiles', category: 'MCP Profiles', method: 'GET', path: '/mcp-profiles', summary: 'List MCP profiles' },
  { id: 'create-mcp-profile', category: 'MCP Profiles', method: 'POST', path: '/mcp-profiles', summary: 'Create MCP profile',
    body: { sample: CREATE_MCP_PROFILE_SAMPLE },
  },
  { id: 'get-mcp-profile', category: 'MCP Profiles', method: 'GET', path: '/mcp-profiles/:id', summary: 'Get MCP profile',
    pathParams: [{ name: 'id', type: 'string', required: true }],
  },
  { id: 'update-mcp-profile', category: 'MCP Profiles', method: 'PATCH', path: '/mcp-profiles/:id', summary: 'Update MCP profile',
    pathParams: [{ name: 'id', type: 'string', required: true }],
    body: { sample: CREATE_MCP_PROFILE_SAMPLE },
  },
  { id: 'delete-mcp-profile', category: 'MCP Profiles', method: 'DELETE', path: '/mcp-profiles/:id', summary: 'Delete MCP profile',
    pathParams: [{ name: 'id', type: 'string', required: true }],
  },
];
