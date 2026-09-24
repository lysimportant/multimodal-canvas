import { Input as AntInput, type InputRef } from 'antd';
import { forwardRef, useImperativeHandle, useRef, type InputHTMLAttributes } from 'react';

/** 兼容原生输入属性、IME 事件与 HTMLInputElement 引用的组件库输入框。 */
export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/** 将 Ant Design 的组件引用映射到实际 input，保持现有焦点、选区与表单代码。 */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ size, className, ...props }, ref) => {
    const inputRef = useRef<InputRef>(null);
    useImperativeHandle(ref, () => inputRef.current!.input!, []);
    return (
      <AntInput
        {...props}
        ref={inputRef}
        htmlSize={size}
        className={['ui-input', className].filter(Boolean).join(' ')}
      />
    );
  },
);
Input.displayName = 'Input';
