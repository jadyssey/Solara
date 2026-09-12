/**
 * Solara LRC 歌词解析引擎、时间轴平滑对齐与双端同步高亮
 */

import { API } from "../constants.js";

export function parseLyrics(lyricText, state) {
    const lines = lyricText.split('\n');
    const lyrics = [];

    lines.forEach(line => {
        const match = line.match(/\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/);
        if (match) {
            const minutes = parseInt(match[1]);
            const seconds = parseInt(match[2]);
            const milliseconds = parseInt(match[3].padEnd(3, '0'));
            const time = minutes * 60 + seconds + milliseconds / 1000;
            const text = match[4].trim();

            if (text) {
                lyrics.push({ time, text });
            }
        }
    });

    state.lyricsData = lyrics.sort((a, b) => a.time - b.time);
}

export function setLyricsContentHtml(html, dom) {
    if (dom.lyricsContent) {
        dom.lyricsContent.innerHTML = html;
    }
    if (dom.mobileInlineLyricsContent) {
        dom.mobileInlineLyricsContent.innerHTML = html;
    }
}

export function clearLyricsContent(state, dom, isMobileView = false, closeMobileInlineLyrics = null) {
    setLyricsContentHtml("", dom);
    state.lyricsData = [];
    state.currentLyricLine = -1;
    if (isMobileView && typeof closeMobileInlineLyrics === "function") {
        closeMobileInlineLyrics({ force: true });
    }
}

export function clearLyricsIfLibraryEmpty(state, dom, isMobileView = false, closeMobileInlineLyrics = null) {
    const playlistEmpty = !Array.isArray(state.playlistSongs) || state.playlistSongs.length === 0;
    const favoritesEmpty = !Array.isArray(state.favoriteSongs) || state.favoriteSongs.length === 0;
    if (!playlistEmpty || !favoritesEmpty) {
        return;
    }

    const player = dom.audioPlayer;
    const hasActiveAudio = Boolean(player && player.src && !player.ended && !player.paused);
    if (hasActiveAudio) {
        return;
    }

    clearLyricsContent(state, dom, isMobileView, closeMobileInlineLyrics);
    if (dom.lyrics) {
        dom.lyrics.classList.add("empty");
        dom.lyrics.dataset.placeholder = "default";
    }
}

/**
 * 读取歌词行的布局高度（未受 transform 缩放影响）。
 * offsetHeight 在 flex 列布局中逐行稳定，不随高亮过渡而变化，适合作为居中锚点。
 */
function measureLyricLineHeight(element) {
    if (!element) return 0;

    // offsetHeight 为布局高度（不受 transform 影响），在 flex 列布局中逐行稳定
    const layoutHeight = element.offsetHeight;
    if (layoutHeight > 0) {
        return layoutHeight;
    }

    const rectHeight = element.getBoundingClientRect?.().height;
    return Number.isFinite(rectHeight) && rectHeight > 0 ? rectHeight : 0;
}

/**
 * 计算元素相对滚动容器内容区的偏移量（不受 transform / 滚动位置影响）。
 * 优先沿 offsetParent 链累加 offsetTop；若结构异常则退回 rect 计算。
 */
function resolveOffsetTopWithin(element, container) {
    let node = element;
    let top = 0;
    let guard = 0;

    while (node && node !== container && guard < 50) {
        top += node.offsetTop || 0;
        node = node.offsetParent;
        guard += 1;
    }

    if (node === container) {
        return top;
    }

    // 兜底：offsetParent 链未能抵达容器时，用 rect 差值换算
    const elementRect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return elementRect.top - containerRect.top + container.scrollTop;
}

/**
 * 计算目标行的「稳定态」顶部偏移（相对滚动容器内容区）。
 *
 * 关键点：切换高亮时，上一行会从高亮高度收缩回普通高度（可能少 40px 以上），
 * 这个收缩又带着 0.35s 过渡，因此在加上 .current 的瞬间直接读 offsetTop，
 * 拿到的仍是「上一行还没收缩」的旧布局，会比稳定态偏下几十像素；
 * 若此时就滚过去，等过渡结束后目标行会「再往下走一点点」，产生可见抖动。
 *
 * 实现方式：不改动真实 DOM 的过渡状态，而是临时关闭容器内所有歌词行的
 * 尺寸过渡，让浏览器立刻按「稳定态」完成布局，量取目标行的 offsetTop 后再恢复。
 * 由于整个过程在同一帧内同步完成，用户不会看到中间态，也不会产生额外重排闪烁。
 *
 * 这样既能拿到精确的稳定态位置，又只滚动一次，从根上消除二次校正带来的抖动。
 */
