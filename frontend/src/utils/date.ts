import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

dayjs.extend(relativeTime);

/** Absolute timestamp: `2026-07-09 14:32`. */
export function formatDateTime(iso?: string | null): string {
  if (!iso) return '-';
  return dayjs(iso).format('YYYY-MM-DD HH:mm');
}

/** Relative timestamp: `3 hours ago` / `in 20 minutes`. */
export function formatRelative(iso?: string | null): string {
  if (!iso) return '-';
  return dayjs(iso).fromNow();
}

/** Compact duration from seconds: `45s`, `30m`, `1h 30m`, `2d 4h`. */
export function formatDuration(seconds?: number | null): string {
  if (seconds === undefined || seconds === null || !Number.isFinite(seconds)) {
    return '-';
  }
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}

/** Bytes to a human-readable size: `1.5 MB`. */
export function formatSize(bytes?: number | null): string {
  if (bytes === undefined || bytes === null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
