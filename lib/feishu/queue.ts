/** 同一聊天串行执行，后一条追问等待前一条回答与记忆落盘。 */
export class FeishuMessageQueue {
  private readonly tails = new Map<string, Promise<void>>();

  enqueue(chatId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(chatId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.tails.set(chatId, current);
    const release = () => {
      if (this.tails.get(chatId) === current) this.tails.delete(chatId);
    };
    void current.then(release, release);
    return current;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.tails.values()]);
  }
}
