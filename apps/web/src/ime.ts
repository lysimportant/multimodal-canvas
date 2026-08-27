import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEventHandler,
  type CompositionEventHandler,
  type FocusEventHandler,
} from 'react';

export type ImeTextControl = HTMLInputElement | HTMLTextAreaElement;

type UseImeDraftOptions = {
  value: string;
  onCommit: (value: string) => void;
  identity?: string;
  onBlur?: (value: string) => void;
};

type ImeDraftBinding<T extends ImeTextControl> = {
  value: string;
  onChange: ChangeEventHandler<T>;
  onCompositionStart: CompositionEventHandler<T>;
  onCompositionEnd: CompositionEventHandler<T>;
  onBlur: FocusEventHandler<T>;
};

type ImeKeyboardEventLike = {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
};

/** Keep an editable draft stable while an IME owns the text control. */
export function useImeDraft<T extends ImeTextControl>({
  value,
  onCommit,
  identity,
  onBlur,
}: UseImeDraftOptions): {
  bind: ImeDraftBinding<T>;
  isComposing: () => boolean;
} {
  const [draft, setDraft] = useState(value);
  const identityRef = useRef(identity);
  const composingRef = useRef(false);
  const committedValueRef = useRef(value);
  const onCommitRef = useRef(onCommit);
  const onBlurRef = useRef(onBlur);

  onCommitRef.current = onCommit;
  onBlurRef.current = onBlur;

  useEffect(() => {
    if (identityRef.current !== identity) {
      identityRef.current = identity;
      composingRef.current = false;
      committedValueRef.current = value;
      setDraft(value);
      return;
    }

    if (composingRef.current) return;
    committedValueRef.current = value;
    setDraft(value);
  }, [identity, value]);

  const commit = useCallback((nextValue: string) => {
    if (committedValueRef.current === nextValue) return;
    committedValueRef.current = nextValue;
    onCommitRef.current(nextValue);
  }, []);

  const handleChange = useCallback<ChangeEventHandler<T>>(
    (event) => {
      const nextValue = event.currentTarget.value;
      setDraft(nextValue);
      if (!composingRef.current) commit(nextValue);
    },
    [commit],
  );

  const handleCompositionStart = useCallback<CompositionEventHandler<T>>(() => {
    composingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback<CompositionEventHandler<T>>(
    (event) => {
      const nextValue = event.currentTarget.value;
      composingRef.current = false;
      setDraft(nextValue);
      commit(nextValue);
    },
    [commit],
  );

  const handleBlur = useCallback<FocusEventHandler<T>>(
    (event) => {
      const nextValue = event.currentTarget.value;
      composingRef.current = false;
      setDraft(nextValue);
      commit(nextValue);
      onBlurRef.current?.(nextValue);
    },
    [commit],
  );

  const isComposing = useCallback(() => composingRef.current, []);

  return {
    bind: {
      value: draft,
      onChange: handleChange,
      onCompositionStart: handleCompositionStart,
      onCompositionEnd: handleCompositionEnd,
      onBlur: handleBlur,
    },
    isComposing,
  };
}

/** Covers native, React synthetic, and legacy keyCode 229 IME keyboard events. */
export function isImeKeyboardEvent(event: ImeKeyboardEventLike): boolean {
  return Boolean(
    event.isComposing ||
    event.keyCode === 229 ||
    event.nativeEvent?.isComposing ||
    event.nativeEvent?.keyCode === 229,
  );
}
