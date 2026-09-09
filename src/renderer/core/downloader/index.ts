import {
    getMediaPrimaryKey,
    getQualityOrder,
    isSameMedia,
    setInternalData,
} from "@/common/media-util";
import * as Comlink from "comlink";
import { DownloadState, localPluginName } from "@/common/constant";
import {
    addDownloadedMusicToList,
    isDownloaded,
    removeDownloadedMusic,
    setupDownloadedMusicList,
    useDownloaded,
    useDownloadedMusicList,
} from "./downloaded-sheet";
import { getGlobalContext } from "@/shared/global-context/renderer";
import Store from "@/common/store";
import { useEffect, useState } from "react";
import { DownloadEvts, ee } from "./ee";
import AppConfig from "@shared/app-config/renderer";
import PluginManager from "@shared/plugin-manager/renderer";
import {
    getUserPreferenceIDB,
    setUserPreferenceIDB,
} from "@/renderer/utils/user-perference";

export interface IDownloadStatus {
    state: DownloadState;
    downloaded?: number;
    total?: number;
    msg?: string;
    /** 用户手动暂停（仅作展示：等待中/下载中的任务被暂停） */
    paused?: boolean;
    /** 自动重试：当前是第几次重试（仅在等待重试/最终失败时展示） */
    retryCount?: number;
    /** 自动重试上限 */
    retryMax?: number;
}

const downloadingMusicStore = new Store<Array<IMusic.IMusicItem>>([]);
const downloadingProgress = new Map<string, IDownloadStatus>();

/** 下载任务汇总（驱动 UI 工具条按钮的可用状态） */
const summaryStore = new Store<{
    total: number;
    running: number;
    waiting: number;
    paused: number;
    error: number;
}>({ total: 0, running: 0, waiting: 0, paused: 0, error: 0 });

function refreshSummary() {
    let running = 0;
    let waiting = 0;
    let paused = 0;
    let error = 0;
    for (const [pk, task] of taskMap) {
        if (task.cancelled) {
            continue;
        }
        const s = downloadingProgress.get(pk);
        if (task.paused || s?.paused) {
            paused++;
        } else if (s) {
            switch (s.state) {
                case DownloadState.DOWNLOADING:
                    running++;
                    break;
                case DownloadState.ERROR:
                    error++;
                    break;
                default:
                    waiting++;
                    break;
            }
        } else if (task.stage === "running") {
            running++;
        } else {
            waiting++;
        }
    }
    summaryStore.setValue({
        total: running + waiting + paused + error,
        running,
        waiting,
        paused,
        error,
    });
    persistDownloadingTasks();
}

// ---------------------------------------------------------------------------
// 下载中任务持久化
//
// 「下载中」列表（downloadingMusicStore / taskMap / downloadingProgress）都在
// 内存中，应用退出即丢失。这里在任务表发生迁移（新增/完成/失败/暂停/取消）时，
// 把仍在列表中的任务（音乐项 + 状态）写入 IDB；下次启动时恢复为「已暂停」，
// 用户点「继续下载」即可重新解析音源并下载。注意：pause 中断 worker 时会清理
// 半成品文件，因此恢复后的「继续」语义为重新下载（与暂停-继续一致）。
// ---------------------------------------------------------------------------
type IDownloadingTaskSnapshot = IUserPreference.IDBType["downloadingTasks"][number];

function takeDownloadingTaskSnapshot(): IDownloadingTaskSnapshot[] {
    const snapshots: IDownloadingTaskSnapshot[] = [];
    for (const [pk, task] of taskMap) {
        if (task.cancelled) {
            continue;
        }
        const status = downloadingProgress.get(pk) ?? {
            state: DownloadState.WAITING,
        };
        snapshots.push({
            musicItem: task.musicItem,
            status: {
                state: status.state,
                paused: status.paused,
                msg: status.msg,
            },
        });
    }
    return snapshots;
}

// 串行化 IDB 写入：避免并发 put 乱序导致落盘的不是最新快照
let persistQueue: Promise<unknown> = Promise.resolve();
function persistDownloadingTasks() {
    const snapshot = takeDownloadingTaskSnapshot();
    persistQueue = persistQueue
        .then(() => setUserPreferenceIDB("downloadingTasks", snapshot))
        .catch(() => {});
}

