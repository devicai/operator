export { ExtensionProperty, ModuleConfig } from '../config/config.types';

export type ExtensionScope = Record<string, string>;

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}
