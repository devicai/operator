import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { hotPoolApi } from '../api/client';
import type { HotPoolConfig } from '../api/types';

const HOT_POOL_KEY = 'hot-pool';

export function useHotPoolStatus() {
  return useQuery({
    queryKey: [HOT_POOL_KEY, 'status'],
    queryFn: () => hotPoolApi.status().then((res) => res.data),
    refetchInterval: 5_000,
  });
}

export function useUpdateHotPoolConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: Partial<HotPoolConfig>) =>
      hotPoolApi.updateConfig(dto).then((res) => res.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [HOT_POOL_KEY] });
      qc.invalidateQueries({ queryKey: ['usage'] });
      qc.invalidateQueries({ queryKey: ['sandboxes'] });
    },
  });
}

export function useReconcileHotPool() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => hotPoolApi.reconcile().then((res) => res.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [HOT_POOL_KEY] });
      qc.invalidateQueries({ queryKey: ['sandboxes'] });
    },
  });
}
