import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { snapshotsApi } from '../api/client';
import type {
  CreateSnapshotDto,
  UpdateSnapshotDto,
  RestoreSnapshotDto,
  ImportSnapshotDto,
} from '../api/types';

const SNAPSHOTS_KEY = 'snapshots';
const SANDBOXES_KEY = 'sandboxes';

export function useSnapshots(params?: { sandboxId?: string }) {
  return useQuery({
    queryKey: [SNAPSHOTS_KEY, params],
    queryFn: () => snapshotsApi.getAll(params).then((res) => res.data),
    refetchInterval: 15_000,
  });
}

export function useCreateSnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dto: CreateSnapshotDto) =>
      snapshotsApi.create(dto).then((res) => res.data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [SNAPSHOTS_KEY] }),
  });
}

export function useRestoreSnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, dto }: { id: string; dto?: RestoreSnapshotDto }) =>
      snapshotsApi.restore(id, dto).then((res) => res.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [SNAPSHOTS_KEY] });
      queryClient.invalidateQueries({ queryKey: [SANDBOXES_KEY] });
    },
  });
}

export function useImportSnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      file,
      dto,
      onProgress,
    }: {
      file: File;
      dto?: ImportSnapshotDto;
      onProgress?: (percent: number) => void;
    }) => snapshotsApi.import(file, dto, onProgress).then((res) => res.data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [SNAPSHOTS_KEY] }),
  });
}

/**
 * Change how a snapshot is served: its subdomain, whether visiting it restores
 * it, and what to start afterwards. Invalidates the list so the table and the
 * restore dialog show the new values immediately.
 */
export function useUpdateSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, dto }: { id: string; dto: UpdateSnapshotDto }) =>
      snapshotsApi.update(id, dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['snapshots'] });
    },
  });
}

export function useDeleteSnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      snapshotsApi.delete(id).then((res) => res.data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [SNAPSHOTS_KEY] }),
  });
}
