import { useEffect } from 'react';
import { Form, Input, InputNumber, Modal, Select, message } from 'antd';
import {
  useCreateSandboxProfile,
  useUpdateSandboxProfile,
} from '../../hooks/useSandboxProfiles';
import type { SandboxProfileDto } from '../../api/types';

const { TextArea } = Input;

interface Props {
  open: boolean;
  profile: SandboxProfileDto | null;
  onCancel: () => void;
}

const ProfileModal: React.FC<Props> = ({ open, profile, onCancel }) => {
  const [form] = Form.useForm();
  const createProfile = useCreateSandboxProfile();
  const updateProfile = useUpdateSandboxProfile();

  useEffect(() => {
    if (open) {
      if (profile) {
        form.setFieldsValue(profile);
      } else {
        form.resetFields();
      }
    }
  }, [open, profile, form]);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      if (profile) {
        await updateProfile.mutateAsync({ id: profile._id, dto: values });
        message.success('Profile updated');
      } else {
        await createProfile.mutateAsync(values);
        message.success('Profile created');
      }
      onCancel();
    } catch (e: any) {
      if (e?.errorFields) return;
      message.error(e?.response?.data?.message ?? e?.message ?? 'Save failed');
    }
  };

  return (
    <Modal
      open={open}
      title={profile ? 'Edit Profile' : 'New Profile'}
      onCancel={onCancel}
      onOk={handleSubmit}
      confirmLoading={createProfile.isPending || updateProfile.isPending}
      width={560}
    >
      <Form form={form} layout="vertical" size="small">
        <Form.Item name="name" label="Name" rules={[{ required: true }]}>
          <Input placeholder="Profile name" />
        </Form.Item>
        <Form.Item name="description" label="Description">
          <Input placeholder="Optional description" />
        </Form.Item>
        <Form.Item name="image" label="Image">
          <Select
            placeholder="node:24"
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
        <Form.Item name="initScript" label="Init Script">
          <TextArea
            rows={4}
            placeholder="#!/bin/bash&#10;npm install&#10;# Commands run on first sandbox creation"
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
        </Form.Item>
        <Form.Item name="networkPolicy" label="Network Policy">
          <Select
            placeholder="allow-all"
            options={[
              { label: 'Allow All', value: 'allow-all' },
              { label: 'Deny All', value: 'deny-all' },
            ]}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default ProfileModal;
