import { Input } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { forwardRef, useImperativeHandle, useRef, type TextareaHTMLAttributes } from 'react';

/** 保留原生文本域事件和选区的 Ant Design 文本域属性。 */
export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

/** 不启用 autoSize，避免提示词或回显内容擅自改变画布节点的尺寸。 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    const textareaRef = useRef<TextAreaRef>(null);
    useImperativeHandle(ref, () => textareaRef.current!.resizableTextArea!.textArea, []);
    return (
      <Input.TextArea
        {...props}
        ref={textareaRef}
        autoSize={false}
        className={['ui-textarea', className].filter(Boolean).join(' ')}
      />
    );
  },
);
Textarea.displayName = 'Textarea';