function resolveStableOffsetTop(element, container) {
    if (!container || !element?.parentNode || typeof window === "undefined") {
        return resolveOffsetTopWithin(element, container);
    }

    const lines = Array.from(container.querySelectorAll("div[data-time]"));
    if (lines.length === 0) {
        return resolveOffsetTopWithin(element, container);
    }

    // 1. 同步关闭过渡，使布局立即到达稳定态
    const savedTransitions = lines.map((node) => node.style.transition);
    for (const node of lines) {
        node.style.transition = "none";
    }

    let stableOffsetTop;
    try {
        // 读取 offsetTop 会强制同步重排，拿到的是过渡关闭后的稳定布局
        stableOffsetTop = resolveOffsetTopWithin(element, container);
    } finally {
        // 2. 立刻恢复原有过渡声明，避免影响后续高亮动画
        lines.forEach((node, index) => {
            node.style.transition = savedTransitions[index];
        });
    }

    return Number.isFinite(stableOffsetTop)
        ? stableOffsetTop
        : resolveOffsetTopWithin(element, container);
}

/**
 * 计算歌词行在「焦点高亮稳定态」下的布局高度。
 *
 * .current 会放大字号与内边距（并带 0.35s 过渡），放大后文本可能由一行折成两行，
 * 因此不能依赖过渡中途的 rect / computed style。
 * 这里通过克隆一个离屏节点并强制应用高亮尺寸来直接测量最终行高，
 * 既覆盖单行也覆盖折行场景，且不产生任何可见副作用。
 */
function measureHighlightedHeight(element, fallbackHeight) {
    if (!element || typeof window === "undefined" || !element.cloneNode) {
        return fallbackHeight;
    }

    try {
        const probe = element.cloneNode(true);
        probe.classList.add("current");
        // 离屏但参与布局，确保换行行为与真实容器一致
        probe.style.position = "absolute";
        probe.style.visibility = "hidden";
        probe.style.pointerEvents = "none";
        probe.style.left = "-10000px";
        probe.style.top = "0";
        probe.style.width = `${element.clientWidth}px`;
        probe.style.boxSizing = "border-box";

        element.parentNode.appendChild(probe);
        // offsetHeight 不受 transform 缩放影响，正是布局高度
        const height = probe.offsetHeight;
        probe.remove();

        if (Number.isFinite(height) && height > 0) {
            return height;
        }
    } catch (error) {
        // 忽略探测失败，退回布局高度
    }

    return fallbackHeight;
}

/**
 * 计算目标「视觉焦点线」的视口 Y 坐标。
 *
 * 移动端歌词实际可读区域 = 歌词滚动容器顶部 ~ 歌曲信息/播放器模块顶部，
 * 该区域的几何中心才是真正的视觉中心。
 *
 * 注意：不能直接用整个视口中心（innerHeight / 2）或 innerHeight * 0.48，
 * 因为下方还压着歌曲信息与播放器控制台，会让焦点线偏低数十像素，
 * 导致高亮行看起来“整体偏下”。
 *
 * 桌面端歌词面板自带内边距且不与其他模块重叠，仍以容器自身中心为准。
 */
function resolveFocusLine(container, containerRect, focalRatio, isMobile) {
    if (!isMobile) {
        return containerRect.top + containerRect.height * focalRatio;
    }

    // 歌词可读区域上边界：滚动容器顶部（其上方为 Toolbar 与歌词 Header）
    const bandTop = containerRect.top;
    // 下边界：紧随其后的歌曲信息 / 播放器模块顶部，取二者中更靠上者
    const bandBottom = resolveLyricsBandBottom(container, containerRect);
    const usableBottom = Math.max(bandBottom, bandTop + 1);
    const usableHeight = usableBottom - bandTop;

    // 可用区域内按比例取焦点线（0.5 = 正中心）
    return bandTop + usableHeight * focalRatio;
}

/**
 * 找出歌词可读区域的下边界（视口 Y 坐标）。
 * 优先取歌曲信息块顶部；若其不可见，则退回播放器控制台顶部或容器自身底部。
 */
function resolveLyricsBandBottom(container, containerRect) {
    const root = container?.ownerDocument || (typeof document !== "undefined" ? document : null);
    if (!root) return containerRect.bottom;

    const candidates = [];
    const pushIfVisibleTop = (el) => {
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (rect.height <= 0 || rect.width <= 0) return;
        // 只接受位于容器下沿附近的模块，避免误取页面上方元素
        if (rect.top >= containerRect.top) {
            candidates.push(rect.top);
        }
    };

    pushIfVisibleTop(root.querySelector(".current-song-info"));
    pushIfVisibleTop(root.querySelector(".controls"));
    pushIfVisibleTop(root.querySelector(".mobile-panel"));

    if (candidates.length > 0) {
        return Math.min(...candidates);
    }

    return containerRect.bottom;
}

