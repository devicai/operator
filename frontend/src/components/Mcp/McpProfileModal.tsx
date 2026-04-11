import { useEffect } from 'react';
import { Checkbox, Form, Input, Modal, Select, Switch } from 'antd';
import type { AvailableMcpTool, McpProfileDto } from '../../api/types';
import { useSandboxProfiles } from '../../hooks/useSandboxProfiles';

const { TextArea } = Input;

interface Props {
  open: boolean;
  profile: McpProfileDto | null;
  loading: boolean;
  availableTools: AvailableMcpTool[];
  onCancel: () => void;
  onSubmit: (values: any) => void;
}

const McpProfileModal: React.FC<Props> = ({ open, profile, loading, availableTools, onCancel, onSubmit }) => {
  const [form] = Form.useForm();
  const { data: profilesData } = useSandboxProfiles();
  const sandboxProfiles = profilesData?.data ?? [];
  const readOnly = Form.useWatch('readOnly', form);

  useEffect(() => {
    if (open) {
      if (profile) {
        form.setFieldsValue(profile);
      } else {
        form.resetFields();
        form.setFieldsValue({
          readOnly: false,
          allowedTools: availableTools.filter((t) => !t.writeAccess).map((t) => t.name),
        });
      }
    }
  }, [open, profile, form, availableTools]);

  const readTools = availableTools.filter((t) => !t.writeAccess);
  const writeTools = availableTools.filter((t) => t.writeAccess);

  return (
    <Modal
      open={open}
      title={profile ? 'Edit MCP Profile' : 'New MCP Profile'}
      onCancel={onCancel}
      onOk={() => form.validateFields().then(onSubmit)}
      confirmLoading={loading}
      width={560}
    >
      <Form form={form} layout="vertical" size="small">
        <Form.Item name="name" label="Name" rules={[{ required: true }]}>
          <Input placeholder="Profile name" />
        </Form.Item>
        <Form.Item name="description" label="Description">
          <Input placeholder="Optional description" />
        </Form.Item>
        <Form.Item name="readOnly" label="Read-only" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item name="defaultSandboxProfileId" label="Default Sandbox Profile">
          <Select
            placeholder="Select default sandbox profile"
            allowClear
            options={sandboxProfiles.map((p) => ({
              label: `${p.name} (${p.image})`,
              value: p._id,
            }))}
          />
        </Form.Item>
        <Form.Item
          name="allowedTools"
          label="Allowed Tools"
          rules={[{ type: 'array', min: 1, message: 'At least 1 tool required' }]}
        >
          <Checkbox.Group style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 4, color: '#8c8c8c' }}>Read tools</div>
            {readTools.map((t) => (
              <Checkbox key={t.name} value={t.name} style={{ marginLeft: 0 }}>
                <code style={{ fontSize: 11 }}>{t.name}</code>
              </Checkbox>
            ))}
            {!readOnly && (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, marginTop: 8, marginBottom: 4, color: '#8c8c8c' }}>Write tools</div>
                {writeTools.map((t) => (
                  <Checkbox key={t.name} value={t.name} style={{ marginLeft: 0 }}>
                    <code style={{ fontSize: 11 }}>{t.name}</code>
                  </Checkbox>
                ))}
              </>
            )}
          </Checkbox.Group>
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default McpProfileModal;
