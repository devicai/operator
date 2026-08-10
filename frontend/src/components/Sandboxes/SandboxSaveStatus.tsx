import { Space, Tag, Tooltip, Typography } from 'antd';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faFloppyDisk, faLinkSlash } from '@fortawesome/free-solid-svg-icons';
import type { SandboxDto, SnapshotDto } from '../../api/types';
import SaveStatus from '../Snapshots/SaveStatus';

const { Text } = Typography;

/**
 * Where a sandbox stands with respect to keeping its work.
 *
 * The save lives on the snapshot, but the workflow is "stop and keep the
 * changes", so this is where someone looks for it. Nothing here is started or
 * tracked by the client: `savingSnapshotId` is written on the sandbox document
 * for the duration of the capture, so a page opened halfway through a save
 * shows that save.
 *
 * Two cases are deliberately NOT collapsed into "last save":
 *
 * - Several sandboxes can be restored from one snapshot, so the snapshot's last
 *   save may well be a sibling's. Attributing it to this row would be a plain
 *   lie, so the last-save readout only appears when this sandbox is the one that
 *   produced it (`metadata.lastPersistedFrom`).
 * - An unlinked sandbox gets said so rather than left blank, because that is the
 *   case that surprises people: stopping it keeps nothing, and an empty cell
 *   reads as "nothing has happened yet".
 */
const SandboxSaveStatus: React.FC<{
  sandbox: SandboxDto;
  snapshots: Map<string, SnapshotDto>;
}> = ({ sandbox, snapshots }) => {
  const target = sandbox.savingSnapshotId ?? sandbox.snapshotId;

  if (!target) {
    return (
      <Tooltip title="Not linked to a snapshot. Stopping this sandbox keeps nothing — restore from a snapshot, or fork one, to get a sandbox whose changes are saved.">
        <Tag
          icon={<FontAwesomeIcon icon={faLinkSlash} style={{ marginInlineEnd: 4 }} />}
          style={{ marginInlineEnd: 0, fontSize: 11 }}
        >
          not linked
        </Tag>
      </Tooltip>
    );
  }

  const snapshot = snapshots.get(target);
  if (!snapshot) {
    // Linked to something this page has not loaded (filtered out, or deleted).
    return (
      <Text type="secondary" style={{ fontSize: 11 }}>
        {target}
      </Text>
    );
  }

  // Mid-capture, or this sandbox produced the last one: either way the snapshot
  // document is describing THIS sandbox's work, so show it in full.
  const isSaving = Boolean(sandbox.savingSnapshotId);
  const ownsLastSave =
    (snapshot.metadata?.lastPersistedFrom as string | undefined) ===
    sandbox.sandboxId;

  if (isSaving || ownsLastSave) return <SaveStatus snapshot={snapshot} />;

  // Linked, but the snapshot's history belongs to someone else. What is true
  // and useful here is where this sandbox's changes will go when it stops.
  return (
    <Tooltip
      title={`Changes are kept on stop, into snapshot ${snapshot.name || target}. Its current contents were last written by another sandbox, so nothing here describes this one yet.`}
    >
      <Space size={4}>
        <Tag
          icon={<FontAwesomeIcon icon={faFloppyDisk} style={{ marginInlineEnd: 4 }} />}
          color="default"
          style={{ marginInlineEnd: 0, fontSize: 11 }}
        >
          saves on stop
        </Tag>
      </Space>
    </Tooltip>
  );
};

export default SandboxSaveStatus;