export function scrollToCurrentLyric(element, containerOverride, dom, smooth = true) {
    const container = containerOverride || dom?.lyricsScroll || dom?.lyrics;
    if (!container || !element) {
        return;
    }
    const containerHeight = container.clientHeight;
    if (containerHeight <= 0) {
        return;
    }

    const containerRect = container.getBoundingClientRect();
    const isMobile = container.id === "mobileInlineLyricsScroll" || container.classList?.contains("mobile-inline-lyrics__scroll");
    // 视觉焦点比例：0.5 = 可用区域正中心。
    // 移动端会先求出「歌词可读区域」（容器顶部 ~ 歌曲信息/播放器顶部）再按该比例定位，
    // 因此这里统一使用 0.5，保证高亮行落在真正可见区域的正中央。
    const focalRatio = 0.5;

    // 以「行的稳定态布局盒」为锚点：同时抵消上一行收缩带来的位移，
    // 保证在过渡进行中也能一次算出最终位置，避免二次校正造成的抖动。
    const elementOffsetTop = resolveStableOffsetTop(element, container);
    const elementHeight = measureLyricLineHeight(element);

    // 目标视觉焦点线（视口坐标系）
    const focusLineInViewport = resolveFocusLine(container, containerRect, focalRatio, isMobile);

    // 焦点行会因高亮样式（字号 / 内边距增大）在其布局盒内向下“长高”，
    // 使视觉中心比布局盒中心下移约一半增量；这里按稳定态高亮盒校正，保证高亮行真正对齐焦点线。
    const highlightHeight = measureHighlightedHeight(element, elementHeight);
    const elementCenterInContainer = elementOffsetTop + highlightHeight / 2;

    const elementCenterInViewport = elementCenterInContainer - container.scrollTop + containerRect.top;
    const targetScrollTop = container.scrollTop + (elementCenterInViewport - focusLineInViewport);
    const maxScrollTop = Math.max(0, container.scrollHeight - containerHeight);
    const finalScrollTop = Math.max(0, Math.min(targetScrollTop, maxScrollTop));

    if (Math.abs(container.scrollTop - finalScrollTop) > 1) {
        if (typeof window !== "undefined") {
            window.__solaraIsProgrammaticScrolling = true;
            if (window.__solaraProgrammaticTimer) {
                clearTimeout(window.__solaraProgrammaticTimer);
            }
            window.__solaraProgrammaticTimer = setTimeout(() => {
                window.__solaraIsProgrammaticScrolling = false;
            }, 600);
        }

        if (smooth && typeof container.scrollTo === "function") {
            container.scrollTo({
                top: finalScrollTop,
                behavior: 'smooth'
            });
        } else {
            container.scrollTop = finalScrollTop;
        }
    }
}

export function displayLyrics(state, dom) {
    const lyricsHtml = state.lyricsData.map((lyric, index) =>
        `<div data-time="${lyric.time}" data-index="${index}">${lyric.text}</div>`
    ).join("");
    setLyricsContentHtml(lyricsHtml, dom);
    if (dom.lyrics) {
        dom.lyrics.dataset.placeholder = "default";
    }
    if (state.isMobileInlineLyricsOpen) {
        syncLyrics(state, dom);
    }
}

export function syncLyrics(state, dom) {
    if (!state.lyricsData || state.lyricsData.length === 0) return;

    const currentTime = dom.audioPlayer ? dom.audioPlayer.currentTime : 0;
    let currentIndex = -1;

    for (let i = 0; i < state.lyricsData.length; i++) {
        if (currentTime >= state.lyricsData[i].time) {
            currentIndex = i;
        } else {
            break;
        }
    }

    if (currentIndex !== state.currentLyricLine) {
        state.currentLyricLine = currentIndex;

        const lyricTargets = [];
        if (dom.lyricsContent) {
            lyricTargets.push({
                elements: dom.lyricsContent.querySelectorAll("div[data-index]"),
                container: dom.lyricsScroll || dom.lyrics,
            });
        }
        if (dom.mobileInlineLyricsContent) {
            lyricTargets.push({
                elements: dom.mobileInlineLyricsContent.querySelectorAll("div[data-index]"),
                container: dom.mobileInlineLyricsScroll || dom.mobileInlineLyrics,
                inline: true,
            });
        }

        lyricTargets.forEach(({ elements, container, inline }) => {
            elements.forEach((element, index) => {
                if (index === currentIndex) {
                    element.classList.add("current");
                    const shouldScroll = !state.userScrolledLyrics && (!inline || state.isMobileInlineLyricsOpen);
                    if (shouldScroll) {
                        scrollToCurrentLyric(element, container, dom);
                    }
                } else {
                    element.classList.remove("current");
                }
            });
        });
    }
}

