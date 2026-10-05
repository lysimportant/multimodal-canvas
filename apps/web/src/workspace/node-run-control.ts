import { createContext, useSyncExternalStore } from 'react';

/** 节点生成入口的本地停止状态；不代表 Provider 已终止或退款。 */
export type NodeRunControlState = {
  /** 当前节点有关联的创建窗口或已知活动 Run，可发起停止。 */
  stoppable: boolean;
  /** 用户已请求停止，等待创建返回或服务端确认。 */
  stopRequested: boolean;
};

const idleNodeRunControlState: NodeRunControlState = Object.freeze({
  stoppable: false,
  stopRequested: false,
});

const idleNodeRunControlStore: NodeRunControlStore = {
  getSnapshot: () => idleNodeRunControlState,
  subscribe: () => () => undefined,
  set: () => undefined,
  clear: () => undefined,
  clearAll: () => undefined,
};

/** 按节点订阅停止状态，避免单个运行变化通过 Context 广播到全部节点。 */
export type NodeRunControlStore = {
  getSnapshot: (nodeId: string | undefined) => NodeRunControlState;
  subscribe: (nodeId: string | undefined, listener: () => void) => () => void;
  set: (nodeId: string, state: NodeRunControlState) => void;
  clear: (nodeId: string) => void;
  clearAll: () => void;
};

/** 稳定传递节点停止存储；状态变化由节点自身订阅，不更新 Provider value。 */
export const NodeRunControlStoreContext = createContext<NodeRunControlStore | null>(null);

/** 节点停止动作；调用方必须只取消该节点关联的当前操作或已知 Run。 */
export type NodeStopHandler = (nodeId: string) => void | Promise<void>;
/** 稳定传递停止回调；未接入时节点不开放可操作的停止按钮。 */
export const NodeStopContext = createContext<NodeStopHandler | null>(null);

/**
 * 创建画布生命周期内的节点停止状态存储。
 *
 * 状态只存在于当前页面；Run 的真实取消意图仍由 `/v1/runs/:runId/cancel` 持久化。
 *
 * @returns 可按节点精确订阅的稳定存储。
 */
export function createNodeRunControlStore(): NodeRunControlStore {
  const states = new Map<string, NodeRunControlState>();
  const listeners = new Map<string, Set<() => void>>();
  const notify = (nodeId: string) => listeners.get(nodeId)?.forEach((listener) => listener());
  return {
    getSnapshot: (nodeId) =>
      nodeId ? (states.get(nodeId) ?? idleNodeRunControlState) : idleNodeRunControlState,
    subscribe: (nodeId, listener) => {
      if (!nodeId) return () => undefined;
      const nodeListeners = listeners.get(nodeId) ?? new Set<() => void>();
      nodeListeners.add(listener);
      listeners.set(nodeId, nodeListeners);
      return () => {
        nodeListeners.delete(listener);
        if (nodeListeners.size === 0) listeners.delete(nodeId);
      };
    },
    set: (nodeId, state) => {
      const current = states.get(nodeId) ?? idleNodeRunControlState;
      if (current.stoppable === state.stoppable && current.stopRequested === state.stopRequested)
        return;
      states.set(nodeId, Object.freeze({ ...state }));
      notify(nodeId);
    },
    clear: (nodeId) => {
      if (!states.delete(nodeId)) return;
      notify(nodeId);
    },
    clearAll: () => {
      const nodeIds = [...states.keys()];
      states.clear();
      nodeIds.forEach(notify);
    },
  };
}

/** 订阅单个节点的生成停止状态；其它节点变化不会触发当前组件重渲染。 */
export function useNodeRunControl(
  store: NodeRunControlStore | null | undefined,
  nodeId: string | undefined,
): NodeRunControlState {
  const resolvedStore = store ?? idleNodeRunControlStore;
  return useSyncExternalStore(
    (listener) => resolvedStore.subscribe(nodeId, listener),
    () => resolvedStore.getSnapshot(nodeId),
    () => resolvedStore.getSnapshot(nodeId),
  );
}
