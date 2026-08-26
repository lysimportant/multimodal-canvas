import { useEffect, useRef } from 'react';

type TextPromptEditorProps = {
  nodeId: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
};

/**
 * Keep the text-generation prompt immediately visible after selecting a node.
 * The inspector is below the canvas on narrow viewports, so scrolling the field
 * into view avoids making users hunt for the editor after a node click.
 */
export function TextPromptEditor({ nodeId, value, placeholder, onChange }: TextPromptEditorProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    input.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [nodeId]);

  return (
    <textarea
      ref={inputRef}
      rows={4}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
    />
  );
}
