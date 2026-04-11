import { Form, Input, InputNumber, Modal, Select, message } from 'antd';
import { useCreateSandbox } from '../../hooks/useSandboxes';
import { useSandboxProfiles } from '../../hooks/useSandboxProfiles';

interface Props {
  open: boolean;
  onCancel: () => void;
}

const CreateSandboxModal: React.FC<Props> = ({ open, onCancel }) => {
  const [form] = Form.useForm();
  const createSandbox = useCreateSandbox();
  const { data: profilesData } = useSandboxProfiles();
  const profiles = profilesData?.data ?? [];

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      await createSandbox.mutateAsync(values);
      message.success('Sandbox created');
      form.resetFields();
      onCancel();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e?.response?.data?.message ?? e?.message ?? 'Create failed');
    }
  };

  return (
    <Modal
      open={open}
      title="Create Sandbox"
      onCancel={onCancel}
      onOk={handleSubmit}
      confirmLoading={createSandbox.isPending}
      width={520}
    >
      <Form form={form} layout="vertical" size="small">
        <Form.Item name="profileId" label="Profile">
          <Select
            placeholder="Select a profile (optional)"
            allowClear
            options={profiles.map((p) => ({
              label: `${p.name} (${p.image})`,
              value: p._id,
            }))}
          />
        </Form.Item>
        <Form.Item name="bindingId" label="Binding ID">
          <Input placeholder="Optional external binding identifier" />
        </Form.Item>
        <Form.Item name="image" label="Image">
          <Select
            placeholder="Default from profile or node:24"
            allowClear
            options={[
              { label: 'node:24', value: 'node:24' },
              { label: 'node:22', value: 'node:22' },
              { label: 'python:3.13', value: 'python:3.13' },
            ]}
          />
        </Form.Item>
        <div style={{ display: 'flex', gap: 12 }}>
          <Form.Item name="cpus" label="CPUs" style={{ flex: 1 }}>
            <InputNumber min={1} max={8} placeholder="1" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="memoryMib" label="Memory (MiB)" style={{ flex: 1 }}>
            <InputNumber min={256} max={8192} step={256} placeholder="256" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="ttlSeconds" label="TTL (seconds)" style={{ flex: 1 }}>
            <InputNumber min={60} max={7200} placeholder="1800" style={{ width: '100%' }} />
          </Form.Item>
        </div>
      </Form>
    </Modal>
  );
};

export default CreateSandboxModal;
