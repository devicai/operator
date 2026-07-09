import { useState } from 'react';
import { Form, Input, Modal, Progress, Typography, Upload, message } from 'antd';
import type { UploadFile } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import { useImportSnapshot } from '../../hooks/useSnapshots';

const { Text } = Typography;

interface ImportSnapshotModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Upload a ZIP of files and turn it into a workdir-scope snapshot: restoring
 * it lands the archive contents inside the sandbox working directory.
 */
const ImportSnapshotModal: React.FC<ImportSnapshotModalProps> = ({ open, onClose }) => {
  const [form] = Form.useForm();
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const importSnapshot = useImportSnapshot();

  const reset = () => {
    form.resetFields();
    setFileList([]);
    setProgress(null);
  };

  const handleOk = async () => {
    const file = fileList[0]?.originFileObj as File | undefined;
    if (!file) {
      message.warning('Select a ZIP file first');
      return;
    }
    try {
      const values = await form.validateFields();
      setProgress(0);
      const snapshot = await importSnapshot.mutateAsync({
        file,
        dto: { name: values.name, description: values.description },
        onProgress: setProgress,
      });
      message.success(`Snapshot ${snapshot.name} imported`);
      reset();
      onClose();
    } catch (e: any) {
      setProgress(null);
      if (!e?.errorFields) {
        message.error(e?.response?.data?.message ?? e?.message ?? 'Import failed');
      }
    }
  };

  return (
    <Modal
      title="Import Snapshot from ZIP"
      open={open}
      onCancel={() => {
        reset();
        onClose();
      }}
      onOk={handleOk}
      okText="Import"
      confirmLoading={importSnapshot.isPending}
      width={480}
    >
      <Text style={{ fontSize: 12, color: '#888' }}>
        The ZIP contents become a workdir snapshot: restoring it creates a
        sandbox with those files in its working directory.
      </Text>
      <Upload.Dragger
        style={{ marginTop: 16 }}
        accept=".zip,application/zip"
        maxCount={1}
        fileList={fileList}
        beforeUpload={() => false}
        onChange={({ fileList: fl }) => setFileList(fl.slice(-1))}
      >
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">Click or drag a ZIP file here</p>
      </Upload.Dragger>
      {progress !== null && (
        <Progress percent={progress} size="small" style={{ marginTop: 12 }} />
      )}
      <Form form={form} layout="vertical" size="small" style={{ marginTop: 16 }}>
        <Form.Item label="Name" name="name">
          <Input placeholder="imported-snapshot" />
        </Form.Item>
        <Form.Item label="Description" name="description">
          <Input.TextArea rows={2} />
        </Form.Item>
      </Form>
    </Modal>
  );
};

export default ImportSnapshotModal;
