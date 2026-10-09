/**
 * 按固定并发度执行任务，返回的结果**与输入顺序一一对应**。
 *
 * 用 worker 池而不是 `Promise.all(items.map(...))`：后者会一次性把所有任务发出去，
 * 数量一大就会同时打满服务端（并发子代理各自持有一条对话流，很容易撞上速率限制）。
 *
 * 单个任务抛错会直接向上传播 —— 需要「失败不影响其他任务」时由 `worker` 自行捕获。
 * `limit` 会被夹到 `[1, items.length]`；`items` 为空时立即返回空数组。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const normalized = Number.isFinite(limit) ? Math.floor(limit) : 1;
  const workers = Math.min(Math.max(1, normalized), items.length);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        // 自增与判断在同一同步片段内完成，多个 worker 不会取到同一个下标
        const current = cursor++;
        if (current >= items.length) return;
        results[current] = await worker(items[current], current);
      }
    }),
  );

  return results;
}
