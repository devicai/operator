import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { sandboxProfilesApi } from '../api/client';
import type { CreateSandboxProfileDto, UpdateSandboxProfileDto } from '../api/types';

const PROFILES_KEY = 'sandbox-profiles';

export function useSandboxProfiles() {
  return useQuery({
    queryKey: [PROFILES_KEY],
    queryFn: () => sandboxProfilesApi.getAll().then((res) => res.data),
  });
}

export function useCreateSandboxProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dto: CreateSandboxProfileDto) => sandboxProfilesApi.create(dto).then((res) => res.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [PROFILES_KEY] }),
  });
}

export function useUpdateSandboxProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, dto }: { id: string; dto: UpdateSandboxProfileDto }) =>
      sandboxProfilesApi.update(id, dto).then((res) => res.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [PROFILES_KEY] }),
  });
}

export function useDeleteSandboxProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => sandboxProfilesApi.delete(id).then((res) => res.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [PROFILES_KEY] }),
  });
}
