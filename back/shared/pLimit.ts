import PQueue, { QueueAddOptions } from 'p-queue-cjs';
import os from 'os';
import { AuthDataType, SystemModel } from '../data/system';
import Logger from '../loaders/logger';
import { Dependence } from '../data/dependence';
import { ICron } from '../protos/cron';
import NotificationService from '../services/notify';
import { Inject } from 'typedi';

export type Override<
  T,
  K extends Partial<{ [P in keyof T]: any }> | string,
> = K extends string
  ? Omit<T, K> & { [P in keyof T]: T[P] | unknown }
  : Omit<T, keyof K> & K;
type TCron = Override<Partial<ICron>, { id: string }>;
interface IDependencyFn<T> {
  (): Promise<T>;
  dependency?: Dependence;
}
interface ICronFn<T> {
  (): Promise<T>;
  cron?: TCron;
}
class TaskLimit {
  private dependenyLimit = new PQueue({ concurrency: 1 });
  private queuedDependencyIds = new Set<number>([]);
  private queuedCrons = new Map<string, TCron[]>();
  private updateLogLimit = new PQueue({ concurrency: 1 });
  private cronLimit = new PQueue({
    concurrency: Math.max(os.cpus().length, 4),
  });
  private manualCronoLimit = new PQueue({
    concurrency: Math.max(os.cpus().length, 4),
  });
  @Inject((type) => NotificationService)
  private notificationService!: NotificationService;

  get cronLimitActiveCount() {
    return this.cronLimit.pending;
  }

  get cronLimitPendingCount() {
    return this.cronLimit.size;
  }

  get firstDependencyId() {
    return [...this.queuedDependencyIds.values()][0];
  }

  constructor() {
    this.setCustomLimit();
    this.handleEvents();
  }

  private handleEvents() {
    this.cronLimit.on('add', () => {
      Logger.info(
        `[schedule][任务加入队列] 运行中任务数: ${this.cronLimitActiveCount}, 等待中任务数: ${this.cronLimitPendingCount}`,
      );
    });
    this.cronLimit.on('active', () => {
      Logger.info(
        `[schedule][开始处理任务] 运行中任务数: ${
          this.cronLimitActiveCount + 1
        }, 等待中任务数: ${this.cronLimitPendingCount}`,
      );
    });
    this.cronLimit.on('completed', (param) => {
      Logger.info(`[schedule][任务处理成功] 参数 ${JSON.stringify(param)}`);
    });
    this.cronLimit.on('error', (error) => {
      Logger.error(`[schedule][任务处理错误] 参数 ${JSON.stringify(error)}`);
    });
    this.cronLimit.on('next', () => {
      Logger.info(
        `[schedule][任务处理结束] 运行中任务数: ${this.cronLimitActiveCount}, 等待中任务数: ${this.cronLimitPendingCount}`,
      );
    });
    this.cronLimit.on('idle', () => {
      Logger.info(`[schedule][任务队列] 空闲中...`);
    });
  }

  public removeQueuedDependency(dependency: Dependence) {
    if (this.queuedDependencyIds.has(dependency.id!)) {
      this.queuedDependencyIds.delete(dependency.id!);
    }
  }

  public removeQueuedCron(id: string) {
    if (this.queuedCrons.has(id)) {
      const runs = this.queuedCrons.get(id);
      if (runs && runs.length > 0) {
        runs.pop();
        this.queuedCrons.set(id, runs);
      }
    }
  }

  public async setCustomLimit(limit?: number) {
    if (limit) {
      this.cronLimit.concurrency = limit;
      this.manualCronoLimit.concurrency = limit;
      return;
    }
    await SystemModel.sync();
    const doc = await SystemModel.findOne({
      where: { type: AuthDataType.systemConfig },
    });
    if (doc?.info?.cronConcurrency) {
      this.cronLimit.concurrency = doc.info.cronConcurrency;
      this.manualCronoLimit.concurrency = doc.info.cronConcurrency;
    }
  }

  public async runWithCronLimit<T>(
    cron: TCron,
    fn: ICronFn<T>,
    options?: Partial<QueueAddOptions>,
  ): Promise<T | void> {
    let runs = this.queuedCrons.get(cron.id);
    if (!runs?.length) {
      runs = [];
    }
    runs.push(cron);
    if (runs.length >= 5) {
      this.notificationService.notify(
        '任务重复运行',
        `任务 ${cron.name} ${cron.command} 处于运行中的已达 5 个，请检查系统日志`,
      );
      return;
    }
    this.queuedCrons.set(cron.id, runs);
    fn.cron = cron;
    return this.cronLimit.add(fn, options);
  }

  public async manualRunWithCronLimit<T>(
    fn: () => Promise<T>,
    options?: Partial<QueueAddOptions>,
  ): Promise<T | void> {
    return this.manualCronoLimit.add(fn, options);
  }

  public runDependeny<T>(
    dependency: Dependence,
    fn: IDependencyFn<T>,
    options?: Partial<QueueAddOptions>,
  ): Promise<T | void> {
    this.queuedDependencyIds.add(dependency.id!);
    fn.dependency = dependency;
    return this.dependenyLimit.add(fn, options);
  }

  public updateDepLog<T>(
    fn: () => Promise<T>,
    options?: Partial<QueueAddOptions>,
  ): Promise<T | void> {
    return this.updateLogLimit.add(fn, options);
  }
}

export default new TaskLimit();
