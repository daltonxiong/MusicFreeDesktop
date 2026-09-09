import Tag from "@/renderer/components/Tag";
import Downloader from "@/renderer/core/downloader";
import {
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    useReactTable,
} from "@tanstack/react-table";
import "./index.scss";
import { i18n } from "@/shared/i18n/renderer";
import useVirtualList from "@/hooks/useVirtualList";
import DownloadStatus from "./DownloadStatus";
import { DownloadState } from "@/common/constant";
import { useTranslation } from "react-i18next";

const columnHelper = createColumnHelper<IMusic.IMusicItem>();

const estimizeItemHeight = 2.6 * 13; // lineheight 2.6rem

const { t } = i18n;
const columnDef = [
    columnHelper.accessor((_, index) => index + 1, {
        cell: (info) => info.getValue(),
        header: () => "#",
        id: "index",
        minSize: 40,
        maxSize: 40,
        size: 40,
    }),
    columnHelper.accessor("title", {
        header: () => t("media.media_title"),
        size: 200,
        cell: (info) => <span title={info.getValue()}>{info.getValue()}</span>,
    }),

    columnHelper.accessor("artist", {
        header: () => t("media.media_type_artist"),
        size: 80,
        cell: (info) => <span title={info.getValue()}>{info.getValue()}</span>,
    }),
    columnHelper.accessor("album", {
        header: () => t("media.media_type_album"),
        size: 80,
        cell: (info) => <span title={info.getValue()}>{info.getValue()}</span>,
    }),
    columnHelper.display({
        header: () => t("common.status"),
        size: 130,
        id: "status",
        cell: (info) => {
            return <DownloadStatus musicItem={info.row.original}></DownloadStatus>;
        },
    }),
    columnHelper.accessor("platform", {
        header: () => t("media.media_platform"),
        size: 100,
        cell: (info) => <Tag fill>{info.getValue()}</Tag>,
    }),
    columnHelper.display({
        header: () => t("common.operation"),
        size: 140,
        minSize: 120,
        id: "operation",
        cell: (info) => <RowOperations musicItem={info.row.original} />,
    }),
];

/** 单任务操作：暂停/继续(失败项为重试) + 移除 */
function RowOperations(props: { musicItem: IMusic.IMusicItem }) {
    const { musicItem } = props;
    const { t: t2 } = useTranslation();
    const status = Downloader.useDownloadStatus(musicItem);
    const state = status?.state;
    const paused = status?.paused;

    const isFailed = state === DownloadState.ERROR && !paused;
    const isDownloading = state === DownloadState.DOWNLOADING && !paused;
    const isWaiting = state === DownloadState.WAITING && !paused;
    // 任务刚添加但进度尚未初始化：视为等待中
    const isPending = !state && !isFailed;

    return (
        <span className="downloading-op">
            {paused || isFailed ? (
                <button
                    className="downloading-op-btn"
                    title={isFailed ? t2("download_page.retry") : t2("download_page.resume")}
                    onClick={() => Downloader.resumeMusic(musicItem)}
                >
                    {isFailed ? t2("download_page.retry") : t2("download_page.resume")}
                </button>
            ) : isDownloading || isWaiting || isPending ? (
                <button
                    className="downloading-op-btn"
                    title={t2("download_page.pause")}
                    onClick={() => Downloader.pauseMusic(musicItem)}
                >
                    {t2("download_page.pause")}
                </button>
            ) : null}
            <button
                className="downloading-op-btn downloading-op-btn--danger"
                title={t2("download_page.remove_task")}
                onClick={() => Downloader.cancelTask(musicItem)}
            >
                {t2("common.delete")}
            </button>
        </span>
    );
}

/** 顶栏：全部暂停 / 全部继续 / 清除失败 */
function DownloadingToolbar() {
    const { t: t2 } = useTranslation();
    const summary = Downloader.useDownloadSummary();

    return (
        <div className="downloading-toolbar">
            <button
                className="downloading-op-btn"
                disabled={summary.running + summary.waiting === 0}
                onClick={() => Downloader.pauseAll()}
            >
                {t2("download_page.pause_all")}
            </button>
            <button
                className="downloading-op-btn"
                disabled={summary.paused === 0}
                onClick={() => Downloader.resumeAll()}
            >
                {t2("download_page.resume_all")}
            </button>
            <button
                className="downloading-op-btn downloading-op-btn--danger"
                disabled={summary.error === 0}
                onClick={() => Downloader.clearFailedTasks()}
            >
                {t2("download_page.clear_failed")}
            </button>
            <span className="downloading-toolbar-count">
                {summary.total
                    ? `${t2("common.downloading")}: ${summary.total}（${t2(
                          "download_page.pause",
                      )} ${summary.paused} / ${t2("download_page.failed")} ${summary.error}）`
                    : ""}
            </span>
        </div>
    );
}

export default function Downloading() {
    const downloadingQueue = Downloader.useDownloadingMusicList();

    const table = useReactTable({
        debugAll: false,
        data: downloadingQueue,
        columns: columnDef,
        getCoreRowModel: getCoreRowModel(),
    });

    const virtualController = useVirtualList({
        data: table.getRowModel().rows,
        scrollElementQuery: "#page-container",
        estimateItemHeight: estimizeItemHeight,
    });

    return (
        <div className="downloading-container">
            <DownloadingToolbar />
            <table
                style={{
                    tableLayout: "fixed",
                    height: virtualController.totalHeight + estimizeItemHeight,
                }}
            >
                <thead>
                    <tr>
                        {table.getHeaderGroups()[0].headers.map((header) => (
                            <th
                                key={header.id}
                                style={{
                                    width: header.id === "extra" ? undefined : header.getSize(),
                                }}
                            >
                                {flexRender(
                                    header.column.columnDef.header,
                                    header.getContext(),
                                )}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody
                    style={{
                        transform: `translateY(${virtualController.startTop}px)`,
                    }}
                >
                    {virtualController.virtualItems.map((virtualItem, index) => {
                        const dataItem = virtualItem.dataItem;
                        const musicItem = dataItem.original;
                        return (
                            <tr key={`${musicItem.platform}-${musicItem.id}`}>
                                {dataItem.getAllCells().map((cell) => (
                                    <td
                                        key={cell.id}
                                        style={{
                                            width: cell.column.getSize(),
                                        }}
                                    >
                                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                                    </td>
                                ))}
                            </tr>
                        );
                    })}
                </tbody>
                <tfoot
                    style={{
                        height:
              virtualController.totalHeight -
              virtualController.virtualItems.length * estimizeItemHeight,
                    }}
                ></tfoot>
            </table>
        </div>
    );
}
