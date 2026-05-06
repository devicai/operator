import { useQuery } from '@tanstack/react-query';
import { usageApi } from '../api/client';

const USAGE_KEY = 'usage';

export function useUsage() {
  return useQuery({
    queryKey: [USAGE_KEY],
    queryFn: () => usageApi.get().then((res) => res.data),
    refetchInterval: 10_000,
  });
}
