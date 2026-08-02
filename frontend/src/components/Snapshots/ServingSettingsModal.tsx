import { useEffect } from 'react';
import { Alert, Form, Input, Modal, Switch, Typography, message } from 'antd';
import { useUpdateSnapshot } from '../../hooks/useSnapshots';
import type { SnapshotDto } from '../../api/types';

const { Text } = Typography;

/** RFC 1123 label — what a subdomain has to be. */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

interface Props {
  snapshot: SnapshotDto | null;
  onClose: () => void;
}

/**
 * Edits how a snapshot is served: the address it answers on, whether visiting
 * that address restores it, and what to run once it is back.
 *
 * These three live on the snapshot rather than on a sandbox because the
 * snapshot is what survives — a restore mints a new sandbox every time, so a
 * URL can only point at the snapshot behind it.
 */
const ServingSettingsModal: React.FC<Props> = ({ snapshot, onClose }) => {
  const [form] = Form.useForm();
  const update = useUpdateSnapshot();

  useEffect(() => {
    if (!snapshot) return;
    form.setFieldsValue({
      slug: snapshot.slug ?? '',
      autoRestart: snapshot.autoRestart !== false,
      startCommand: snapshot.startCommand ?? '',
    });
  }, [snapshot, form]);

  const handleOk = async () => {
    if (!snapshot) return;
    try {
      const values = await form.validateFields();
      await update.mutateAsync({
        id: snapshot.snapshotId,
        dto: {
          // Empty releases the subdomain and falls back to the derived label,
          // so null is the value that means "no slug" — not an empty string.
          slug: values.slug?.trim() ? values.slug.trim().toLowerCase() : null,
          autoRestart: values.autoRestart,
          startCommand: values.startCommand?.trim() || null,
        },
      });
      message.success('Serving settings saved');
      onClose();
    } catch (e: any) {
      if (!e?.errorFields) {
        message.error(e?.response?.data?.message ?? e?.message ?? 'Failed');
      }
    }
  };

  return (
    <Modal
      title="How this snapshot is served"
      open={Boolean(snapshot)}
      onCancel={onClose}
      onOk={handleOk}
      confirmLoading={update.isPending}
      okText="Save"
      width={520}
    >
      {snapshot && (
        <div style={{ marginBottom: 16 }}>
          <Text style={{ fontSize: 12, color: '#888' }}>
            <code>{snapshot.name}</code>
          </Text>
          {snapshot.publicUrl && (
            <div style={{ marginTop: 4 }}>
              <Text copyable={{ text: snapshot.publicUrl }} style={{ fontSize: 12 }}>
                <a href={snapshot.publicUrl} target="_blank" rel="noreferrer">
                  {snapshot.publicUrl}
                </a>
              </Text>
            </div>
          )}
        </div>
      )}

      <Form form={form} layout="vertical" size="small">
        <Form.Item
          label="Subdomain"
          name="slug"
          extra="Leave empty to use one derived from the snapshot id. The URL is stable either way; a slug only makes it memorable."
          rules={[
            {
              validator: (_, value) =>
                !value?.trim() ||
                (value.trim().length <= 63 && DNS_LABEL.test(value.trim().toLowerCase()))
                  ? Promise.resolve()
                  : Promise.reject(
                      new Error(
                        'Lowercase letters, digits and hyphens (not at the start or end), up to 63 characters',
                      ),
                    ),
            },
          ]}
        >
          <Input placeholder="my-app" />
        </Form.Item>

        <Form.Item
          label="Restart on visit"
          name="autoRestart"
          valuePropName="checked"
          extra="Opening the URL while nothing is running restores this snapshot and shows a loading page until the service answers."
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label="Start command"
          name="startCommand"
          extra="Runs after every restore, detached. Output goes to /tmp/.devic-start.log inside the sandbox."
        >
          <Input.TextArea rows={2} placeholder="cd /workspace && npm start" />
        </Form.Item>
      </Form>

      <Alert
        type="info"
        showIcon
        message="A snapshot restores files, not processes"
        description="Without a start command a restored sandbox comes up with nothing listening, and the URL will report exactly that."
        style={{ fontSize: 12 }}
      />
    </Modal>
  );
};

export default ServingSettingsModal;
