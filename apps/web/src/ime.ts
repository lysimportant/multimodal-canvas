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
  /** Increment when the owner has authoritatively reset the field. */
  resetKey?: string | number;
  onBlur?: (value: string) => void;
};

type ImeDraftBinding<T extends ImeTextControl> = {
  value: string;
  onChange: ChangeEventHandler<T>;
  onCompositionStart: CompositionEventHandler<T>;
  onCompositionUpdate: CompositionEventHandler<T>;
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
  resetKey,
  onBlur,
}: UseImeDraftOptions): {
  bind: ImeDraftBinding<T>;
  isComposing: () => boolean;
} {
  const [draft, setDraft] = useState(value);
  const identityRef = useRef(identity);
  const resetKeyRef = useRef(resetKey);
  const composingRef = useRef(false);
  const pendingLocalValueRef = useRef<string | undefined>(undefined);
  const localValueHistoryRef = useRef<Set<string>>(new Set());
  const protectedExternalValuesRef = useRef<Set<string>>(new Set());
  const lastExternalValueRef = useRef(value);
  const committedValueRef = useRef(value);
  const onCommitRef = useRef(onCommit);
  const onBlurRef = useRef(onBlur);

  onCommitRef.current = onCommit;
  onBlurRef.current = onBlur;

  const updateDraft = useCallback((nextValue: string) => {
    setDraft(nextValue);
  }, []);

  const trackLocalDraft = useCallback((nextValue: string) => {
    // A duplicate change event after an external acknowledgement is not a new
    // edit and must not reopen the stale-value protection window.
    if (pendingLocalValueRef.current === undefined && committedValueRef.current === nextValue) {
      return;
    }

    if (pendingLocalValueRef.current === undefined) {
      protectedExternalValuesRef.current.add(lastExternalValueRef.current);
    }
    pendingLocalValueRef.current = nextValue;
    localValueHistoryRef.current.add(nextValue);
  }, []);

  const commit = useCallback((nextValue: string) => {
    if (committedValueRef.current === nextValue) return;
    committedValueRef.current = nextValue;
    onCommitRef.current(nextValue);
  }, []);

  useEffect(() => {
    if (identityRef.current !== identity || resetKeyRef.current !== resetKey) {
      identityRef.current = identity;
      resetKeyRef.current = resetKey;
      composingRef.current = false;
      pendingLocalValueRef.current = undefined;
      localValueHistoryRef.current.clear();
      protectedExternalValuesRef.current.clear();
      lastExternalValueRef.current = value;
      committedValueRef.current = value;
      setDraft(value);
      return;
    }

    const pendingLocalValue = pendingLocalValueRef.current;
    if (pendingLocalValue !== undefined) {
      if (value !== pendingLocalValue) {
        protectedExternalValuesRef.current.add(value);
        return;
      }
      pendingLocalValueRef.current = undefined;
      lastExternalValueRef.current = value;
      committedValueRef.current = value;
      if (composingRef.current) return;
      setDraft(value);
      return;
    }

    if (composingRef.current) return;

    if (value === lastExternalValueRef.current) return;
    if (localValueHistoryRef.current.has(value) || protectedExternalValuesRef.current.has(value)) {
      return;
    }

    // No local edit is waiting for acknowledgement and this value is not part
    // of the current edit lineage, so it is a genuine external replacement.
    localValueHistoryRef.current.clear();
    protectedExternalValuesRef.current.clear();
    lastExternalValueRef.current = value;
    committedValueRef.current = value;
    setDraft(value);
  }, [identity, resetKey, value]);

  const handleChange = useCallback<ChangeEventHandler<T>>(
    (event) => {
      const nextValue = event.currentTarget.value;
      updateDraft(nextValue);
      if (!composingRef.current) {
        trackLocalDraft(nextValue);
        commit(nextValue);
      }
    },
    [commit, trackLocalDraft, updateDraft],
  );

  const handleCompositionStart = useCallback<CompositionEventHandler<T>>(() => {
    composingRef.current = true;
  }, []);

  const handleCompositionUpdate = useCallback<CompositionEventHandler<T>>(
    (event) => {
      if (composingRef.current) updateDraft(event.currentTarget.value);
    },
    [updateDraft],
  );

  const handleCompositionEnd = useCallback<CompositionEventHandler<T>>(
    (event) => {
      const nextValue = event.currentTarget.value;
      composingRef.current = false;
      updateDraft(nextValue);
      trackLocalDraft(nextValue);
      commit(nextValue);
    },
    [commit, trackLocalDraft, updateDraft],
  );

  const handleBlur = useCallback<FocusEventHandler<T>>(
    (event) => {
      const nextValue = event.currentTarget.value;
      composingRef.current = false;
      updateDraft(nextValue);
      trackLocalDraft(nextValue);
      commit(nextValue);
      onBlurRef.current?.(nextValue);
    },
    [commit, trackLocalDraft, updateDraft],
  );

  const isComposing = useCallback(() => composingRef.current, []);

  return {
    bind: {
      value: draft,
      onChange: handleChange,
      onCompositionStart: handleCompositionStart,
      onCompositionUpdate: handleCompositionUpdate,
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
