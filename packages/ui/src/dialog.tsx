import { Modal } from 'antd';
import {
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { Button } from './button';

/** 保留旧调用方的受控开关；遮罩、滚动锁、焦点圈定和 Escape 由 Ant Design Modal 管理。 */
type DialogState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  titleId: string;
  descriptionId: string;
};
/** 仅在单个复合 Dialog 内传递标题标识和开关，不提供第二套弹层管理。 */
const DialogContext = createContext<DialogState | null>(null);

/** 读取所属对话框；组件离开 Dialog 时显式报错，避免按钮静默失效。 */
function useDialog() {
  const context = useContext(DialogContext);
  if (!context) throw new Error('Dialog 子组件必须位于 Dialog 内');
  return context;
}

/** 对话框可受控或使用 defaultOpen；modal 参数仅兼容旧接口，所有窗口均为模态。 */
export function Dialog({
  open,
  defaultOpen = false,
  onOpenChange,
  children,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  modal?: boolean;
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <DialogContext.Provider
      value={{
        open: open ?? internalOpen,
        titleId: id + '-title',
        descriptionId: id + '-description',
        setOpen: (next) => {
          setInternalOpen(next);
          onOpenChange?.(next);
        },
      }}
    >
      {children}
    </DialogContext.Provider>
  );
}

/** 旧复合式按钮支持把开关动作合并到已有按钮，不生成嵌套 button。 */
type DialogButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { asChild?: boolean };

/** 将 Dialog 开关动作附到子元素，保留子按钮的事件取消和 disabled 语义。 */
function DialogAction({
  asChild,
  children,
  open,
  onClick,
  ...props
}: DialogButtonProps & { open: boolean }) {
  const dialog = useDialog();
  const handleClick: ButtonHTMLAttributes<HTMLButtonElement>['onClick'] = (event) => {
    onClick?.(event);
    if (!event.defaultPrevented) dialog.setOpen(open);
  };
  if (asChild && isValidElement<ButtonHTMLAttributes<HTMLButtonElement>>(children)) {
    return cloneElement(children, {
      ...props,
      onClick: (event) => {
        children.props.onClick?.(event);
        if (!event.defaultPrevented) handleClick(event);
      },
    });
  }
  return (
    <Button {...props} onClick={handleClick}>
      {children}
    </Button>
  );
}

/** 打开所属 Dialog，支持把触发器保留为调用方已有组件。 */
export function DialogTrigger(props: DialogButtonProps) {
  return <DialogAction {...props} open />;
}
/** 关闭所属 Dialog，保留表单按钮的原生事件。 */
export function DialogClose(props: DialogButtonProps) {
  return <DialogAction {...props} open={false} />;
}

/** 旧弹窗样式与必要焦点钩子的兼容属性；取消事件 preventDefault 可阻止关闭。 */
export type DialogContentProps = HTMLAttributes<HTMLDivElement> & {
  contained?: boolean;
  overlayClassName?: string;
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  onPointerDownOutside?: (event: Event) => void;
};

