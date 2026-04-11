import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sandboxesApi } from '../api/client';
import type { CreateSandboxDto } from '../api/types';

const SANDBOXES_KEY = 'sandboxes';

export function useSandboxes(params?: { status?: string }) {
  return useQuery({
    queryKey: [SANDBOXES_KEY, params],
    queryFn: () => sandboxesApi.getAll(params).then((res) => res.data),
    refetchInterval: 10_000,
  });
}

export function useCreateSandbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dto: CreateSandboxDto) => sandboxesApi.create(dto).then((res) => res.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [SANDBOXES_KEY] }),
  });
}

export function useStopSandbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => sandboxesApi.stop(id).then((res) => res.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [SANDBOXES_KEY] }),
  });
}

export function useDestroySandbox() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => sandboxesApi.destroy(id).then((res) => res.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [SANDBOXES_KEY] }),
  });
}
