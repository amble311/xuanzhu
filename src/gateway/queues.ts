/**
 * 按 key（对端）串行、不同 key 之间并发的队列。
 *
 * 为什么需要：Agent 实例自带对话历史，同一个对端的第二条消息必须等第一条跑完，
 * 否则两条消息会在同一份历史上交错（模型看到「自己刚说的话还没答完就又来一条」）。
 * 但**不同对端之间没有共享状态**，一条 15 分钟的 BTC 巡检不该把另一个人的
 * `/info` 堵在后面。
 *
 * 语义与 Promise 链一致：`run(key, task)` 必须等该 key 的上一条结束才开始；
 * 失败不会毒化队列（`prev.then(task, task)`）。
 */
export interface PeerQueues {
  run: <T>(key: string, task: () => Promise<T>) => Promise<T>;
  /** 当前有几个对端有待跑/在跑的任务（诊断用） */
  readonly size: number;
  /** 某个对端是否还有未完成的链（测试用） */
  readonly pending: (key: string) => boolean;
}

export function createPeerQueues(): PeerQueues {
  const chains = new Map<string, Promise<unknown>>();

  const run = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = chains.get(key) ?? Promise.resolve();
    // 上一条失败也要继续跑下一条，否则一次异常就把这个对端永久堵死
    const next = previous.then(task, task);
    const settled = next.catch(() => undefined);
    chains.set(key, settled);
    // 链跑完后清理，避免长期运行后 Map 无限增长（新 key 会重新建链）
    void settled.then(() => {
      if (chains.get(key) === settled) chains.delete(key);
    });
    return next;
  };

  return {
    run,
    get size() {
      return chains.size;
    },
    pending: (key) => chains.has(key),
  };
}
