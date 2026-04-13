import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { snapshotsApi } from '../api/client';
import type { CreateSnapshotDto, RestoreSnapshotDto } from '../api/types';

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

export function useDeleteSnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      snapshotsApi.delete(id).then((res) => res.data),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: [SNAPSHOTS_KEY] }),
  });
}
