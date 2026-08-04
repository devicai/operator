import { useEffect, useState } from 'react';
import { Progress, Space, Tag, Tooltip, Typography } from 'antd';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBoxArchive,
  faCircleCheck,
  faCircleExclamation,
  faLayerGroup,
  faTriangleExclamation,
} from '@fortawesome/free-solid-svg-icons';
import type { SaveStage, SnapshotDto } from '../../api/types';

const { Text } = Typography;

/**
 * What a save is doing, and what it left behind.
 *
 * A save used to be a single opaque "saving" that could sit there for two
 * minutes. It is now several stages with very different costs — a commit is
 * sub-second, refreshing the tarball is tens of seconds and happens in the
 * background after the caller was already told the save succeeded — so the
 * interesting thing to show is not a percentage but WHICH stage, and whether
 * the durable copy has caught up yet.
 */

const STAGES: Record<
  SaveStage,
  { label: string; hint: string; background?: boolean }
> = {
  claiming: {
    label: 'Claiming',
    hint: 'Taking exclusive hold of the snapshot so two saves cannot interleave.',
  },
  cleaning: {
    label: 'Cleaning caches',
    hint: 'Removing regenerable caches (apt, npm) so they never enter the image.',
  },
  committing: {
    label: 'Committing',
    hint: "Sealing the sandbox's writable layer as the snapshot's image.",
  },
  capturing: {
    label: 'Capturing',
    hint: 'Walking the filesystem and writing the compressed tarball.',
  },
  consolidating: {
    label: 'Consolidating',
    hint: 'Rebuilding the image from its base to give back layer headroom.',
    background: true,
  },
  tarball: {
    label: 'Refreshing tarball',
    hint: 'Rebuilding the portable copy from the image. The snapshot is already restorable.',
    background: true,
  },
};

/** Rough ordering, only so the reader sees movement rather than a progress lie. */
const STAGE_ORDER: SaveStage[] = [
  'claiming',
  'cleaning',
  'committing',
  'capturing',
  'consolidating',
  'tarball',
];

function useElapsed(since?: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return 0;
  return Math.max(0, Math.round((now - new Date(since).getTime()) / 1000));
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

const SaveStatus: React.FC<{ snapshot: SnapshotDto }> = ({ snapshot }) => {
  const stage = snapshot.saveStage;
  const elapsed = useElapsed(stage ? snapshot.saveStageSince : undefined);

  const lag = (snapshot.persistVersion ?? 0) - (snapshot.tarballVersion ?? 0);
  const lastError = snapshot.metadata?.lastSaveError as string | undefined;

  if (stage) {
    const info = STAGES[stage];
    const idx = STAGE_ORDER.indexOf(stage);
    return (
      <Tooltip
        title={
          <>
            <div>{info.hint}</div>
            {info.background && (
              <div style={{ marginTop: 6, opacity: 0.85 }}>
                Runs in the background — the snapshot is restorable right now.
              </div>
            )}
          </>
        }
      >
        <Space direction="vertical" size={0} style={{ lineHeight: 1.2 }}>
          <Space size={4}>
            <Tag
              color={info.background ? 'blue' : 'processing'}
              style={{ marginInlineEnd: 0, fontSize: 11 }}
            >
              {info.label}
            </Tag>
            <Text type="secondary" style={{ fontSize: 11 }}>
              {elapsed}s
            </Text>
          </Space>
          <Progress
            percent={Math.round(((idx + 1) / STAGE_ORDER.length) * 100)}
            showInfo={false}
            size="small"
            status="active"
            strokeWidth={3}
            style={{ width: 96, marginBottom: 0 }}
          />
        </Space>
      </Tooltip>
    );
  }

  // Idle. What matters now is how the last save went and whether the durable
  // copy is behind — a snapshot whose only fresh copy is a container image is
  // fine, but not something to leave unsaid.
  const method = snapshot.lastSaveMethod;
  const duration = snapshot.lastSaveDurationMs;

  return (
    <Space size={4} wrap>
      {method && (
        <Tooltip
          title={
            method === 'commit'
              ? "Sealed the sandbox's writable layer directly — no filesystem walk, no recompression."
              : 'Walked the filesystem and wrote a compressed tarball.'
          }
        >
          <Tag
            icon={
              <FontAwesomeIcon
                icon={method === 'commit' ? faLayerGroup : faBoxArchive}
                style={{ marginInlineEnd: 4 }}
              />
            }
            color={method === 'commit' ? 'geekblue' : 'default'}
            style={{ marginInlineEnd: 0, fontSize: 11 }}
          >
            {method}
            {duration !== undefined ? ` · ${formatDuration(duration)}` : ''}
          </Tag>
        </Tooltip>
      )}

      {!method && !lastError && (
        <Text type="secondary" style={{ fontSize: 11 }}>
          —
        </Text>
      )}

      {lag > 0 && (
        <Tooltip
          title={`The portable tarball is ${lag} version${lag > 1 ? 's' : ''} behind the image. Export, backups and host migration read the tarball, so until the background pass catches up the freshest copy of this snapshot exists only as a container image.`}
        >
          <Tag
            icon={
              <FontAwesomeIcon
                icon={faTriangleExclamation}
                style={{ marginInlineEnd: 4 }}
              />
            }
            color="orange"
            style={{ marginInlineEnd: 0, fontSize: 11 }}
          >
            tarball −{lag}
          </Tag>
        </Tooltip>
      )}

      {lastError && (
        <Tooltip title={lastError}>
          <Tag
            icon={
              <FontAwesomeIcon
                icon={faCircleExclamation}
                style={{ marginInlineEnd: 4 }}
              />
            }
            color="red"
            style={{ marginInlineEnd: 0, fontSize: 11 }}
          >
            failed
          </Tag>
        </Tooltip>
      )}

      {snapshot.imageLayers !== undefined && (
        <Tooltip
          title={`Image is ${snapshot.imageLayers} layers deep${
            snapshot.imageGeneration
              ? `, ${snapshot.imageGeneration} generation${snapshot.imageGeneration > 1 ? 's' : ''} since the last consolidation`
              : ''
          }. Layers stack once per session, not per save; consolidation rebuilds back to base+1.`}
        >
          <Tag
            icon={
              <FontAwesomeIcon
                icon={faCircleCheck}
                style={{ marginInlineEnd: 4 }}
              />
            }
            color="default"
            style={{ marginInlineEnd: 0, fontSize: 11 }}
          >
            {snapshot.imageLayers}L
          </Tag>
        </Tooltip>
      )}
    </Space>
  );
};

export default SaveStatus;
