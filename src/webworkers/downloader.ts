import * as Comlink from "comlink";
import fs from "fs";
import fsPromises from "fs/promises";
import { Readable } from "stream";
import { encodeUrlHeaders } from "@/common/normalize-util";
import throttle from "lodash.throttle";
import { DownloadState as DownloadState } from "@/common/constant";
import { rimraf } from "rimraf";

async function cleanFile(filePath: string) {
    try {
        if ((await fsPromises.stat(filePath)).isFile()) {
            await rimraf(filePath);
        }
        return true;
    } catch {
        return false;
    }
}

/** 主线程通过 token 中断对应的下载任务（fetch abort + 流销毁） */
const abortControllers = new Map<string, AbortController>();

export function abortDownload(token: string) {
    const controller = abortControllers.get(token);
    if (controller) {
        controller.abort();
    }
}

const responseToReadable = (
    response: Response,
    options?: {
        onRead?: (size: number) => void;
        onDone?: () => void;
        onError?: (e: Error) => void;
    },
) => {
    const reader = response.body.getReader();
    const rs = new Readable();
    let size = 0;
    const tOnRead = throttle(options?.onRead, 64, {
        leading: true,
        trailing: true,
    });
    rs._read = async () => {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
            result = await reader.read();
        } catch (e) {
            // fetch 被 AbortSignal 中断时 reader.read 会 reject：
            // 直接把流销毁（触发下游 error/close），避免未处理 rejection
            rs.destroy(e);
            return;
        }
        if (!result.done) {
            rs.push(Buffer.from(result.value));
            size += result.value.byteLength;
            tOnRead?.(size);
        } else {
            rs.push(null);
            options?.onDone?.();
            return;
        }
    };
    rs.on("error", options?.onError);
    return rs;
};

type IOnStateChangeFunc = (data: {
    state: DownloadState;
    downloaded?: number;
    total?: number;
    msg?: string;
}) => void;

async function downloadFile(
    mediaSource: IMusic.IMusicSource,
    filePath: string,
    onStateChange: IOnStateChangeFunc,
    options?: { token?: string },
) {
    const token = options?.token;
    const controller = new AbortController();
    if (token) {
        abortControllers.set(token, controller);
    }
    const signal = controller.signal;

    let settled = false;
    const notify = (data: Parameters<IOnStateChangeFunc>[0]) => {
        if (settled) {
            return;
        }
        settled = true;
        if (token) {
            abortControllers.delete(token);
        }
        onStateChange?.(data);
    };

    let state = DownloadState.DOWNLOADING;
    try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            state = DownloadState.ERROR;
            notify({
                state,
                msg: "Filepath is a directory",
            });
            return;
        }
    } catch (e) {}
    const _headers: Record<string, string> = {
        ...(mediaSource.headers ?? {}),
        "user-agent": mediaSource.userAgent,
    };

    try {
        const urlObj = new URL(mediaSource.url);
        let res: Response;
        if (urlObj.username && urlObj.password) {
            _headers["Authorization"] = `Basic ${btoa(
                `${decodeURIComponent(urlObj.username)}:${decodeURIComponent(
                    urlObj.password,
                )}`,
            )}`;
            urlObj.username = "";
            urlObj.password = "";
            res = await fetch(urlObj.toString(), {
                headers: _headers,
                signal,
            });
        } else {
            res = await fetch(encodeUrlHeaders(mediaSource.url, _headers), {
                signal,
            });
        }

        const totalSize = +res.headers.get("content-length");
        onStateChange({
            state,
            downloaded: 0,
            total: totalSize,
        });
        const writeStream = fs.createWriteStream(filePath);
        const stm = responseToReadable(res, {
            onRead(size) {
                if (state !== DownloadState.DOWNLOADING) {
                    return;
                }
                state = DownloadState.DOWNLOADING;
                onStateChange({
                    state,
                    downloaded: size,
                    total: totalSize,
                });
            },
            onError: (e) => {
                state = DownloadState.ERROR;
                onStateChange({
                    state,
                    msg: e?.message,
                });
            },
        }).pipe(writeStream);

        // 被主线程暂停/取消：销毁流、清理半成品文件，并通知结束。
        // 注意必须带 error destroy，否则只触发 'close' 会被误判为下载完成。
        signal.addEventListener("abort", () => {
            stm.destroy(new Error("download aborted"));
            writeStream.destroy(new Error("download aborted"));
        });

        stm.on("close", () => {
            state = DownloadState.DONE;
            notify({
                state,
            });
        });

        stm.on("error", (e) => {
            state = DownloadState.ERROR;
            notify({
                state,
                msg: e?.message,
            });
            // 清理文件（被中断的半成品/失败残留）
            cleanFile(filePath);
        });
    } catch (e) {
        state = DownloadState.ERROR;
        notify({
            state,
            msg: e?.message,
        });
        cleanFile(filePath);
    }
}


interface IOptions {
    onProgress?: (progress: ICommon.IDownloadFileSize) => Promise<void>;
    onEnded?: () => Promise<void>;
    onError?: (reason: Error) => Promise<void>;
}
async function downloadFileNew(
    mediaSource: IMusic.IMusicSource,
    filePath: string,
    options?: IOptions,
) {
    let hasError = false;
    const { onProgress: onProgressCallback, onEnded: onEndedCallback, onError: onErrorCallback } = options ?? {};
    try {
        const stat = fs.statSync(filePath);

        if (stat.isDirectory()) {
            hasError = true;
            onErrorCallback?.(new Error("Filepath is a directory"));
            return;
        }
    } catch (e) {
    // pass
    }

    const headers: Record<string, string> = {
        ...(mediaSource.headers ?? {}),
        "user-agent": mediaSource.userAgent,
    };

    try {
        const urlObj = new URL(mediaSource.url);
        let res: Response;
        if (urlObj.username && urlObj.password) {
            headers["Authorization"] = `Basic ${btoa(
                `${decodeURIComponent(urlObj.username)}:${decodeURIComponent(
                    urlObj.password,
                )}`,
            )}`;
            urlObj.username = "";
            urlObj.password = "";
            res = await fetch(urlObj.toString(), {
                headers: headers,
            });
        } else {
            res = await fetch(encodeUrlHeaders(mediaSource.url, headers));
        }

        const totalSize = +res.headers.get("content-length");
        onProgressCallback?.({
            currentSize: 0,
            totalSize: totalSize,
        });


        const stm = responseToReadable(res, {
            onRead(size) {
                if (hasError) {
                    // todo abort
                    return;
                }
                onProgressCallback?.({
                    currentSize: size,
                    totalSize: totalSize,
                });
            },
            onError: (e) => {
                if (!hasError) {
                    hasError = true;
                    onErrorCallback?.(e);
                }
            },
        }).pipe(fs.createWriteStream(filePath));

        stm.on("close", () => {
            onEndedCallback?.();
        });

        stm.on("error", (e) => {
            if (!hasError) {
                hasError = true;
                onErrorCallback?.(e);
            }
            // 清理文件
            cleanFile(filePath);
        });
    } catch (e) {
        if (!hasError) {
            hasError = true;
            onErrorCallback?.(e);
        }
        cleanFile(filePath);
    }
}



Comlink.expose({
    downloadFile,
    downloadFileNew,
    abortDownload,
});
