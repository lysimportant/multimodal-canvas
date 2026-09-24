import { Button as AntButton } from 'antd';
import { forwardRef, type ButtonHTMLAttributes } from 'react';

/** 按钮保留项目的原生表单事件与 variant 语义，渲染和状态交由 Ant Design。 */
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive';
  size?: 'default' | 'sm' | 'icon';
};

/** 统一按钮入口；type 仍表示原生表单行为，不与 Ant Design 的外观 type 混用。 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant, size, type = 'button', className, color, style, ...props }, ref) => (
    <AntButton
      {...props}
      ref={ref}
      htmlType={type}
      autoInsertSpace={false}
      style={{ color, ...style }}
      type={variant === 'default' ? 'primary' : variant === 'ghost' ? 'text' : 'default'}
      danger={variant === 'destructive'}
      size={size === 'sm' ? 'small' : 'middle'}
      className={['ui-button', size === 'icon' ? 'ui-button-icon' : '', className]
        .filter(Boolean)
        .join(' ')}
    />
  ),
);
Button.displayName = 'Button';
