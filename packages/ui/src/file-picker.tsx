import { Upload } from 'antd';
import type { UploadRef } from 'antd/es/upload/Upload';
import { forwardRef, useImperativeHandle, useRef } from 'react';

export type FilePickerHandle = { click: () => void };

export type FilePickerProps = {
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  'aria-label'?: string;
  onFilesSelected: (files: File[]) => void;
};

/** 只选择文件；上传、进度和重试仍交给调用方的现有业务流程。 */
export const FilePicker = forwardRef<FilePickerHandle, FilePickerProps>(
  ({ onFilesSelected, disabled, ...props }, ref) => {
    const uploadRef = useRef<UploadRef>(null);
    useImperativeHandle(
      ref,
      () => ({
        // Upload 每次选择后重建 input，点击时读取当前元素，允许重复选择同一文件。
        click: () => {
          if (!disabled)
            uploadRef.current?.nativeElement?.querySelector<HTMLInputElement>('input')?.click();
        },
      }),
      [disabled],
    );
    return (
      <span hidden>
        <Upload
          {...props}
          ref={uploadRef}
          disabled={disabled}
          showUploadList={false}
          openFileDialogOnClick={false}
          beforeUpload={(file, files) => {
            if (!disabled && file === files[0]) onFilesSelected(files);
            return Upload.LIST_IGNORE;
          }}
        />
      </span>
    );
  },
);
FilePicker.displayName = 'FilePicker';