const lyricsMemoryCache = new Map();

export async function loadLyrics(song, state, dom, debugLogger = null) {
    const log = (msg) => {
        if (typeof debugLogger === "function") debugLogger(msg);
        else if (typeof window !== "undefined" && typeof window.__solaraDebugLog === "function") window.__solaraDebugLog(msg);
    };

    if (!song) return;
    const cacheKey = `${song.source || 'netease'}_${song.lyric_id || song.id}`;

    // 1. 优先命中前端内存缓存（0 网络请求）
    if (lyricsMemoryCache.has(cacheKey)) {
        const cachedLyric = lyricsMemoryCache.get(cacheKey);
        log(`[歌词缓存] 命中内存缓存，无需请求网络`);
        parseLyrics(cachedLyric, state);
        if (dom.lyrics) {
            dom.lyrics.classList.remove("empty");
            dom.lyrics.dataset.placeholder = "default";
        }
        displayLyrics(state, dom);
        return;
    }

    try {
        const lyricUrl = API.getLyric(song);
        log(`[歌词请求] 解析接口: ${lyricUrl}`);

        const lyricData = await API.fetchJson(lyricUrl);

        if (lyricData && lyricData.lyric) {
            lyricsMemoryCache.set(cacheKey, lyricData.lyric);
            parseLyrics(lyricData.lyric, state);
            if (dom.lyrics) {
                dom.lyrics.classList.remove("empty");
                dom.lyrics.dataset.placeholder = "default";
            }
            displayLyrics(state, dom);
            log(`[歌词解析] 加载成功，共 ${state.lyricsData.length} 行歌词`);
        } else {
            setLyricsContentHtml("<div>暂无歌词</div>", dom);
            if (dom.lyrics) {
                dom.lyrics.classList.add("empty");
                dom.lyrics.dataset.placeholder = "message";
            }
            state.lyricsData = [];
            state.currentLyricLine = -1;
            log("[歌词解析] 接口返回空，暂无歌词数据");
        }
    } catch (error) {
        console.error("加载歌词失败:", error);
        setLyricsContentHtml("<div>歌词加载失败</div>", dom);
        if (dom.lyrics) {
            dom.lyrics.classList.add("empty");
            dom.lyrics.dataset.placeholder = "message";
        }
        state.lyricsData = [];
        state.currentLyricLine = -1;
        log(`[歌词异常] 解析出错: ${error?.message || error}`);
    }
}

/**
 * 初始化电脑端歌词舞台交互（点词即播 Click-to-Seek 与滚轮防打扰）
 */
export function initDesktopLyricsInteractions(state, dom) {
    if (!dom.lyricsContent) return;

    // 1. 点词即播 (Click to Seek)
    dom.lyricsContent.addEventListener("click", (e) => {
        const line = e.target.closest("div[data-time]");
        if (!line) return;

        const time = parseFloat(line.getAttribute("data-time"));
        if (Number.isFinite(time) && dom.audioPlayer) {
            state.userScrolledLyrics = false;
            dom.audioPlayer.currentTime = time;
            if (dom.audioPlayer.paused) {
                dom.audioPlayer.play().catch(() => {});
            }
            syncLyrics(state, dom);
        }
    });

    // 2. 滚轮防打扰机制（用户手动翻看歌词时暂停自动居中跟随 5 秒，超时后主动复位）
    const scrollContainer = dom.lyricsScroll || dom.lyrics;
    if (scrollContainer) {
        scrollContainer.addEventListener("wheel", () => {
            state.userScrolledLyrics = true;
            if (state.lyricsScrollTimeout) {
                clearTimeout(state.lyricsScrollTimeout);
            }
            state.lyricsScrollTimeout = setTimeout(() => {
                state.userScrolledLyrics = false;
                const currentLyric = dom.lyricsContent?.querySelector(".current");
                if (currentLyric && (!dom.audioPlayer || !dom.audioPlayer.paused)) {
                    scrollToCurrentLyric(currentLyric, scrollContainer, dom, true);
                }
            }, 5000);
        }, { passive: true });
    }
}
