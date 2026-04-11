import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { mcpProfilesApi } from '../api/client';
import type { CreateMcpProfileDto, UpdateMcpProfileDto } from '../api/types';

const MCP_PROFILES_KEY = 'mcp-profiles';
const MCP_AVAILABLE_TOOLS_KEY = 'mcp-available-tools';

export function useAvailableMcpTools() {
  return useQuery({
    queryKey: [MCP_AVAILABLE_TOOLS_KEY],
    queryFn: () => mcpProfilesApi.getAvailableTools().then((res) => res.data),
    staleTime: 60 * 60 * 1000,
  });
}

export function useMcpProfiles() {
  return useQuery({
    queryKey: [MCP_PROFILES_KEY],
    queryFn: () => mcpProfilesApi.getAll().then((res) => res.data),
  });
}

export function useCreateMcpProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dto: CreateMcpProfileDto) => mcpProfilesApi.create(dto).then((res) => res.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [MCP_PROFILES_KEY] }),
  });
}

export function useUpdateMcpProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, dto }: { id: string; dto: UpdateMcpProfileDto }) =>
      mcpProfilesApi.update(id, dto).then((res) => res.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [MCP_PROFILES_KEY] }),
  });
}

export function useDeleteMcpProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mcpProfilesApi.delete(id).then((res) => res.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [MCP_PROFILES_KEY] }),
  });
}
