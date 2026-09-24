import { Popover } from 'antd';
import { Button } from '@multimodal-canvas/ui';
import { ChevronDown, WandSparkles } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import './PromptSkillSettings.css';

/** 只承载配置展示；关闭不卸载外层优化会话、不触发请求、不清除预览。 */
type PromptSkillSettingsProps = {
  /** 当前节点保存了技能选择时显示选中状态。 */
  selected: boolean;
  /** 技能、模型与显式优化操作。 */
  children: ReactNode;
};

/** 用 Popover 实现悬停展开与点击固定，嵌套 Select 交由浮层系统识别。 */
export function PromptSkillSettings({ selected, children }: PromptSkillSettingsProps) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    /** 配置外获得焦点时仅收起面板，优化预览和排队任务继续保留。 */
    const dismissOnFocus = (event: FocusEvent) => {
      if (
        event.target instanceof Node &&
        !contentRef.current?.contains(event.target) &&
        !triggerRef.current?.contains(event.target)
      ) {
        setOpen(false);
        setPinned(false);
      }
    };
    document.addEventListener('focusin', dismissOnFocus);
    return () => document.removeEventListener('focusin', dismissOnFocus);
  }, [open]);

  return (
    <div className="prompt-skill-settings">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setPinned(false);
        }}
        trigger={pinned ? ['click'] : ['hover', 'click']}
        placement="topLeft"
        mouseEnterDelay={0}
        mouseLeaveDelay={0.18}
        destroyOnHidden
        getPopupContainer={(trigger) =>
          trigger.closest<HTMLElement>('[role="dialog"]') ?? document.body
        }
        classNames={{ root: 'prompt-skill-antd-popover' }}
        styles={{ root: { pointerEvents: 'auto' } }}
        content={
          <div ref={contentRef} role="dialog" aria-label="Skill 设置浮层">
            <div id={id} role="group" aria-label="Skill 配置">
              {children}
            </div>
          </div>
        }
      >
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          className="prompt-skill-trigger"
          aria-label="Skill 配置"
          aria-expanded={open}
          aria-controls={id}
          aria-haspopup="dialog"
          data-selected={selected || undefined}
          onClick={() => {
            const next = !open || !pinned;
            setPinned(next);
            setOpen(next);
          }}
        >
          <WandSparkles size={14} aria-hidden="true" />
          <span>Skill</span>
          <ChevronDown size={12} aria-hidden="true" />
        </Button>
      </Popover>
    </div>
  );
}