/** 真实 Modal 承担弹层行为；适配层只保留当前窗口尺寸、样式和业务焦点回调。 */
export const DialogContent = forwardRef<HTMLDivElement, DialogContentProps>(
  (
    {
      children,
      contained = false,
      overlayClassName,
      className,
      style,
      onOpenAutoFocus,
      onCloseAutoFocus,
      onEscapeKeyDown,
      onPointerDownOutside,
      ...props
    },
    ref,
  ) => {
    const dialog = useDialog();
    const previousOpen = useRef(false);
    const opener = useRef<HTMLElement | null>(null);
    const closeFocus = useRef(onCloseAutoFocus);
    const mounted = useRef(false);
    const panelElement = useRef<HTMLDivElement | null>(null);
    closeFocus.current = onCloseAutoFocus;
    const hasExplicitDescription = 'aria-describedby' in props;
    const syncPanelAccessibility = (element: HTMLDivElement | null) => {
      if (!element) return;
      // Modal 不向面板透传 ARIA 属性；直接关联可见标题和描述，避免悬空引用。
      element.setAttribute('role', props.role ?? 'dialog');
      if (props['aria-label']) {
        element.setAttribute('aria-label', props['aria-label']);
        element.removeAttribute('aria-labelledby');
      } else {
        element.setAttribute(
          'aria-labelledby',
          props['aria-labelledby'] ??
            element.querySelector('[data-slot="dialog-title"]')?.id ??
            dialog.titleId,
        );
        element.removeAttribute('aria-label');
      }
      // 显式 undefined 关闭自动关联；否则只引用实际描述节点。
      const descriptionId = hasExplicitDescription
        ? props['aria-describedby']
        : element.querySelector('[data-slot="dialog-description"]')?.id;
      if (descriptionId) element.setAttribute('aria-describedby', descriptionId);
      else element.removeAttribute('aria-describedby');
    };
    if (dialog.open && !previousOpen.current) {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    previousOpen.current = dialog.open;
    useEffect(() => {
      mounted.current = true;
      return () => {
        mounted.current = false;
        // 延后一轮区分 StrictMode 重挂载与旧业务的直接卸载；后者没有库退出回调。
        queueMicrotask(() => {
          if (mounted.current || !previousOpen.current) return;
          const event = new Event('closeAutoFocus', { cancelable: true });
          closeFocus.current?.(event);
          if (!event.defaultPrevented && opener.current?.isConnected)
            opener.current.focus({ preventScroll: true });
        });
      };
    }, []);
    useEffect(() => {
      syncPanelAccessibility(panelElement.current);
    }, [
      children,
      dialog.open,
      hasExplicitDescription,
      props['aria-describedby'],
      props['aria-label'],
      props['aria-labelledby'],
      props.role,
    ]);
    return (
      <Modal
        open={dialog.open}
        centered={!contained}
        destroyOnHidden
        footer={null}
        closable={false}
        title={null}
        panelRef={(element) => {
          panelElement.current = element;
          syncPanelAccessibility(element);
          if (typeof ref === 'function') ref(element);
          else if (ref) ref.current = element;
        }}
        // 显式业务宽度优先；未传入时让现有窗口 CSS 决定尺寸。
        width={style?.width ?? (contained ? 410 : '')}
        className={['ui-dialog', contained ? 'ui-dialog-contained' : '', className]
          .filter(Boolean)
          .join(' ')}
        classNames={{ mask: overlayClassName }}
        styles={{
          header: { display: 'none' },
          body: { display: 'contents' },
          container: { display: 'contents' },
        }}
        style={style}
        focusable={{ focusTriggerAfterClose: !onCloseAutoFocus }}
        onCancel={(event) => {
          const nativeEvent = event instanceof Event ? event : event.nativeEvent;
          if ('key' in nativeEvent) onEscapeKeyDown?.(nativeEvent as KeyboardEvent);
          else onPointerDownOutside?.(nativeEvent);
          if (!nativeEvent.defaultPrevented && !event.defaultPrevented) dialog.setOpen(false);
        }}
        afterOpenChange={(open) => {
          const event = new Event(open ? 'openAutoFocus' : 'closeAutoFocus', { cancelable: true });
          if (open) onOpenAutoFocus?.(event);
          else {
            onCloseAutoFocus?.(event);
            // 有回调时库不回焦；只有 preventDefault 才取消默认恢复。
            if (onCloseAutoFocus && !event.defaultPrevented && opener.current?.isConnected)
              opener.current.focus({ preventScroll: true });
          }
        }}
        modalRender={(node) => (
          <div {...props} className="ui-dialog-content" role={undefined}>
            {node}
          </div>
        )}
      >
        {children}
      </Modal>
    );
  },
);
DialogContent.displayName = 'DialogContent';

/** 保持调用方标题位置，使用共享标识连接窗口内容。 */
export const DialogTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  ({ id, ...props }, ref) => {
    const dialog = useDialog();
    return <h2 data-slot="dialog-title" {...props} ref={ref} id={id ?? dialog.titleId} />;
  },
);
DialogTitle.displayName = 'DialogTitle';

/** 保持描述的原始内容与排版。 */
export const DialogDescription = forwardRef<
  HTMLParagraphElement,
  HTMLAttributes<HTMLParagraphElement>
>(({ id, ...props }, ref) => {
  const dialog = useDialog();
  return <p data-slot="dialog-description" {...props} ref={ref} id={id ?? dialog.descriptionId} />;
});
DialogDescription.displayName = 'DialogDescription';