/** 应用启动时恢复上次未完成的下载任务（统一转为「已暂停」，不自动开始） */
async function restoreDownloadingTasks() {
    const saved = (await getUserPreferenceIDB("downloadingTasks")) ?? [];
    if (!saved.length) {
        return;
    }
    const restored: IMusic.IMusicItem[] = [];
    for (const item of saved) {
        const musicItem = item?.musicItem;
        if (!musicItem) {
            continue;
        }
        const pk = getMediaPrimaryKey(musicItem);
        // 已完成/已在表中/本地音乐的无需恢复
        if (taskMap.has(pk) || isDownloaded(musicItem)) {
            continue;
        }
        const isError = item.status?.state === DownloadState.ERROR;
        taskMap.set(pk, {
            pk,
            musicItem,
            stage: isError ? "ended" : "waiting",
            // 非失败任务恢复为「已暂停」，等待用户手动继续
            paused: !isError,
            cancelled: false,
            attempts: 0,
        });
        downloadingProgress.set(
            pk,
            isError
                ? { state: DownloadState.ERROR, msg: item.status?.msg }
                : { state: DownloadState.WAITING, paused: true },
        );
        restored.push(musicItem);
    }
    if (restored.length) {
        downloadingMusicStore.setValue((prev) => [...prev, ...restored]);
    }
    refreshSummary();
}

type ProxyMarkedFunction<T extends (...args: any) => void> = T &
    Comlink.ProxyMarked;

type IOnStateChangeFunc = (data: IDownloadStatus) => void;

interface IDownloaderWorker {
    downloadFile: (
        mediaSource: IMusic.IMusicSource,
        filePath: string,
        onStateChange: ProxyMarkedFunction<IOnStateChangeFunc>,
        options?: { token?: string },
    ) => Promise<void>;
    abortDownload: (token: string) => Promise<void>;
}

let downloaderWorker: IDownloaderWorker;

async function setupDownloader() {
    setupDownloaderWorker();
    await setupDownloadedMusicList();
    // 恢复上次退出时未完成的下载任务（转为已暂停，等待用户继续）
    await restoreDownloadingTasks();
}

function setupDownloaderWorker() {
    // 初始化worker
    const downloaderWorkerPath = getGlobalContext().workersPath.downloader;
    if (downloaderWorkerPath) {
        const worker = new Worker(downloaderWorkerPath);
        downloaderWorker = Comlink.wrap(worker);
    }
    setDownloadingConcurrency(AppConfig.getConfig("download.concurrency"));
}

// ---------------------------------------------------------------------------
// 可暂停调度器（替换 p-queue）
//
// 原实现（PQueue）一旦把任务 addAll 进队就失去对单个任务的控制，无法实现
// 暂停/继续/取消。这里改为任务表 + 简单并发泵：
//   taskMap[pk] 记录每个任务的调度状态（waiting/running/ended）与用户标记
//   （paused/cancelled）；pump() 在并发有余量时把 waiting 的任务拉起执行。
// 状态流转：
//   waiting --pump--> running --DONE-->  从列表与任务表移除
//                         |--ERROR--> ended(失败滞留，可重试/删除)
//   waiting/running --暂停--> paused(保留在列表，可继续)
//   waiting/running/ended --取消--> 从列表/任务表/进度表移除
// ---------------------------------------------------------------------------
const concurrencyLimit = 20;
let maxConcurrency = 5;
let runningCount = 0;

/** 下载失败后的自动重试次数与退避基数（第 n 次重试等待 n * 基数） */
const AUTO_RETRY_MAX = 3;
const AUTO_RETRY_DELAY_MS = 2000;

type ITaskStage = "waiting" | "running" | "ended";

interface IInternalTask {
    pk: string;
    musicItem: IMusic.IMusicItem;
    stage: ITaskStage;
    /** 用户暂停标记：暂停中的任务不会被 pump 拉起 */
    paused: boolean;
    /** 用户取消标记：中断后不再进入列表 */
    cancelled: boolean;
    /** 已自动重试次数（手动「重试」时归零） */
    attempts: number;
    /** 自动重试冷却截止时间戳，在此之前 pump 不拉起该任务 */
    retryAt?: number;
}

const taskMap = new Map<string, IInternalTask>();

function setDownloadingConcurrency(concurrency: number) {
    if (isNaN(concurrency)) {
        return;
    }
    maxConcurrency = Math.min(
        concurrency < 1 ? 1 : concurrency,
        concurrencyLimit,
    );
    pump();
}

