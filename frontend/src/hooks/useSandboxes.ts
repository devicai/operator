import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sandboxesApi } from '../api/client';
import type { CreateSandboxDto } from '../api/types';

const SANDBOXES_KEY = 'sandboxes';

export function useSandboxes(params?: {
  status?: string;
  snapshotId?: string;
  fromHotPool?: boolean;
  hotReserved?: boolean;
  limit?: number;
  offset?: number;
}) {
  return useQuery({
    queryKey: [SANDBOXES_KEY, params],
    queryFn: () => sandboxesApi.getAll(params).then((res) => res.data),
    // Faster while a capture is running, so the save indicator on a row keeps
    // up with the stages instead of jumping from "stopping" to gone. The
    // signal is the server's own `savingSnapshotId`, not anything the client
    // set — a page opened mid-save starts polling at the fast rate too.
    refetchInterval: (query) => {
      const rows = (query.state.data as any)?.data as
        | Array<{ savingSnapshotId?: string }>
        | undefined;
      return rows?.some((s) => s.savingSnapshotId) ? 2_000 : 10_000;
    },
    // Paging without this flickers back to the empty state on every page
    // change; keeping the previous page rendered makes it feel instant.
    placeholderData: (prev) => prev,
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
    mutationFn: (vars: { id: string; async?: boolean }) =>
      sandboxesApi.stop(vars.id, { async: vars.async }).then((res) => res.data),
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
