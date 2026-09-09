import MusicList from "@/renderer/components/MusicList";
import Checkbox from "@/renderer/components/Checkbox";
import Downloader from "@/renderer/core/downloader";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getMediaPrimaryKey } from "@/common/media-util";
import Tag from "@/renderer/components/Tag";

export default function Downloaded() {
    const downloadedList = Downloader.useDownloadedMusicList();
    const musicListContainerRef = useRef<HTMLDivElement>();
    const { t } = useTranslation();

    const [managing, setManaging] = useState(false);
    const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());

    const toggleManage = (next: boolean) => {
        setManaging(next);
        if (!next) {
            setSelectedKeys(new Set());
        }
    };

    const selectedItems = downloadedList.filter((it) =>
        selectedKeys.has(getMediaPrimaryKey(it)),
    );

    const toggleSelect = (key: string) => {
        setSelectedKeys((prev) => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            return next;
        });
    };

    const allChecked =
        downloadedList.length > 0 && selectedKeys.size === downloadedList.length;

    const toggleSelectAll = () => {
        if (allChecked) {
            setSelectedKeys(new Set());
        } else {
            setSelectedKeys(
                new Set(downloadedList.map((it) => getMediaPrimaryKey(it))),
            );
        }
    };

    const removeSelected = async () => {
        if (selectedItems.length === 0) {
            return;
        }
        const ok = window.confirm(
            t("download_page.confirm_delete", { count: selectedItems.length }),
        );
        if (!ok) {
            return;
        }
        await Downloader.removeDownloadedMusic(selectedItems, true);
        setSelectedKeys(new Set());
    };

    return (
        <div className="downloaded-container">
            <div className="downloaded-header">
                {managing ? (
                    <>
                        <span className="downloaded-header-left">
                            <Checkbox
                                checked={allChecked}
                                onChange={toggleSelectAll}
                            ></Checkbox>
                            <span className="downloaded-header-text">
                                {t("common.select_all")}（{selectedKeys.size}/
                                {downloadedList.length}）
                            </span>
                        </span>
                        <span className="downloaded-header-right">
                            <button
                                className="downloading-op-btn downloading-op-btn--danger"
                                disabled={selectedItems.length === 0}
                                onClick={removeSelected}
                            >
                                {t("common.delete")}
                                {selectedItems.length > 0
                                    ? ` (${selectedItems.length})`
                                    : ""}
                            </button>
                            <button
                                className="downloading-op-btn"
                                onClick={() => toggleManage(false)}
                            >
                                {t("download_page.exit_manage")}
                            </button>
                        </span>
                    </>
                ) : (
                    <>
                        <span className="downloaded-header-right">
                            <button
                                className="downloading-op-btn"
                                disabled={downloadedList.length === 0}
                                onClick={() => toggleManage(true)}
                            >
                                {t("download_page.manage")}
                            </button>
                        </span>
                    </>
                )}
            </div>

            {managing ? (
                <div className="downloaded-manage-list">
                    {downloadedList.length === 0 ? (
                        <div className="downloaded-manage-empty">
                            {t("common.empty")}
                        </div>
                    ) : (
                        downloadedList.map((it) => {
                            const key = getMediaPrimaryKey(it);
                            return (
                                <div
                                    key={key}
                                    className={`downloaded-manage-row${
                                        selectedKeys.has(key) ? " selected" : ""
                                    }`}
                                    onClick={() => toggleSelect(key)}
                                >
                                    <Checkbox checked={selectedKeys.has(key)}></Checkbox>
                                    <span
                                        className="downloaded-manage-title"
                                        title={it.title}
                                    >
                                        {it.title}
                                    </span>
                                    <span className="downloaded-manage-artist" title={it.artist}>
                                        {it.artist}
                                    </span>
                                    <span className="downloaded-manage-album" title={it.album}>
                                        {it.album}
                                    </span>
                                    <Tag fill>{it.platform}</Tag>
                                </div>
                            );
                        })
                    )}
                </div>
            ) : (
                <div ref={musicListContainerRef}>
                    <MusicList
                        musicList={downloadedList}
                        virtualProps={{
                            getScrollElement() {
                                return document.querySelector("#page-container");
                            },
                            offsetHeight: () =>
                                musicListContainerRef.current.offsetTop,
                        }}
                    ></MusicList>
                </div>
            )}
        </div>
    );
}