function emitStatus(musicItem: IMusic.IMusicItem, status: IDownloadStatus) {
    ee.emit(DownloadEvts.DownloadStatusUpdated, musicItem, status);
}

function pump() {
    if (runningCount >= maxConcurrency) {
        return;
    }
    for (const task of taskMap.values()) {
        if (runningCount >= maxConcurrency) {
            break;
        }
        if (
            task.stage === "waiting" &&
            !task.paused &&
            !task.cancelled &&
            // 自动重试冷却中：等 timer 到点再拉起
            !(task.retryAt && Date.now() < task.retryAt)
        ) {
            task.stage = "running";
            task.retryAt = 0;
            runningCount++;
            runTask(task);
        }
    }
}

/** 移除任务占位（列表/进度/任务表同步清理） */
function removeTaskFromLists(task: IInternalTask) {
    const { pk, musicItem } = task;
    taskMap.delete(pk);
    downloadingProgress.delete(pk);
    downloadingMusicStore.setValue((prev) =>
        prev.filter((di) => !isSameMedia(di, musicItem)),
    );
}

/**
 * 下载失败后的自动重试：未达上限时把任务放回等待队列，冷却结束后由 pump
 * 重新拉起（重新解析音源再下）。返回是否已安排重试。
 */
function tryAutoRetry(task: IInternalTask, msg?: string): boolean {
    if (task.cancelled || task.paused || task.attempts >= AUTO_RETRY_MAX) {
        return false;
    }
    task.attempts += 1;
    const delay = AUTO_RETRY_DELAY_MS * task.attempts;
    task.stage = "waiting";
    task.retryAt = Date.now() + delay;
    downloadingProgress.set(task.pk, {
        state: DownloadState.WAITING,
        retryCount: task.attempts,
        retryMax: AUTO_RETRY_MAX,
        msg,
    });
    emitStatus(task.musicItem, downloadingProgress.get(task.pk)!);
    refreshSummary();
    setTimeout(() => pump(), delay + 100);
    return true;
}

