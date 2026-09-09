import Tag from "@/renderer/components/Tag";
import Checkbox from "@/renderer/components/Checkbox";
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
import { getMediaPrimaryKey } from "@/common/media-util";
import { createContext, useContext, useMemo, useState } from "react";

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
];

/** 行内操作列：管理模式下隐藏，改用顶部批量操作 */
const operationColumn = columnHelper.display({
    header: () => t("common.operation"),
    size: 140,
    minSize: 120,
    id: "operation",
    cell: (info) => <RowOperations musicItem={info.row.original} />,
});

/** 管理模式上下文：供工具栏与选择列共享选中态 */
interface IManageContext {
    managing: boolean;
    setManaging: (next: boolean) => void;
    list: IMusic.IMusicItem[];
    selected: Set<string>;
    selectedItems: IMusic.IMusicItem[];
    allChecked: boolean;
    toggleKey: (key: string) => void;
    toggleAll: () => void;
    clearSelection: () => void;
}

const ManageContext = createContext<IManageContext>(null!);

/** 选择列：管理模式下插到最前面 */
const selectColumn = columnHelper.display({
    header: () => <SelectAllCheckbox />,
    size: 36,
    minSize: 36,
    maxSize: 36,
    id: "select",
    cell: (info) => <RowCheckbox musicItem={info.row.original} />,
});

function RowCheckbox(props: { musicItem: IMusic.IMusicItem }) {
    const { selected, toggleKey } = useContext(ManageContext);
    const key = getMediaPrimaryKey(props.musicItem);
    return (
        <Checkbox
            checked={selected.has(key)}
            onChange={() => toggleKey(key)}
        ></Checkbox>
    );
}

function SelectAllCheckbox() {
    const { allChecked, toggleAll } = useContext(ManageContext);
    return <Checkbox checked={allChecked} onChange={toggleAll}></Checkbox>;
}

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

/** 顶栏：管理模式（全选/暂停/重试/删除/退出）或普通模式（批量操作 + 管理入口） */
function DownloadingToolbar() {
    const { t: t2 } = useTranslation();
    const summary = Downloader.useDownloadSummary();
    const {
        managing,
        setManaging,
        list,
        selected,
        selectedItems,
        allChecked,
        toggleAll,
        clearSelection,
    } = useContext(ManageContext);

    const pauseSelected = () => {
        selectedItems.forEach((it) => Downloader.pauseMusic(it));
    };

    const retrySelected = () => {
        selectedItems.forEach((it) => Downloader.resumeMusic(it));
    };

    const removeSelected = () => {
        if (selectedItems.length === 0) {
            return;
        }
        const ok = window.confirm(
            t2("download_page.confirm_delete", { count: selectedItems.length }),
        );
        if (!ok) {
            return;
        }
        selectedItems.forEach((it) => Downloader.cancelTask(it));
        clearSelection();
    };

    if (managing) {
        const count = selectedItems.length;
        return (
            <div className="downloading-toolbar">
                <span className="downloading-toolbar-left">
                    <Checkbox checked={allChecked} onChange={toggleAll}></Checkbox>
                    <span className="downloading-toolbar-text">
                        {t2("common.select_all")}（{selected.size}/{list.length}）
                    </span>
                </span>
                <button
                    className="downloading-op-btn"
                    disabled={count === 0}
                    onClick={pauseSelected}
                >
                    {t2("download_page.pause")}
                    {count > 0 ? ` (${count})` : ""}
                </button>
                <button
                    className="downloading-op-btn"
                    disabled={count === 0}
                    onClick={retrySelected}
                >
                    {t2("download_page.retry")}
                    {count > 0 ? ` (${count})` : ""}
                </button>
                <button
                    className="downloading-op-btn downloading-op-btn--danger"
                    disabled={count === 0}
                    onClick={removeSelected}
                >
                    {t2("common.delete")}
                    {count > 0 ? ` (${count})` : ""}
                </button>
                <button
                    className="downloading-op-btn"
                    onClick={() => setManaging(false)}
                >
                    {t2("download_page.exit_manage")}
                </button>
            </div>
        );
    }

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
                className="downloading-op-btn"
                disabled={summary.error === 0}
                onClick={() => Downloader.retryFailedTasks()}
            >
                {t2("download_page.retry_all")}
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
            <button
                className="downloading-op-btn"
                disabled={summary.total === 0}
                onClick={() => setManaging(true)}
            >
                {t2("download_page.manage")}
            </button>
        </div>
    );
}

export default function Downloading() {
    const downloadingQueue = Downloader.useDownloadingMusicList();

    const [managing, setManaging] = useState(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());

    const manageCtx = useMemo<IManageContext>(() => {
        const selectedItems = downloadingQueue.filter((it) =>
            selected.has(getMediaPrimaryKey(it)),
        );
        return {
            managing,
            setManaging: (next: boolean) => {
                setManaging(next);
                if (!next) {
                    setSelected(new Set());
                }
            },
            list: downloadingQueue,
            selected,
            selectedItems,
            allChecked:
                downloadingQueue.length > 0 &&
                selected.size === downloadingQueue.length,
            toggleKey: (key: string) => {
                setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(key)) {
                        next.delete(key);
                    } else {
                        next.add(key);
                    }
                    return next;
                });
            },
            toggleAll: () => {
                setSelected((prev) =>
                    prev.size === downloadingQueue.length
                        ? new Set()
                        : new Set(
                            downloadingQueue.map((it) => getMediaPrimaryKey(it)),
                        ),
                );
            },
            clearSelection: () => setSelected(new Set()),
        };
    }, [managing, selected, downloadingQueue]);

    const columns = useMemo(
        () =>
            managing
                ? [selectColumn, ...columnDef]
                : [...columnDef, operationColumn],
        [managing],
    );

    const table = useReactTable({
        debugAll: false,
        data: downloadingQueue,
        columns,
        getCoreRowModel: getCoreRowModel(),
    });

    const virtualController = useVirtualList({
        data: table.getRowModel().rows,
        scrollElementQuery: "#page-container",
        estimateItemHeight: estimizeItemHeight,
    });

    return (
        <ManageContext.Provider value={manageCtx}>
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
                                        width:
                                            header.id === "extra"
                                                ? undefined
                                                : header.getSize(),
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
                            const pk = getMediaPrimaryKey(musicItem);
                            const rowSelected = managing && selected.has(pk);
                            return (
                                <tr
                                    key={`${musicItem.platform}-${musicItem.id}`}
                                    className={rowSelected ? "selected" : ""}
                                    onClick={
                                        managing
                                            ? () => manageCtx.toggleKey(pk)
                                            : undefined
                                    }
                                >
                                    {dataItem.getAllCells().map((cell) => (
                                        <td
                                            key={cell.id}
                                            style={{
                                                width: cell.column.getSize(),
                                            }}
                                        >
                                            {flexRender(
                                                cell.column.columnDef.cell,
                                                cell.getContext(),
                                            )}
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
                                virtualController.virtualItems.length *
                                    estimizeItemHeight,
                        }}
                    ></tfoot>
                </table>
            </div>
        </ManageContext.Provider>
    );
}