async function runTask(task: IInternalTask) {
    const { pk, musicItem } = task;
    try {
        await new Promise<void>((resolve) => {
            const fileName = `${musicItem.title}-${musicItem.artist}`.replace(
                /[/|\\?*"<>:]/g,
                "_",
            );
            try {
                downloadMusicImpl(musicItem, fileName, (stateData) => {
                    // 已被取消：行已从列表移除，这里直接结束，不再写任何状态
                    if (task.cancelled) {
                        resolve();
                        return;
                    }
                    // 用户暂停导致 worker 中断(会回调 ERROR)：覆盖为「已暂停」展示
                    if (task.paused) {
                        task.stage = "ended";
                        downloadingProgress.set(pk, {
                            state: DownloadState.WAITING,
                            paused: true,
                            downloaded: stateData.downloaded,
                            total: stateData.total,
                        });
                        emitStatus(musicItem, downloadingProgress.get(pk)!);
                        refreshSummary();
                        resolve();
                        return;
                    }
                    downloadingProgress.set(pk, stateData);
                    emitStatus(musicItem, stateData);
                    if (stateData.state === DownloadState.DONE) {
                        downloadingMusicStore.setValue((prev) =>
                            prev.filter((di) => !isSameMedia(di, musicItem)),
                        );
                        downloadingProgress.delete(pk);
                        taskMap.delete(pk);
                        refreshSummary();
                        resolve();
                    } else if (stateData.state === DownloadState.ERROR) {
                        // 先尝试自动重试；次数用尽才滞留列表（显示失败，可重试/删除）
                        if (tryAutoRetry(task, stateData.msg)) {
                            resolve();
                            return;
                        }
                        downloadingProgress.set(pk, {
                            ...stateData,
                            retryCount: task.attempts,
                            retryMax: AUTO_RETRY_MAX,
                        });
                        emitStatus(musicItem, downloadingProgress.get(pk)!);
                        task.stage = "ended";
                        refreshSummary();
                        resolve();
                    }
                });
            } catch (e) {
                // 同步异常兜底：先尝试自动重试，否则标记失败，避免任务永久卡在 running
                if (!tryAutoRetry(task, e?.message)) {
                    downloadingProgress.set(pk, {
                        state: DownloadState.ERROR,
                        msg: e?.message,
                        retryCount: task.attempts,
                        retryMax: AUTO_RETRY_MAX,
                    });
                    emitStatus(musicItem, downloadingProgress.get(pk)!);
                    task.stage = "ended";
                    refreshSummary();
                }
                resolve();
            }
        });
    } finally {
        runningCount--;
        pump();
    }
}

async function startDownload(
    musicItems: IMusic.IMusicItem | IMusic.IMusicItem[],
) {
    if (!downloaderWorker) {
        setupDownloaderWorker();
    }

    const _musicItems = Array.isArray(musicItems) ? musicItems : [musicItems];
    // 过滤掉已下载的、本地音乐、已在任务表中的音乐
    const _validMusicItems = _musicItems.filter(
        (it) =>
            !isDownloaded(it) &&
            it.platform !== localPluginName &&
            !taskMap.has(getMediaPrimaryKey(it)),
    );

    _validMusicItems.forEach((it) => {
        const pk = getMediaPrimaryKey(it);
        downloadingProgress.set(pk, {
            state: DownloadState.WAITING,
        });
        taskMap.set(pk, {
            pk,
            musicItem: it,
            stage: "waiting",
            paused: false,
            cancelled: false,
            attempts: 0,
        });
    });

    downloadingMusicStore.setValue((prev) => [...prev, ..._validMusicItems]);
    refreshSummary();
    pump();
}

/**
 * 暂停单个任务：排队中的直接挂起；下载中的先中断 worker(残留文件会被清理)，
 * 任务保留在「下载中」列表，显示为已暂停，可继续。
 */
async function pauseMusic(musicItems: IMusic.IMusicItem | IMusic.IMusicItem[]) {
    const list = Array.isArray(musicItems) ? musicItems : [musicItems];
    await Promise.all(
        list.map(async (it) => {
            const pk = getMediaPrimaryKey(it);
            const task = taskMap.get(pk);
            if (!task || task.paused || task.cancelled) {
                return;
            }
            task.paused = true;
            if (task.stage === "running") {
                await downloaderWorker?.abortDownload(pk);
            }
            downloadingProgress.set(pk, {
                state: DownloadState.WAITING,
                paused: true,
            });
            emitStatus(it, downloadingProgress.get(pk)!);
        }),
    );
    refreshSummary();
}

/**
 * 继续任务：对「已暂停」的任务恢复排队；对「下载失败」滞留的任务等效为重试。
 */
async function resumeMusic(musicItems: IMusic.IMusicItem | IMusic.IMusicItem[]) {
    if (!downloaderWorker) {
        setupDownloaderWorker();
    }
    const list = Array.isArray(musicItems) ? musicItems : [musicItems];
    list.forEach((it) => {
        const pk = getMediaPrimaryKey(it);
        const task = taskMap.get(pk);
        if (!task || task.cancelled || task.stage === "running") {
            return;
        }
        task.paused = false;
        task.stage = "waiting";
        // 手动「重试」重新给满自动重试次数
        task.attempts = 0;
        task.retryAt = 0;
        downloadingProgress.set(pk, {
            state: DownloadState.WAITING,
        });
        emitStatus(it, downloadingProgress.get(pk)!);
    });
    refreshSummary();
    pump();
}

/**
 * 取消任务：从下载列表移除（排队中的直接移除，下载中的中断 worker，
 * 失败滞留的清除）。不同于暂停——任务不再保留。
 */
async function cancelTask(
    musicItems: IMusic.IMusicItem | IMusic.IMusicItem[],
) {
    const list = Array.isArray(musicItems) ? musicItems : [musicItems];
    await Promise.all(
        list.map(async (it) => {
            const pk = getMediaPrimaryKey(it);
            const task = taskMap.get(pk);
            if (!task) {
                return;
            }
            task.cancelled = true;
            if (task.stage === "running") {
                await downloaderWorker?.abortDownload(pk);
            }
            removeTaskFromLists(task);
            emitStatus(it, { state: DownloadState.NONE });
        }),
    );
    refreshSummary();
}

function getRunningOrWaitingTasks(): IInternalTask[] {
    return [...taskMap.values()].filter(
        (t) => !t.cancelled && (t.stage === "waiting" || t.stage === "running"),
    );
}

async function pauseAll() {
    await pauseMusic(getRunningOrWaitingTasks().map((t) => t.musicItem));
}

async function resumeAll() {
    await resumeMusic(
        [...taskMap.values()]
            .filter((t) => !t.cancelled && t.paused)
            .map((t) => t.musicItem),
    );
}

/** 批量重试失败滞留的任务 */
async function retryFailedTasks() {
    await resumeMusic(
        [...taskMap.values()]
            .filter(
                (t) =>
                    !t.cancelled &&
                    t.stage === "ended" &&
                    downloadingProgress.get(t.pk)?.state === DownloadState.ERROR,
            )
            .map((t) => t.musicItem),
    );
}

/** 清除全部失败滞留的任务（从下载列表移除） */
async function clearFailedTasks() {
    await cancelTask(
        [...taskMap.values()]
            .filter(
                (t) =>
                    !t.cancelled &&
                    downloadingProgress.get(t.pk)?.state === DownloadState.ERROR,
            )
            .map((t) => t.musicItem),
    );
}

async function downloadMusicImpl(
    musicItem: IMusic.IMusicItem,
    fileName: string,
    onStateChange: IOnStateChangeFunc,
) {
    const [defaultQuality, whenQualityMissing] = [
        AppConfig.getConfig("download.defaultQuality"),
        AppConfig.getConfig("download.whenQualityMissing"),
    ];
    const qualityOrder = getQualityOrder(defaultQuality, whenQualityMissing);
    let mediaSource: IPlugin.IMediaSourceResult | null = null;
    let realQuality: IMusic.IQualityKey = qualityOrder[0];
    for (const quality of qualityOrder) {
        try {
            mediaSource = await PluginManager.callPluginDelegateMethod(
                musicItem,
                "getMediaSource",
                musicItem,
                quality,
            );
            if (!mediaSource?.url) {
                continue;
            }
            realQuality = quality;
            break;
        } catch {}
    }

    const pk = getMediaPrimaryKey(musicItem);
    try {
        if (mediaSource?.url) {
            const ext = mediaSource.url.match(/.*\/.+\.([^./?#]+)/)?.[1] ?? "mp3";
            const downloadBasePath =
                AppConfig.getConfig("download.path") ??
                getGlobalContext().appPath.downloads;
            const downloadPath = window.path.resolve(
                downloadBasePath,
                `./${fileName}.${ext}`,
            );
            await downloaderWorker.downloadFile(
                mediaSource,
                downloadPath,
                Comlink.proxy((dataState) => {
                    onStateChange(dataState);
                    if (dataState.state === DownloadState.DONE) {
                        addDownloadedMusicToList(
                            setInternalData<IMusic.IMusicItemInternalData>(
                                musicItem as any,
                                "downloadData",
                                {
                                    path: downloadPath,
                                    quality: realQuality,
                                },
                                true,
                            ) as IMusic.IMusicItem,
                        );
                    }
                }),
                { token: pk },
            );
        } else {
            throw new Error("Invalid Source");
        }
    } catch (e) {
        console.log(e, "ERROR");
        onStateChange({
            state: DownloadState.ERROR,
            msg: e?.message,
        });
    }
}

function useDownloadStatus(musicItem: IMusic.IMusicItem) {
    const [downloadStatus, setDownloadStatus] = useState<IDownloadStatus | null>(
        null,
    );

    useEffect(() => {
        setDownloadStatus(
            downloadingProgress.get(getMediaPrimaryKey(musicItem)) || null,
        );

        const updateFn = (mi: IMusic.IMusicItem, stateData: IDownloadStatus) => {
            if (isSameMedia(mi, musicItem)) {
                setDownloadStatus(stateData);
            }
        };

        ee.on(DownloadEvts.DownloadStatusUpdated, updateFn);

        return () => {
            ee.off(DownloadEvts.DownloadStatusUpdated, updateFn);
        };
    }, [musicItem]);

    return downloadStatus;
}

// 下载状态
function useDownloadState(musicItem: IMusic.IMusicItem) {
    const musicStatus = useDownloadStatus(musicItem);
    const downloaded = useDownloaded(musicItem);

    return (
        musicStatus?.state || (downloaded ? DownloadState.DONE : DownloadState.NONE)
    );
}

const Downloader = {
    setupDownloader,
    startDownload,
    pauseMusic,
    resumeMusic,
    cancelTask,
    pauseAll,
    resumeAll,
    retryFailedTasks,
    clearFailedTasks,
    useDownloadSummary: summaryStore.useValue,
    useDownloadStatus,
    useDownloadingMusicList: downloadingMusicStore.useValue,
    useDownloaded,
    isDownloaded,
    useDownloadedMusicList,
    removeDownloadedMusic,
    setDownloadingConcurrency,
    useDownloadState,
};
export default Downloader;
